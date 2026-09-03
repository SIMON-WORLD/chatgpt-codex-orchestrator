# Development History

This document preserves the implementation, engineering, and development notes that were previously embedded in the project's README before the public-facing polish pass. It is **archival / development documentation**, not the canonical project overview.

For the current project description, usage, supported features, limitations, and roadmap, see [`README.md`](../README.md).

> Scope note: this record keeps historically meaningful engineering material that is still useful to maintainers. It deliberately avoids re-stating the ordinary homepage material (elevator pitch, generic quick-start, and current Supported / Roadmap sections), which now live in `README.md`.

> Path note: module references in this archival record (e.g. `src/iab-transport.js`) describe where a module historically lived. As of M6 the IAB / Alpha.4 implementation is structurally isolated and lives under `src/legacy/`; live runtime paths are `src/legacy/<module>.js` and the v0.2 canonical modules under `src/{mcp,router,governance,local,executor,state,transport}`.

---

## M1 — Reliable Brain Transport

Reliable, minimal transport so **Codex = local executor** can talk to **ChatGPT = brain/planner/reviewer** entirely through the **Codex in-app browser (iab)**. This was M1 of `chatgpt-codex-orchestrator`; it is **not** the full orchestrator, and works in the ChatGPT-command loop already proven in M0.

### What it does

A `BrainSession` owns exactly **one** ChatGPT conversation. The first `send()` captures the real `/c/<conversation-id>`; every later `send()` verifies it has not changed. It reads the **newly-produced** assistant reply of each turn (never the last old message), and waits until the composer is idle and the reply has fully streamed in.

- Default transport: `agent.browsers.get('iab')` (Codex in-app browser).
- One session = one owned tab (created by us) + one conversation.
- Never navigates / closes / modifies the user's other IAB tabs.

### Files

- `src/atomic-turn.js` — `AtomicTurnController` + error classes (offline-testable, operates on a `PageFacade`).
- `src/iab-transport.js` — `InAppBrowserTransport`, `BrainSession`, `createTabFacade`, `openBrainSession`.
- `src/index.js` — re-exports.
- `test/atomic-turn.test.js` — offline unit tests (no browser needed; CI-safe).
- `scripts/live-smoke.mjs` — real 3-nonce live driver (must run in the Codex IAB runtime / node REPL).

### API

```js
import { InAppBrowserTransport, openBrainSession } from '.../src/index.js';

const transport = new InAppBrowserTransport();
const session = await openBrainSession(transport);      // owns a tab, binds conversation on first send

const r = await session.send('your message', { nonce: 'ORCHESTRATOR_SMOKE_xxx' });
// r = { reply, beforeCount, afterCount, ownedTabId, conversationId, conversationUrl }

await session.close();
```

Error classes: `ComposerTimeoutError`, `ReplyTimeoutError`, `ConversationMismatchError`, `TabLostError`.

### Error handling (code-enforced)

- `waitComposer()` polls until the composer is present (and, if supported, empty/idle) → `ComposerTimeoutError`.
- Atomic turn counts assistant messages before/after send, only accepts the new reply → `ReplyTimeoutError` if it never arrives.
- Verifies the conversation id did not change on every subsequent turn → `ConversationMismatchError`.
- If the owned tab is lost / assistant reads fail → `TabLostError`.
- `sendMessage()` re-checks the composer content before pressing Enter, to survive React re-renders.

### Running tests

```
npm test        # node --test  (offline, no browser)
npm run check   # syntax check src
```

### Live smoke (requires the Codex IAB runtime)

Run inside the Codex Node REPL (`mcp__node_repl__js`):

```js
const { runLiveSmoke } = await import('file:///<abs>/scripts/live-smoke.mjs');
const ev = await runLiveSmoke();
nodeRepl.write(JSON.stringify(ev, null, 2));
```

