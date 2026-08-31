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

## Protocol integrity & authority

- **Executor / Machine / Brain authority is explicit.** `executorStatus` (success | failure | blocked | unknown) is reported by the Executor; the machine computes `machineGate` (pass | fail | pending); only a subsequent valid Brain control changes `brainAcceptance` (pending | accepted | revise | rejected). `markStepReviewed` / `markMachineEvidenceComplete` marks machine evidence completion, NOT Brain acceptance. A milestone is globally accepted only when executorStatus is acceptable AND machineGate=pass AND the Brain explicitly accepts/advances it.
- **Structured Brain envelope is mandatory (canonical).** Every actionable Brain response must carry one canonical envelope `{ runId, controlId, sequence, control, stepId, instruction, acceptance, ackResultId?, reviseDelta?, askUser? }`. Brain may write explanatory prose, but if no valid envelope exists, send ONE format-repair request to the SAME conversation (``Restate the immediately previous control in canonical structured form only. Do not replan or change its instruction/acceptance.``) and do NOT execute until it parses. Legacy prose parsing is only an explicit compatibility mode, not canonical Direct Mode.
- **Control / RESULT identity + monotonic cursor.** Every control has `runId` / `controlId` / `sequence`; every RESULT carries `runId` / `resultId` / `inReplyToControlId` / `sequence` / `stepId` / `payloadHash` / `executorStatus` / `machineGate` / `changed` / `evidence` / `blockers`. `sequence` strictly increases; only one outstanding control executes; RESULT must match the outstanding `controlId`; stale controls are rejected; already-processed controls are not re-executed; duplicate RESULT is idempotent; retransmission reuses the SAME `resultId` + `payloadHash`. Do not correlate by natural-language `stepId` alone.
- **Piggyback ACK.** The next Brain control acknowledges the previous RESULT via `ackResultId` (`CONTROL c7 → RESULT r7 → CONTROL c8 {ackResultId: r7}`); when c8 is accepted, r7 is acknowledged. `provider.send(message, { nonce })` uses run/control/result correlation tokens so an old visible assistant reply cannot satisfy the current outbound turn.
- **Evidence epistemic level.** Structured evidence carries `evidenceLevel` (observed | inferred | user_verified | unobservable) with optional `requiredEvidenceLevel`; inferred cannot satisfy an observed requirement, user_verified may satisfy an acceptance explicitly allowing it, and unobservable is never silently converted to pass. The Executor must not present inference as observed runtime fact.
- **Minimal durable Direct run ledger.** A small atomic JSON checkpoint under the configured Direct data root persists only machine state needed for safe resume (`runId`, conversation identity, control/result identity, accepted sequence, outstanding / lastSent / lastAcknowledged ids, processed ids, brainAcceptance, frozen decisions, publication summary, minimal metrics). It never persists prompts, transcripts, terminal logs, secrets, or credential values. On resume it is combined with envelopes visible in the SAME conversation and fails closed on disagreement.
- **Standard ASK_USER envelope.** `ASK_USER` may carry `whyBlocked`, `minimalUserAction`, `readOnly`, `expectedFields`, `resumeControlId`; the human-facing question stays concise.
- **Single browser-runtime owner.** A canonical Direct run owns exactly ONE IAB provider/transport; it does not probe IAB availability from ordinary node subprocesses or start a separate browser runtime. Only the trusted IAB runtime may determine `IABUnavailableError`; all adoption / send / read / recovery / rebind go through the canonical provider, and if the runtime is lost it uses the persisted binding + `reopenConversationFromBinding`-style recovery.
- **Publication truth.** `PUBLISH` authorizes the publication action; `DONE` is terminal and never authorizes publishing. The run ledger records publication state (`strategy`, `prNumber`, `checksState`, `mergeSha`, `externalVerified`); PR-based workflows may remain Brain-directed (no generic PR platform is built here).

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
- Emit metrics from the ACTIVE run state (the final report reads `directRunCoordinator.metrics()` / `directRunLedger.state.metrics`), including (`createDirectMetrics`): duration, timeToFirstBrainControl, brainTurns, taskCount, reviseCount, replanCount, askUserCount, publishCount, replyTimeoutCount, browserRecoveryCount, conversationSwitchCount, reusedProofCount, staleProofCount, verificationRuns, publishRetryCount, protocolRepairCount, staleControlRejectedCount, duplicateResultCount, resultRetransmitCount, deliveryAckTimeoutCount, manualInterventionCount. No telemetry backend / no prompt or raw-log persistence.

