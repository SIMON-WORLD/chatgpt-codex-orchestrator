---
name: brain-command
description: "Canonical launcher for the ChatGPT-command orchestrator. Default = Direct Brain Loop: the current Codex agent talks to ChatGPT via the built-in browser, executes the Brain TASKs itself, and runs the PUBLISH -> publication transaction -> external readback -> terminal DONE lifecycle. Use when the user wants to run a coding task with ChatGPT as planner/reviewer and Codex as the local executor, e.g. '用 ChatGPT 指挥模式完成...', '让 ChatGPT 指挥 Codex...', or 'Use ChatGPT as the brain and Codex as executor...'. Default Brain = ChatGPT, default Executor = the current Codex agent. The detached worker/nested-Codex runtime is kept as legacy/experimental."
---

# brain-command (Direct Brain Loop)

The default production path is the **Direct Brain Loop**.

```
User
→ current Codex agent
→ Codex built-in browser
→ ChatGPT Brain
→ current Codex agent executes TASK
→ compact RESULT back to the same ChatGPT conversation
→ REVISE / TASK / REPLAN
→ PUBLISH
→ publication transaction → publish RESULT → external readback → Brain review
→ terminal DONE
```

Defaults: **Brain = ChatGPT**, **Executor = the current Codex agent**, **conversation = one dedicated ChatGPT conversation reused across the whole task**.

## When to use

Trigger on natural-language requests such as:

- `用 ChatGPT 指挥模式完成...`
- `让 ChatGPT 指挥 Codex...`
- `Use ChatGPT as the brain and Codex as executor...`
- any request to run a coding task where ChatGPT plans/reviews and Codex executes.

Do **not** trigger for ordinary local-only coding.

## Default execution contract

Established once per task; the Brain does not repeat these defaults inside every `TASK` (unless an exception/override is needed):

- ChatGPT owns `PLAN` / architecture / review / `DONE`.
- Codex stays within Brain-approved scope.
- Codex may run normal edit/debug/test iterations inside one milestone TASK.
- Mandatory verification applies.
- Protect secrets; fail closed on ambiguity.
- Return compact `RESULT` evidence.
- No force push or published-history rewrite.
- Publish only after `PUBLISH` + publication gate; `DONE` is terminal.


## Acceptance, proof ledger & verification

- `acceptance[]` on a structured `TASK` / `REVISE` is a machine contract. Every `RESULT` evidence item must carry an `acceptanceId`.
- A TASK / milestone is only `reviewed`/`completed` when EVERY required `acceptanceId` has evidence `status === 'pass'` (`evaluateDirectAcceptanceGate`). The executor's natural-language summary does NOT override the gate; unknown / missing evidence is not pass, and evidence is never invented.
- A Direct Mode `proofLedger` (`createProofLedger`) records reusable proofs (`acceptanceId`, `status`, kind/summary, verification command/test identity, relevant file fingerprints, `createdAt`/`stepId`). A proof stays fresh only while its relevant dependencies are byte-for-byte unchanged (`isReusable`); a changed dependency makes it stale, and stale/missing/failed required proofs must be verified again before a milestone/final gate.
- Verification tiers use the ledger (`planVerification` / `verifyTierPrecondition`): STEP = targeted/syntax; MILESTONE = milestone gate + reusable fresh proofs; FINAL = all required proofs fresh/pass. Do NOT blindly rerun a fresh proof whose inputs are unchanged (the Brain may always escalate verification).

## Terminal lifecycle (PUBLISH before DONE)

```
PLAN
→ TASK / REVISE / REPLAN
→ PUBLISH
→ publication transaction → publish RESULT (external observable evidence)
→ external readback → Brain review
→ REVISE if needed
→ terminal DONE
```

- `PUBLISH` is a non-terminal control. `DONE` is **terminal**: after `DONE`, `TASK` / `REVISE` / `REPLAN` / `PUBLISH` are invalid (`validateLifecycleAfterDone`).
- Use `createPublicationTransaction` for the safe sequence: final acceptance gate → identity preflight → fetch → verify `origin/main` baseline → create commit → re-check remote race → require fast-forward → push (no force) → optional tag / GitHub Release → external readback. If `origin/main` moves unexpectedly, STOP/REPLAN; never force.
- `publicationReadyForDone` requires external observable evidence (remote main SHA, tag SHA, Release existence/draft/prerelease, title/body) before a terminal `DONE`.

