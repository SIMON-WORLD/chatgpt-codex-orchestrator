---
name: brain-command
description: "Canonical launcher for the ChatGPT-command orchestrator. Default = Direct Brain Loop: the current Codex agent talks to ChatGPT via the built-in browser, executes the Brain TASKs itself, and publishes on DONE. Use when the user wants to run a coding task with ChatGPT as planner/reviewer and Codex as the local executor, e.g. '用 ChatGPT 指挥模式完成...', '让 ChatGPT 指挥 Codex...', or 'Use ChatGPT as the brain and Codex as executor...'. Default Brain = ChatGPT, default Executor = the current Codex agent. The detached worker/nested-Codex runtime is kept as legacy/experimental."
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
→ REVISE / TASK / DONE
→ publish on DONE
```

Defaults: **Brain = ChatGPT**, **Executor = the current Codex agent**, **conversation = one dedicated ChatGPT conversation reused across the whole task**.

## When to use

Trigger on natural-language requests such as:

- `用 ChatGPT 指挥模式完成...`
- `让 ChatGPT 指挥 Codex...`
- `Use ChatGPT as the brain and Codex as executor...`
- any request to run a coding task where ChatGPT plans/reviews and Codex executes.

Do **not** trigger for ordinary local-only coding.

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

   Do **not** dump large repo history/source on the first message.

5. **Parse the Brain's control.** Use `parseBrainOutput` / `parseEvidenceBlock` from `src/protocol.js` to turn the reply into a structured control (`PLAN`, `TASK`, `REVISE`, `ASK_USER`, `DONE`, `REPLAN`). A `PLAN` is followed by a concrete `TASK`.

6. **Execute the TASK in the current Codex agent.** Do **not** start a nested Codex, do not start a worker, do not wait on a ready file. The current Codex agent is the executor. Do the work, collect real evidence, and verify.

7. **Send a compact RESULT back to the same conversation.** Build it with `buildCompactResult` / `normalizeResult` from `src/protocol.js`:

   ```js
   const { buildCompactResult } = await import('<orchestratorRoot>/src/protocol.js');
   const msg = JSON.stringify(buildCompactResult({
     stepId, status: 'success', summary, changed, evidence, blockers,
   }));
   const r = await provider.send(msg);
   ```

   The RESULT should carry only what the Brain needs for its next decision: `stepId`, `status`, `summary`, `changed`, `evidence`, `blockers`.

8. **Review loop.** The same ChatGPT conversation returns the next control (`TASK` / `REVISE` / `REPLAN` / `ASK_USER` / `DONE`). Keep the same conversation; do not resend the full goal/plan/raw logs each turn.

9. **DONE + publish gate.** On `DONE`, run mandatory verification, a repo final check, and a working-tree scope check, then use the publish gate:

   ```js
   const { evaluatePublishGate } = await import('<orchestratorRoot>/src/direct-mode.js');
   const gate = evaluatePublishGate({
     brainControl: 'DONE',
     taskStatus: 'completed',
     mandatoryVerificationOk: true,
     workingTreeScopeOk: true,
   });
   ```

   Publish only when `gate.ok && gate.reason === 'publish gate passed'`:
   - ensure a meaningful commit,
   - `fetch origin`, confirm a clean fast-forward,
   - `push origin/main` (never force-push).

   Never publish on `REVISE`, `ASK_USER`, failure, or `recovery_required`.

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

Normal Direct Mode does not require a daemon. If a minimal task record is useful, `newDirectTaskState` keeps only: `taskId`, `repoDir`, `brainProvider`, `executor`, `conversationId`, `conversationUrl`, `conversationTitle`, `plan`, `currentStepId`, `completedSteps`, `evidenceLedger`, `publishPolicy`. State persistence must never block the normal run; complex crash recovery is a later enhancement, not a P0.

## Scope boundaries (current Batch)

- Do not add: `execute.start` / `execute.poll`, nested Codex executor, a long-lived REPL driver, a recovery job protocol, or a new worker daemon architecture.
- Do not delete the existing worker / TaskService / recovery code; keep it as legacy / experimental.
- Do not start a second Codex session; the current Codex agent is the executor.