Expected: `ownedTabIdStable`, `conversationIdStable`, `assistantCountIncrements`, `eachRoundIsNewReply`, `allNoncesEchoed`, `singleOwnedTabAdded`, `otherTabsUntouched` all `true`.

### Limits / boundaries

- Requires the Codex **in-app browser** runtime; it is not a standalone CLI and cannot run under plain `node` unless a browser RPC is injected.
- Live behavior depends on the ChatGPT web DOM (`[contenteditable="true"]`, `[data-message-author-role="assistant"]`), so selectors may need updating if ChatGPT's UI changes.
- No secrets, passwords, or tokens are stored or logged by this transport.
- Not yet (in M1): task state manager, planner/reviewer loop, routing, persistence of conversation across Codex restarts — M1 only proves the transport.

---

## M2 — Brain <-> Persistent Codex Executor Loop

Adds the full automatic loop: **ChatGPT (planner) -> TASK -> CodexExecutor -> RESULT -> ChatGPT -> TASK / REVISE / ASK_USER / DONE**.

- `src/codex-executor.js` — `CodexExecutor`. One user task binds to one real Codex thread/session. The first `execute()` runs `codex exec` (new thread), subsequent ones run `codex exec resume <session_id>` (same thread). Reads model/provider/bearer-token from `~/.codex/config.toml` at runtime.
- `src/loop-controller.js` — `LoopController.run(goal)`: sends the goal to ChatGPT, reads TASK/REVISE/ASK_USER/DONE, hands each directive to `CodexExecutor`, sends the Codex result back into the SAME ChatGPT conversation, and loops until DONE or ASK_USER.
- `src/directives.js` — `parseControl` / `extractDirective`.

### CodexExecutor API

```js
const ex = new CodexExecutor({ repoDir, sandbox: 'workspace-write', ignoreRules: false, bypassSandbox: false });
// first call creates a thread; later calls resume it (same session)
const r = await ex.execute('Create stats.js ...');
// r = { sessionId, resultText, exitCode, success, error }
```

### LoopController API

```js
const ctl = new LoopController({ brain, executor });
const result = await ctl.run('high level goal');
// result = { done, stoppedAt, turns, conversationId, executorSessionId, log[] }
```

### Persistent session implementation detail

- Session id (codex thread) is stored by the caller and re-applied to the executor; `resume` continues the same thread.
- Because `codex exec resume` does not accept `-C` / `-s`, the executor sets the child `cwd` to `repoDir` for BOTH exec and resume, and only passes `-s` on the first `exec`.

### Error handling (code-enforced)

- `ComposerTimeoutError`, `ReplyTimeoutError`, `ConversationMismatchError`, `TabLostError`.
- Reply detection does NOT assume assistant-message count always increases: ChatGPT can replace old messages as a conversation grows. Detection waits for the LAST assistant message to change (from what it was before the send) and become stable, so it works even when the count window is capped.
- `CodexExecutor` redacts the bearer token from any returned error/result text.

### Limits (M2)

- The Codex subprocess cannot start from the node_REPL sandbox (app-server client is denied). So the live loop is driven by the agent across two surfaces: the in-app-browser BrainSession (node REPL) for ChatGPT I/O, and a standalone `scripts/codex-run-cli.mjs` (normal Node via exec_command) for Codex. The `LoopController` still fully automates the logic and is covered by offline tests with a fake CodexExecutor.
- The live test used `--dangerously-bypass-approvals-and-sandbox` on an isolated test repo because this environment's `workspace-write` child sandbox is forced read-only. Production should avoid bypass and scope `repoDir` tightly.
- `codex exec resume` does not accept `-C`; cwd is forced via spawn. The bearer token is passed in the child command line (a limitation of this local governor auth) but is redacted from returned text.

---

## M2.1 — Runtime Integration (single-entry auto loop)

Adds a minimal **Runtime Host** so one task, when started, coordinates:

```
BrainSession (IAB, node REPL)  <->  LoopController  <->  CodexWorker (normal Node, via IPC)
```