## Bootstrap evidence & metrics

- On the first Brain takeover, send a small read-only bootstrap packet (`buildBootstrapEvidence`): `repoDir`, `currentBranch`, `HEAD`, `git status --short` summary, `origin/main` divergence. Keep it compact; do not require a separate standalone baseline TASK unless the project really needs deeper inspection.
- Track minimal in-memory Direct run metrics (`createDirectMetrics`): duration, timeToFirstBrainControl, brainTurns, taskCount, reviseCount, replanCount, askUserCount, publishCount, replyTimeoutCount, browserRecoveryCount, conversationSwitchCount, reusedProofCount, staleProofCount, verificationRuns, publishRetryCount. No telemetry backend / no prompt or raw-log persistence.

## Run (canonical default path)

For a normal `$brain-command <goal>`, follow this deterministic sequence. **Do not inspect the orchestrator's implementation source during normal startup.** The goal is to get ChatGPT guiding as fast as possible — the only delays should be the browser/tool and ChatGPT's own response latency.

1. **Load config.** Read only `$CODEX_HOME/brain-command/config.json` (`$CODEX_HOME` defaults to `~/.codex`). Read the needed fields (`orchestratorRoot`, `dataRoot`, `workspaceRoot`, `defaultBrain`, `defaultExecutor`, `defaultConversationMode`). Do not traverse `~/.codex`, skills, or repo source beyond the config.

2. **Resolve repo.** Prefer, in order: an explicit repo/path the user gave; the current cwd if it is the target repo; otherwise `config.workspaceRoot` / the deterministic configured location. No broad recursive filesystem discovery.

3. **Open / reuse the Brain.** Use the current Codex agent's **built-in browser** capability. Default provider is ChatGPT (`brainProvider: 'chatgpt'`). Open or reuse one dedicated brain-command ChatGPT tab/conversation using `createChatGPTBrowserProvider` from `src/direct-mode.js`:

   ```js
   const { createChatGPTBrowserProvider } = await import('<orchestratorRoot>/src/direct-mode.js');
   const provider = createChatGPTBrowserProvider();
   const identity = await provider.open({ url: 'https://chatgpt.com/' });
   ```

   Canonical Direct Mode uses the **Codex in-app browser (iab) only** — it never attaches to or manipulates the user's Edge/Chrome/external browser, and there is no fallback. If the IAB is unavailable, stop and report (`IABUnavailableError`) instead of switching browser backend. If ChatGPT is already signed in, continue. Only if you actually detect a real login page / auth failure: `ASK_USER` to sign in, then continue. Do not pause pre-emptively because login *might* be needed. Keep the same conversation across turns (`provider.identifyConversation()` / `provider.resume(...)`); never restart a new conversation mid-task.

4. **First Brain message.** Send the user goal + repo identity/path + a concise governance contract. The contract must say:

   - ChatGPT owns planning, review, and decisions.
   - Codex executes only bounded TASKs.
   - Return structured `PLAN` / `TASK` / `REVISE` / `ASK_USER` / `DONE`.
   - Use compact packets after the initial `PLAN`.
   - PLAN comprehensively once, then prefer **milestone-sized** TASKs that combine coherent implementation work that can be executed and reviewed together.
   - Codex may run normal implementation/debug/test iterations inside one TASK; return to the Brain only at meaningful review/decision boundaries.
   - `REVISE` remains available whenever evidence fails.
   - Establish the DEFAULT EXECUTION CONTRACT once (see the Default execution contract section); do not repeat these defaults in every `TASK` unless an exception/override is needed.

   Do **not** dump large repo history/source on the first message.

5. **Parse the Brain's control.** Use `parseBrainOutput` / `parseEvidenceBlock` from `src/protocol.js` to turn the reply into a structured control (`PLAN`, `TASK`, `REVISE`, `ASK_USER`, `DONE`, `REPLAN`, `PUBLISH`). A `PLAN` is followed by a concrete `TASK`.