## Run (canonical default path)

For a normal `$brain-command <goal>`, drive ONE canonical Alpha.4 Direct controller
(`createDirectRun` from `src/direct-run-controller.js`, mode `direct-alpha4`). The
controller owns the protocol mechanics (provider, ledger, coordinator, governance,
canonical envelope parsing, nonce, RESULT hashing, resume/recovery). The agent
provides only config/repo resolution, task execution + real evidence, and the
publication mechanics. **Do not manually reassemble the protocol primitives and do
not inspect the orchestrator implementation source during normal startup.**

**Governance:** PLAN comprehensively once, then prefer **milestone-sized** TASKs that combine coherent implementation work that can be executed and reviewed together; Codex may run normal implementation/debug/test iterations inside one TASK and returns to the Brain only at meaningful review/decision boundaries; `REVISE` remains available whenever evidence fails.

**Control lifecycle (every non-terminal control closes with exactly one RESULT):** `PLAN` → compact RESULT → next control; `REPLAN` → compact RESULT → next control; `TASK` → execution RESULT; `REVISE` → corrective execution RESULT; `ASK_USER` → wait for the user → `user_verified` RESULT → next control; `PUBLISH` → publication RESULT; `DONE` → terminal, no subsequent RESULT. All RESULTs go through `run.prepareResult(...)` + `run.sendResult()`. `DONE` is the only terminal control. The next control after a sent-but-unacknowledged RESULT must carry `ackResultId == lastSentResultId` (mandatory piggyback ACK, no standalone ACK turn); wrong/missing ACK is a structured protocol-integrity failure and the control is not accepted. ACK proves delivery, not prior-milestone acceptance: `TASK`/`PUBLISH`/`DONE` advancement requires the prior RESULT to be `executorStatus=success` + `machineGate=pass` + correct ACK before the prior becomes Brain-accepted; `REVISE` applies `reviseDelta` without requiring prior pass; `ASK_USER`/`PLAN`/`REPLAN` do not silently accept a prior failed milestone.

1. **Load config.** Read only `$CODEX_HOME/brain-command/config.json` (`$CODEX_HOME` defaults to `~/.codex`). Read `orchestratorRoot`, `dataRoot`, `workspaceRoot`, `defaultBrain`, `defaultExecutor`, `defaultConversationMode`. Do not traverse `~/.codex`, skills, or repo source beyond the config.

2. **Resolve repo.** Prefer, in order: an explicit repo/path the user gave; the current cwd if it is the target repo; otherwise `config.workspaceRoot` / the deterministic configured location. No broad recursive filesystem discovery.

3. **Create the canonical Direct controller** inside the trusted Codex in-app-browser (iab) context (iab **only**; never Edge/Chrome/external browser, no fallback):

   ```js
   const { createDirectRun, DIRECT_ALPHA4_MODE } = await import('<orchestratorRoot>/src/direct-run-controller.js');
   const run = createDirectRun({ runId, dataRoot: cfg.dataRoot, repoDir });
   run.setOrchestratorHead(HEAD);
   ```

   If the IAB is unavailable, stop and report (`IABUnavailableError`) instead of switching browser backend. Never probe `createChatGPTBrowserProvider` / the controller from an ordinary node subprocess. Do not start a second browser runtime.

   Optional: to continue an existing ChatGPT history conversation, first `await run.adoptConversation({ conversationUrl | conversationId | title })` (no new conversation), else `run.start(...)` opens/reuses one dedicated Brain conversation via the built-in browser. Default conversation mode is `new`.

4. **Send the dynamic takeover + bootstrap and accept the first control.** `await run.start({ goal, repoDir, gitRun })` builds `buildTakeoverContract({ runId })`, appends a compact read-only bootstrap (`buildBootstrapEvidence`), sends it, then extracts/validates the first canonical envelope (ONE `FORMAT_REPAIR` allowed, then fail closed), `acceptControl`, and `persist`. It returns the first control: `PLAN` / `TASK` / `REVISE` / `REPLAN` / `ASK_USER` / `PUBLISH` / `DONE`. Do not dump large repo history/source.