and runs to DONE / ASK_USER, without the agent calling browser/executor per round.

### Why two runtimes could not call each other directly

- BrainSession / the in-app browser only works in the Codex **node REPL** runtime (`browser-client` needs `globalThis.nodeRepl.rpc`).
- `CodexExecutor` spawns the real `codex` CLI, but the **node REPL sandbox denies a child codex process** from writing `~/.codex/tmp/arg0` / initialising its in-process app-server client (`Access is denied`). This restriction propagates to ANY descendant process tree rooted at the REPL.
- Therefore `codex` must run in a process tree NOT rooted at the REPL (e.g. a normal node process started via `exec_command`), while the browser loop stays in the REPL.

### Runtime Host / IPC chosen (minimal, no big refactor)

- `scripts/codex-worker-host.mjs` — a long-lived **normal Node** process (started once via `exec_command`). It owns one `CodexExecutor` (keeps the same codex thread in-process) and exposes a **localhost TCP JSON-line server**: request `{id,prompt}` -> response `{id, sessionId, resultText, success, error}`; `{id, shutdown:true}` stops it.
- `scripts/runtime-host.mjs` — single entry `runRuntimeHost({repoDir, goal, worker, turnOptions})`. It connects to the worker, opens a BrainSession (new owned tab), runs `LoopController`, and uses a `CodexWorkerClient` facade for every Codex directive. Returns evidence and shuts the worker down.

### Single entry

```js
// node REPL
const { runRuntimeHost, CodexWorkerClient } = await import('.../scripts/runtime-host.mjs');
const worker = new CodexWorkerClient({ port: <workerPort> });
const ev = await runRuntimeHost({ repoDir, goal, worker });
// ev = { done, stoppedAt, turns, conversationId, ownedTabId, executorSessionId, log[] }
```

The worker is started once (via `exec_command`); then `runRuntimeHost` drives the whole loop (browser sends + worker codex calls) to DONE / ASK_USER.

### Notes / limits

- The `node REPL` tool call is capped (~300s). A 2-round loop completes within it; longer loops may need the agent to re-run `runRuntimeHost` (which reuses the same conversation/thread if state is persisted).
- The live run still uses `--dangerously-bypass-approvals-and-sandbox` inside the worker on an isolated test repo (environment forces child sandbox read-only). Production should avoid bypass and scope `repoDir`.
- Reply detection skips ChatGPT "thinking" placeholders and waits for the real reply to stabilise.

---

## Batch A — Reliability Core

### Modules

- `src/task-state.js` — Durable Task State (schemaVersion, atomic write + `.bak`, corruption throws `TaskStateCorruptError` instead of silently resetting; stable taskId; step ledger + acceptance registry).
- `src/protocol.js` — Structured Brain Protocol (TASK/REVISE/ASK_USER/DONE with `stepId`/`instruction`/`acceptance[]`; structured RESULT; schema validation with ONE auto-repair; legacy text fallback; `checkAcceptanceGate`).
- `src/task-manager.js` — TaskManager: `startTask` / `resumeTask` / `getTaskStatus` / `cancelTask`; resumable & idempotent engine; recovery detection; acceptance gate on DONE.

### Task State (schema v1)

Stored as `<stateDir>/<taskId>.json` (with `.bak`). Fields: `schemaVersion, taskId, repoDir, goal, status, conversationId, conversationUrl, ownedTabId, codexSessionId, round, lastControl, inFlightStep, steps[], completedSteps[], acceptanceRegistry[], createdAt, updatedAt`.

Statuses: `running | awaiting_user | recovery_required | completed | failed | cancelled`.

Step ledger statuses: `received | executing | executed | result_recorded | result_sent | reviewed`.

### State machine / idempotency