6. **Execute the TASK in the current Codex agent.** Do **not** start a nested Codex, do not start a worker, do not wait on a ready file. The current Codex agent is the executor. Do the work, collect real evidence, and verify.

7. **Run the machine acceptance transition, THEN send the compact RESULT.** Execute `TASK` -> build the compact RESULT -> run the single canonical machine path BEFORE the Brain treats the milestone as accepted:

   ```js
   const { createDirectGovernance } = await import('<orchestratorRoot>/src/direct-governance.js');
   const t = governance.transition({ stepId, acceptance, result: { changed, evidence } });
   const reviewed = t.gate.ok ? governance.markStepReviewed({ stepId }) : { ok: false, blocked: true, missing: t.missing, failed: t.failed };
   ```

   Attach the machine gate outcome (`t.gate.ok`, `t.missing`, `t.failed`, `t.passed`) to the RESULT, then build with `buildCompactResult` / `normalizeResult` from `src/protocol.js` and send it to the SAME conversation via `provider.send`. The executor's summary never overrides the gate; if the gate fails the milestone is NOT reviewed/completed, `PUBLISH` / final completion is impossible, and the Brain receives the structured missing/failed ids and decides `REVISE` / further corrective control. The machine gate MUST run before the Brain is allowed to treat the milestone as accepted.

8. **Review loop.** The same ChatGPT conversation returns the next control (`TASK` / `REVISE` / `REPLAN` / `PUBLISH` / `ASK_USER` / `DONE`). Keep the same conversation; do not resend the full goal/plan/raw logs each turn.

9. **Machine acceptance transition, then PUBLISH, then terminal DONE.** Before a milestone advances, run the machine acceptance transition (`createDirectGovernance().transition(...)` then `.markStepReviewed(...)`); a milestone only advances when EVERY required acceptance has a `pass` evidence item (`evaluateDirectAcceptanceGate`). The executor's natural-language summary never overrides the gate; missing/unknown/failed required evidence is returned to the Brain as structured `missing`/`failed` ids and is never silently advanced.

   On `PUBLISH`, confirm the publication gate (`evaluatePublicationGate`), which requires `brainControl === 'PUBLISH'` — `DONE` never authorizes publishing:

   ```js
   const { evaluatePublicationGate, evaluateDoneGate } = await import('<orchestratorRoot>/src/direct-mode.js');
   const gate = evaluatePublicationGate({ brainControl: 'PUBLISH', acceptanceGateOk, identityPreflightOk, workingTreeScopeOk });
   ```

   Then run the publication transaction (`createPublicationTransaction`): identity preflight -> `fetch origin` -> verify `origin/main` baseline -> create commit -> re-check remote race -> require fast-forward -> push `HEAD:refs/heads/main` (never force) -> optional tag -> externally supplied Release action/readback. Only after `publicationReadyForDone` (external observable evidence, including declared Release properties when a Release is required) may the Brain issue a terminal `DONE`.

   ```js
   const doneGate = evaluateDoneGate({ publicationReady, finalVerificationOk, workingTreeScopeOk });
   ```

   `DONE` is terminal: after `DONE`, `TASK` / `REVISE` / `REPLAN` / `PUBLISH` are invalid (`validateLifecycleAfterDone`).

   **Post-DONE boundary:** after Brain `DONE`, the target repo must NOT receive new product modifications that were not Brain-reviewed. Independent workspace bookkeeping/logging is allowed only if it does not change the already-accepted target-repo outcome.

## Direct Mode guarantees

`src/direct-mode.js` (`DIRECT_MODE_REQUIRES`) documents that the default path does **not** require:
- worker bootstrap
- a ready file
- a nested Codex executor
- localhost TCP
- an auth-token handshake
- a trusted-REPL long loop
- a process shim
- an external browser: Direct Mode uses the Codex in-app browser (iab) **only**; there is no Edge/Chrome/external-browser fallback. If the IAB is unavailable, stop and report rather than switch browser backend.

## Existing ChatGPT conversation (adopt)