5. **Loop — the controller owns protocol, the agent owns execution.** For each Brain reply:

   - `const ack = await run.acceptBrainReply(reply);` — extracts/validates the canonical envelope, sends ONE `FORMAT_REPAIR` if needed (then fail closed), `acceptControl` (monotonic sequence, one outstanding, stale/acked validation), applies the deterministic Brain acceptance transition for the prior milestone (`applyBrainAcceptanceTransition`: `TASK`/`PUBLISH`/`DONE` advancing → prior accepted, `REVISE` → prior revise per `reviseDelta`, `ASK_USER` → no silent accept), and `persist`. Returns `{ ok, control }`.
   - If `control === 'TASK'`: execute the body in the current Codex agent (no nested Codex, no worker, no ready file); collect real evidence + verification; then `const prep = run.prepareResult({ stepId, executorStatus, changed, evidence, blockers });` and `const sent = await run.sendResult();`. The controller runs `governance.transition` ONCE, computes `machineGate`, freezes `resultId`, `computePayloadHash`, `coordinator.recordResult` (verifies the hash; no send before `ok`), persists the frozen RESULT, `JSON.stringify`s it, and `provider.send(serialized, { nonce })`. The executor's summary never overrides the gate.
   - If `control === 'PUBLISH'`: confirm `run.publicationGate({ brainControl: 'PUBLISH', acceptanceGateOk, identityPreflightOk, workingTreeScopeOk })` (requires `brainControl === 'PUBLISH'` — `DONE` never authorizes publishing), run the publication transaction (`createPublicationTransaction`): identity preflight → `fetch origin` → verify `origin/main` baseline → create commit → re-check remote race → require fast-forward → push (no force) → optional tag/Release → external readback; then `run.prepareResult(...)` + `run.sendResult()`.
   - If `control === 'DONE'`: `run.doneGate({ publicationReady, finalVerificationOk, workingTreeScopeOk })` must pass; `run.isTerminal('DONE')` is true; after `DONE`, `TASK`/`REVISE`/`REPLAN`/`PUBLISH` are invalid (`validateLifecycleAfterDone`).
   - If `control === 'ASK_USER'`: `run` exposes `askUser`/`whyBlocked`/`minimalUserAction`/`readOnly`/`expectedFields`/`resumeControlId`; ask the human concisely, then resume.
   - If `control === 'PLAN'`/`REVISE`/`REPLAN`: handle per the control; `REVISE` uses `reviseDelta` and returns to the Brain when evidence fails.

6. **Resume / delivery recovery is controller-owned.** On provider/composer/kernel failure, `await run.resume()` reloads the `DirectRunLedger`, reopens the SAME conversation binding, recovers the current run/control/result cursor, and retransmits the SAME frozen `resultId` + `payloadHash` only when it was sent but not yet acknowledged (no new resultId, no duplicate execution). Do NOT instruct the user to click/paste until bounded canonical recovery has failed. No daemon, no background worker.

7. **Runtime provenance is self-reported.** `run.statusPacket()` returns `{ mode: 'direct-alpha4', orchestratorHead, runId, conversationId, conversationUrl, ledgerPath }`, and `run.metrics()` returns the active-run metrics (`brainTurns`, `taskCount`, `reviseCount`, `replanCount`, `askUserCount`, `publishCount`, `protocolRepairCount`, `staleControlRejectedCount`, `duplicateResultCount`, `resultRetransmitCount`, `deliveryAckTimeoutCount`, `manualInterventionCount`, `reusedProofCount`, `staleProofCount`, `verificationRuns`, …). Include the status packet in the dogfood report so it is obvious canonical Direct Mode actually ran.

**Do NOT** enter the `TaskService` / `TaskManager` / worker bootstrap / `LoopController` / `scripts/brain-command-launcher.mjs` legacy execution path — that is the legacy/experimental runtime, not the canonical Alpha.4 path. A normal `$brain-command` invocation must reach the Direct controller, not the legacy path.

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