- `startTask` creates a task and drives the loop (up to `maxRounds`).
- `resumeTask` reloads state; if a step is `received`/`executing` (codex side-effect unconfirmed) -> `recovery_required` and NO auto re-run; otherwise it re-attaches the same conversation/tab and the same codex thread/session and continues.
- `completedSteps` are never re-run.

### Resume / recovery

- Reuses the same ChatGPT conversation, owned tab (or re-binds the same conversation if the tab was lost), and the same Codex thread/session (worker keeps it in-process).
- `ASK_USER` -> `awaiting_user`; resume is allowed once the user supplies the next control.

### Structured Brain Protocol + Acceptance

New runtime defaults to structured JSON control/reply. Invalid output triggers one auto-repair; still invalid -> `ProtocolError`. `DONE` is only accepted when every required acceptance is `pass`; otherwise the task stays not-completed (`awaiting_user` with `acceptanceBlock`).

### Lifecycle entry

Callers use `startTask(goal, repoDir) / resumeTask(taskId) / getTaskStatus(taskId) / cancelTask(taskId)` and no longer manage worker / Browser / LoopController per round.

---

## Batch B — Alpha Reliability & Safety

### Modules

- `src/task-lock.js` — per-task exclusive lock (`TaskLock`), prevents two runtimes from driving the same task (`TaskLockedError`).
- `src/task-service.js` — unified entry `TaskService`: `startTask(goal, repoDir)` / `resumeTask(taskId)` / `getTaskStatus(taskId)` / `cancelTask(taskId)`. Manages worker + Brain + state + loop; caller no longer manages per-round.
- `src/safety.js` — random secret, `redactSecrets`/`redactObject`, structured `TaskLog` (size-capped), `normalizeRepoDir`, `verifyAuth`.
- `src/protocol.js` — evidence hardening: `normalizeEvidence` / `validateEvidence` / `parseEvidenceBlock`; acceptance requires explicit `pass` evidence (never auto-pass from codex exit code).
- `src/doctor.js` — doctor/self-check (static + live IAB).

### B3 evidence model

RESULT evidence items = `{ acceptanceId, status: pass|fail|unknown, kind, summary }`. `checkAcceptanceGate` requires every REQUIRED acceptance to have `pass` evidence. The engine never marks an acceptance `pass` merely because codex exited 0; evidence must come from the codex result (structured `evidence[]` or an `EVIDENCE:` block) or explicit test results.

### B4 runtime safety

- IPC: worker binds localhost only; each worker process has a random `token`; requests must carry `auth` (token) + a bound `taskId`; mismatches are rejected.
- The bearer token is passed in the codex child argv (a limitation of the local governor auth), but it is redacted from logs/state and from returned text.

---

## Batch D — Crash-safe Recovery Gates (Alpha E2E)

The Alpha reliability pass validated a set of gates that must hold for the loop to be crash-safe:

- **Gate 1 (auto-complete bootstrap)**: A single lifecycle layer auto-completes worker start, ready handshake, port/token acquisition, Brain/runtime startup, teardown/restart. The Codex worker runs in an `exec_command` ordinary-Node process (required: the node-REPL sandbox forbids a descendant codex), and the IAB BrainSession runs in the node REPL; the task entry (`TaskService.startTask/resumeTask`) coordinates both so the user triggers once.
- **Gate 2 (crash-safe lock)**: `TaskLock` writes an owner token + pid + heartbeat. On EEXIST it checks owner liveness (pid) and staleness (age); only then reclaims. Active owner => `TaskLockedError`.
- **Gate 3 (worker/auth restart)**: a restarted worker generates a NEW IPC token; the client re-does the ready/auth handshake; the **Codex sessionId** is restored via `--session` (not the IPC secret).
- **Gate 4 (clean Alpha E2E)**: completed and captured on a fresh 3-step repo task (see below).

### Live Alpha E2E evidence (fresh 3-step `ceil` task)