By default `$brain-command <goal>` creates a **new** dedicated Brain conversation. To
continue an existing ChatGPT history conversation, adopt it explicitly (no new
conversation is created; the same conversation is reused for the whole loop):

- `$brain-command --conversation "<title>"`       — find an existing conversation by title.
- `$brain-command --conversation-url https://chatgpt.com/c/<id>` — open that conversation URL.
- `$brain-command --adopt-current`                — adopt the currently selected IAB conversation (explicit opt-in).

Natural-language equivalents: `使用 ChatGPT 历史会话 '...' 作为 Brain`, `继续我之前的 ChatGPT 对话`, `接上已有 ChatGPT conversation`.

### Resolution priority (`provider.adoptConversation`)

1. **conversationUrl / conversationId** — open the conversation URL and validate the real
   `/c/<conversationId>`; on identity mismatch fail explicitly (no fallback).
2. **title** — open `chatgpt.com`, use the existing login, locate a history conversation in the
   ChatGPT UI (sidebar / search) by accessible name/text/ARIA and stable `a[href*="/c/"]`
   selectors (never a fragile nth-child / UI index). Open it, capture the real `/c/<id>`,
   and bind to the ID thereafter (not the title). Unique match -> open; no match -> report
   without creating a new conversation; multiple matches -> `ASK_USER` / ambiguity (never guess).
3. **explicit `--adopt-current`** — only when the user explicitly asks; reuses
   `captureCurrentConversation()`.

### Login

Reuse the existing ChatGPT session/cookies in the built-in browser. Do not pre-block on a
possible login; only `ASK_USER` to sign in when a real login page / session-expired / no-access
is detected.

### Takeover message

After binding an existing conversation, send `DEFAULT_TAKEOVER_MESSAGE` from `src/direct-mode.js`
(do **not** dump the full history — the conversation already owns it). Then enter the normal
Direct Brain Loop. Persist `conversationId` / `conversationUrl` / `conversationTitle` in the
minimal task state so a later resume reuses the same conversation directly.

## Legacy / experimental runtime

The detached runtime is **legacy / experimental**, not the default:
- `scripts/brain-command-launcher.mjs` + `scripts/brain-command-worker.mjs` + `scripts/codex-worker-host.mjs`
- `scripts/runtime-host.mjs` (`LoopController`)
- `src/task-service.js` / `src/task-manager.js` / `src/worker-client.js`
- durable recovery machinery

These are retained for compatibility/experimental use and are not part of the canonical startup path.

## Provider abstraction (thin)

Only a thin contract is reserved for future providers; only **ChatGPT** is canonical today.

```ts
interface BrainProvider {
  open({ url })            // -> { conversationId, conversationUrl, tabId }
  send(message)            // -> { reply, conversationId, conversationUrl }
  identifyConversation()   // -> { conversationId, conversationUrl, tabId } | null
  resume({ tabId, conversationId, conversationUrl })  // -> BrainProvider
  adoptConversation({ conversationUrl?, conversationId?, title? })  // -> identity (no new conversation)
  adoptCurrent()           // -> identity (adopt the currently selected IAB conversation)
}
```

Canonical implementation: `ChatGPTBrowserProvider` (`createChatGPTBrowserProvider`), built on the built-in browser. Claude / DeepSeek / GLM are **not** implemented in this Batch.

## Minimal state

Normal Direct Mode does not require a daemon. `newDirectTaskState` carries the machine governance state used by the loop, all **in-memory** (NOT persistent/durable): the acceptance registry, the proof ledger snapshot, and Direct run metrics (via `governance`), plus `taskId`, `repoDir`, `brainProvider`, `executor`, `conversationId`, `conversationUrl`, `conversationTitle`, `plan`, `currentStepId`, `completedSteps`, `evidenceLedger`, `publishPolicy`. State persistence must never block the normal run; complex crash recovery is a later enhancement, not a P0.

## Scope boundaries (current Batch)

- Do not add: `execute.start` / `execute.poll`, nested Codex executor, a long-lived REPL driver, a recovery job protocol, or a new worker daemon architecture.
- Do not delete the existing worker / TaskService / recovery code; keep it as legacy / experimental.
- Do not start a second Codex session; the current Codex agent is the executor.