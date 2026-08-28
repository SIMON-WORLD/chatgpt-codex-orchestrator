---
name: chatgpt-codex-orchestrator
description: "Alpha entry for the ChatGPT-command orchestrator (v0.1.0-alpha.1, dogfood). Use when the user wants to run a coding task with ChatGPT as planner/reviewer and Codex as executor. Commands: doctor, start, resume, status, cancel. adopt-current is EXPERIMENTAL."
---

# ChatGPT-command orchestrator (v0.1.0-alpha.1 — dogfood)

Drives a durable ChatGPT <-> Codex loop. The agent drives it; the user only speaks the goal.

## Commands

- `doctor` — preflight checks (IAB runtime, ChatGPT composer/login, codex CLI, git, state/log dirs, localhost IPC, context provider; prints chosen dataRoot + source).
- `start` — `TaskService.startTask({ goal, repoDir, conversation: 'new' })`. New conversation + persistent Codex thread. (Default mode = `new`.)
- `resume` — `TaskService.resumeTask({ taskId })` (or turn-sliced `advanceTask(taskId)` loop).
- `status` — `TaskService.getTaskStatus(taskId)`.
- `cancel` — `TaskService.cancelTask(taskId)`.
- `adopt-current` — **EXPERIMENTAL** (`TaskService.adoptConversation`, conversation:'current'). Not a stable promise in alpha.1 because `tabs.selected()`/selected-tab identity is unstable across node-REPL invocations in the current Codex Desktop / IAB environment. The implementation is retained (binding is frozen + resolved via the retained persisted-binding resolver), but it is not a supported feature.

## Runtime wiring (agent-side)

The worker runs in an ordinary Node process (started by the environment via exec_command); the IAB BrainSession runs in the node REPL. The agent:

1. starts the worker once (non-elevated, `--data-root <durable>`): `node scripts/codex-worker-host.mjs --repo <repoDir> --port 0 [--bypass] [--session <codexSessionId>] [--data-root <dir>] [--ready-file <file>]`.
2. reads the ready file for `{ port, token }`.
3. builds a TaskService whose runtime provides `makeDataStore` (worker-backed durable state), `openBrain`/`adoptBrain`/`reopenBrain`/`rebindBrain`, and `makeExecutor`.
4. drives `advanceTask` in a turn-sliced loop (each unit well under the node-REPL time cap) until DONE / ASK_USER / recovery_required.

No user-visible port/token/node-REPL details are exposed.

## Security / ownership

- Data root: worker owns a durable writable root (no elevation, no dangerous bypass). If none writable -> doctor FAIL with `CHATGPT_ORCHESTRATOR_DATA_ROOT` guidance.
- Secrets redacted from logs/state; bearer token appears on the codex child argv (local governor auth) — redacted but not removed.
- Never modifies other IAB tabs; adopted user tab (when used) is not closed.