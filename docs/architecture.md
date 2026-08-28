# Architecture

> Scope: current architecture of **v0.1.0-alpha.1**.
> [`README.md`](../README.md) is the project overview; [`README.zh-CN.md`](../README.zh-CN.md) is its Chinese counterpart. [`development-history.md`](development-history.md) holds the historical implementation notes that predate the public-polish pass.

---

## Design Model

The project is built on a fixed responsibility split that gives every turn an explicit owner.

- **ChatGPT** — planner, reviewer, and control-decision maker. It reads the goal, issues an instruction, evaluates the returned evidence, and decides the next control.
- **Codex** — local executor. It runs one instructed task, modifies files, runs commands/tests, and returns an actual result plus evidence. It does not independently re-plan the overall goal.
- **Human** — product owner. The loop pauses at `ASK_USER` and waits for a human decision.

Why this separation matters:

- Explicit ownership of *planning* vs *execution* keeps each step reviewable.
- Each task is a bounded, discrete unit with its own acceptance criteria.
- Orchestration state makes the loop durable across turns and recoverable runtimes.
- The executor (Codex) reports real evidence, so the reviewer (ChatGPT) decides on facts rather than assumptions.

## System Architecture

```mermaid
flowchart TD
    H[Human / product owner] --> BRAIN[ChatGPT Brain]
    BRAIN <--> BS[BrainSession / IAB transport]
    BS <--> CTX[Brain Context / PacketContextProvider]
    CTX <--> PROTO[Structured Protocol / Acceptance-Evidence Gate]
    PROTO <--> TM[TaskService / TaskManager / durable Task State]
    TM <--> RH[Runtime Host]
    RH <--> CX[Persistent Codex worker / thread]
    CX --> REPO[Target repository]
```

The orchestrator lives between the ChatGPT Brain and the Codex executor. It does **not** add a remote runtime or any unsupported external service in this alpha.

## Control Protocol

The Brain ↔ executor contract uses four directives, implemented in [`src/directives.js`](../src/directives.js) and normalized in [`src/protocol.js`](../src/protocol.js):

- `TASK` — a new instruction for Codex to execute.
- `REVISE` — rework the previous task.
- `ASK_USER` — a human decision is required; the loop pauses.
- `DONE` — the task is complete.

`parseControl(text)` detects the control; `extractDirective(text, control)` pulls the instruction after the token. `normalizeBrainOutput` / `parseBrainOutput` parse structured JSON control/reply when present, with a single auto-repair and a legacy text fallback. `validateControl` rejects anything outside `CONTROLS = ['TASK','REVISE','ASK_USER','DONE']`, throwing `ProtocolError` when invalid.

The exported `CONTROLS`, `RESULT_STATUSES`, and result helpers live in [`src/protocol.js`](../src/protocol.js).

## Task Lifecycle

The lifecycle is owned by [`TaskService`](../src/task-service.js) over a durable store backed by [`TaskManager`](../src/task-manager.js) and [`task-state`](../src/task-state.js).

- `startTask({ goal, repoDir, conversation })` creates state and drives the loop (up to `maxRounds`).
- `createTask(...)` creates a task **without** running the engine; the host then calls `advanceTask(taskId)` repeatedly.
- `advanceTask(taskId, { brain, executor, sessionFactory })` is the **turn-sliced** drive: it loads durable state, performs **one** bounded unit (a single Brain send, a single Codex exec, or a state transition), persists, and returns a compact status. Each unit stays well under a node-REPL invocation time cap.
- `resumeTask(taskId)` reloads state, re-acquires the lock, re-attaches the Brain and worker, and continues.
- `getTaskStatus` / `cancelTask` are read / terminal operations.

Every mutation is persisted; completed steps are never re-run.

### State model

On-disk as `<stateDir>/<taskId>.json` with a `.bak` fallback. Schema version is `1`

- Task statuses: `running | awaiting_user | recovery_required | completed | failed | cancelled`
- Step statuses: `received | executing | executed | result_recorded | result_sent | reviewed`
- Acceptance statuses: `pass | fail | unknown | missing`

`loadState` refuses to silently reset: if both the primary file and its backup are corrupt it throws `TaskStateCorruptError`.

## Acceptance and Evidence Gate

[`src/protocol.js`](../src/protocol.js) models acceptance as structured data:

- `acceptance[]` — the criteria ChatGPT attaches to a `TASK`.
- `evidence[]` — the items Codex returns, each `{ acceptanceId, status: pass|fail|unknown, kind, summary }`.
- Evidence kinds: `command | test | file | diff | verify`.

`checkAcceptanceGate(registry)` requires **every required** acceptance to have `pass` evidence before `DONE` is accepted. The engine never marks an acceptance `pass` merely because the Codex process exited `0`; evidence must come from the returned result (`evidence[]` or an `EVIDENCE:` block) or explicit test results. `normalizeEvidence` accepts `passed/failed` aliases; `parseEvidenceBlock` handles JSON arrays.

This is a review gate, **not** formal verification, cryptographic attestation, or an automatic correctness proof.

## Persistence and Recovery

What exists:

- Durable Task State (schema v1) written atomically (temp + rename) with a retained `.bak`.
- `resumeTask` re-attaches the same conversation, tab (or re-bound conversation), and Codex thread/session.
- `recovery_required` marks a task whose in-flight step hit an unconfirmed side-effect; resume does **not** auto re-run it.
- Crash-safe `TaskLock` writes an owner token + pid + heartbeat. On contention it checks liveness/staleness: an active owner is rejected (`TaskLockedError`), and a dead/stale lock is reclaimed.
- A persistent Codex worker/thread is kept in-process by the worker host so a task re-uses the same thread.

What does **not** yet exist:

- Cross-process automatic recovery beyond explicit `resume`/`advanceTask`.
- A concurrent task queue.
- A cost ledger.

Tasks are not claimed to be impossible to lose; recovery is explicit, not automatic.

## Conversation Binding

- `conversation: 'new'` — the supported/default path. It creates a fresh ChatGPT conversation and a persistent Codex thread.
- `conversation: 'current'` / `adopt-current` — **experimental**. For `'current'`, `createTask` freezes the real conversation identity at creation time and marks the task as `adopted`; teardown does not close the adopted user tab by default. The identity-binding resolver (`reopenConversationFromBinding`, `openBrainSessionExisting`) and `ConversationIdentityMismatchError` are present.
- Why `adopt-current` is experimental in alpha.1: selected-tab identity is unstable across node-REPL invocations in the current Codex Desktop / IAB environment. The implementation is retained, but it is not a stability promise.

## Context and Secret Handling

[`PacketContextProvider`](../src/context-provider.js) builds a bounded repository context (repo map, git status/diff, file snippets, test results/errors), skipping `.env` / secrets / `node_modules`, and records provenance. It never dumps the whole repo.

[`src/safety.js`](../src/safety.js) provides `redactSecrets` (removes known secret strings and secret-looking patterns such as `sk-…` and `Bearer …`) and `redactObject` (recursively masks secret-named keys). Structured `TaskLog` is JSONL and size-capped.

Known limitation: the local governor currently passes its bearer token on the Codex child **argv**. It is redacted from logs/state, **not** removed from the process argv.

## Runtime and Process Boundaries

The Codex worker must run in an ordinary Node process, because the node-REPL sandbox cannot spawn a descendant `codex` (writing `~/.codex/tmp/arg0` / the in-process app-server client is denied and the restriction propagates to the descendant tree).

- BrainSession / in-app browser runs in the node REPL (`browser-client` needs the REPL RPC).
- The worker host (`scripts/codex-worker-host.mjs`) is a long-lived normal Node process exposing a **localhost TCP JSON-line** server; each worker has a random token, and requests must carry `auth` + a bound `taskId` (`verifyAuth`).
- `scripts/runtime-host.mjs` is a single entry that connects the worker, opens a BrainSession, runs `LoopController`, and returns evidence.
- `redirectCodexHome()` is a best-effort helper that points `CODEX_HOME` at a fresh writable temp dir with copied config/auth, used because the REPL-sandbox descendant cannot write the read-only `~/.codex`. A dangerous sandbox bypass (`--dangerously-bypass-approvals-and-sandbox`) is detected and reported, never a default.

## Data Root

[`runtime-paths`](../src/runtime-paths.js) exposes the default data root; [`data-root`](../src/data-root.js) resolves a durable writable root via, in order, an explicit path, `CHATGPT_ORCHESTRATOR_DATA_ROOT`, the user root, then workspace candidates (`probeWritable`). If none are writable it returns an error requiring a durable writable dir.

Limitation: the default `%LOCALAPPDATA%` root may not be writable from the sandbox; the alpha entry must supply a writable root via the resolver or `CHATGPT_ORCHESTRATOR_DATA_ROOT`.

## Failure Classes

Named errors that the orchestrator surfaces:

- `ComposerTimeoutError`, `ReplyTimeoutError`, `ConversationMismatchError`, `TabLostError` (Brain transport).
- `ProtocolError` (invalid control after repair).
- `TaskStateCorruptError` (primary + backup corrupt; no silent reset).
- `TaskLockedError` (active owner holds the task lock).

On an unconfirmed in-flight step, the task transitions to `recovery_required` rather than auto re-running.

## Supported vs Experimental (boundary)

- Supported/default: `conversation: 'new'`, the full `TASK / REVISE / ASK_USER / DONE` loop, structured acceptance/evidence gate, durable task state + turn-sliced advancement, persistent Codex thread, resume/recovery, crash-safe lock, project binding, `PacketContextProvider`, doctor diagnostics, safe defaults.
- Experimental: `conversation: 'current'` and `adopt-current`.

## Current Non-goals / Limitations

- No cross-process automatic recovery beyond explicit resume/advance.
- No concurrent task queue.
- No cost ledger.
- Depends on the ChatGPT web DOM; selectors/placeholders may require maintenance.
- No remote / Cloudflare runtime yet.

These are current boundaries, not roadmap commitments. Roadmap items (stabilizing `adopt-current` via explicit `tabId`, remote runtime, cost ledger, richer context providers, GUI-free daily entry) are **planned** and not part of the current architecture.

## Related Documentation

- [README](../README.md)
- [README.zh-CN](../README.zh-CN.md)
- [SKILL](../SKILL.md)
- [CHANGELOG](../CHANGELOG.md)
- [Development History](development-history.md)