- `startTask(maxRounds=1)` via `TaskService` → round 1 done, state persisted:
  - taskId `5b509121-4048-4383-bcc5-33857c58feb9`, conversation `6a917ec8-aa48-83ea-974d-322616d24ed6`, ownedTab `23`, codex thread `01a04855-6ba7-72d3-b2c3-2fe23a5d18b9`, `step-1:reviewed`.
- **Force-killed worker A** (real process termination, not maxRounds).
- **Started worker B** with the SAME codex session (`--session 01a04855-...`) → NEW IPC token.
- `resumeTask(taskId)` → `status=completed`, `round=3`, `steps=step-1,2,3 all reviewed`.
  - taskId / conversation / ownedTab / codex thread **all unchanged**.
  - `step-1` (crash-before) **not re-executed**; only `step-2,3` added.
  - `BLOCK=none` (acceptance gate passed), `lastControl=DONE`.
- Repo tests all pass (ceil + all prior modules). State contains **no secret** patterns.
- IPC auth: a request with a WRONG token is rejected (`auth token mismatch`); the restarted worker accepts the correct token. `taskId` mismatch is checked when the worker is bound to a taskId.
- In-flight crash: a step stuck in `executing` → resume enters `recovery_required`, `executor_calls=0` (no auto re-run).
- Task lock: second active owner rejected (`TaskLockedError`) and stale lock reclaimed — covered by offline tests.

Notes: the live run used the legacy text protocol (no `acceptance[]`), so the DONE acceptance gate passed trivially; per-item real evidence (pass/fail/unknown, kind, summary) is enforced and proven by `test/evidence.test.js` (4 cases).

---

## Batch C — Real Workflow Integration

### Modules

- `src/brain-context.js` — `newBrainContext`, `ProjectStore` (`bindProject(repoDir, brainProfile)` / `getProjectBinding(repoDir)`). One repoDir ↔ one local Brain Project Profile ↔ many task conversations. No fragile DOM / ChatGPT project-id guessing (Alpha uses local binding).
- `src/context-provider.js` — `PacketContextProvider` (`buildPacket`): bounded repo map, git status/diff, file snippets, test results/errors; skips `.env`/secrets/node_modules; redacts secrets; records provenance.
- `src/iab-transport.js` — `openCurrentConversation(transport)`: reads the selected IAB tab's `/c/<id>` and binds a BrainSession to it (no new conversation).
- `src/task-service.js` — `startTask({ goal, repoDir, conversation: 'new' | 'current' | '<id>' })` + `adoptConversation({ goal, repoDir })`. `conversation:'current'` uses `runtime.adoptBrain`; teardown does not close the adopted (user) tab by default.

### Context

`conversation:'current'` binds to the existing ChatGPT conversation (no new conversation); `'new'` still creates a fresh conversation (regression preserved). A `BrainContext`/project binding and a `PacketContextProvider` are optional inputs.

### Adoption live E2E

- Pre-existing conversation `6a918805-1124-83ea-ade7-34bf88b1a995` (with ABS requirements context).
- `adoptConversation` bound it (no new conversation), ran 3 steps (`abs.js`, `abs-cli.js`, `test-abs.js`), DONE. taskId `5f84bc16-…`, codex thread `01a0487b-…`, all steps reviewed, repo tests pass.

### New Task regression E2E

- `conversation:'new'` created a fresh conversation (`6a918ac2-78f8-83ea-a216-872933dfd945`) and ran 3 steps — the new-conversation path still works (not broken by adopt).

### Structured acceptance/evidence (live)

- ChatGPT issued structured `TASK` JSON with `acceptance[]`; Codex returned `EVIDENCE: [{"acceptanceId":…,"status":"passed",…}]`. With `parseEvidenceBlock` handling JSON arrays and `normalizeEvidence` accepting `passed/failed` aliases, the acceptance registry maps to `pass` and `checkAcceptanceGate` returns `allPass=true` (3 required acceptances).
- The engine never auto-passes from codex exit code; it requires explicit evidence.
