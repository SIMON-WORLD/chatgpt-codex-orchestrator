---
name: chatgpt-codex-orchestrator
description: "Alpha entry for the ChatGPT-command orchestrator (v0.1.0-alpha.2). Use when the user wants to run a coding task with ChatGPT as planner/reviewer and Codex as executor. The canonical launcher Skill is `brain-command`. Commands: doctor, start, resume, status, cancel. adopt-current is EXPERIMENTAL."
---

# ChatGPT-command orchestrator (v0.1.0-alpha.2)

Drives a durable ChatGPT <-> Codex loop. The agent drives it; the user only speaks the goal.

## Launcher

The canonical launcher Skill is **`brain-command`** (provider-neutral by name; default Brain = ChatGPT, Executor = Codex, conversation = new). It reads `$CODEX_HOME/brain-command/config.json`, resolves the repo deterministically, runs a fast preflight, and starts this orchestrator. See `skills/brain-command/SKILL.md`. Normal startup does NOT do broad filesystem discovery.

## Commands

- `doctor` — preflight checks (IAB runtime, ChatGPT composer/login, codex CLI, git, state/log dirs, localhost IPC, context provider; prints chosen dataRoot + source).
- `start` — `TaskService.startTask({ goal, repoDir, conversation: 'new' })`. New conversation + persistent Codex thread. (Default mode = `new`.)
- `resume` — `TaskService.resumeTask({ taskId })` (or turn-sliced `advanceTask(taskId)` loop).
- `status` — `TaskService.getTaskStatus(taskId)`.
- `status:brain-command` — read-only check that the user-level launcher Skill is discoverable and the brain-command config exists/parses; prints `orchestratorRoot` / `dataRoot` / `workspaceRoot` and the defaults; never prints secrets; exit 0 healthy / 1 missing-or-invalid. `npm run status:brain-command` (scripts/brain-command-status.mjs).
- `cancel` — `TaskService.cancelTask(taskId)`.
- `adopt-current` — **EXPERIMENTAL** (`TaskService.adoptConversation`, conversation:'current'). Not a stable promise in this alpha because `tabs.selected()`/selected-tab identity is unstable across node-REPL invocations in the current Codex Desktop / IAB environment.

## Protocol (Alpha.2)

- Structured protocol is the default: `PLAN` / `REPLAN` (Brain -> Orchestrator control/state, not forwarded to Codex), compact `TASK`, compact `RESULT`, plus the existing `REVISE` / `ASK_USER` / `DONE`. The legacy text protocol remains a compatible fallback.
- Durable state stays schema v1 but adds `taskContract`, `plan`, `repoContext`, `verificationPolicy`, `stepSummaries`, `evidenceLedger`, `unresolvedRisks`, `currentStepId`.
- Verification tiers: step / milestone / final, with authority precedence `mandatory orchestrator boundary > Brain requested level > Codex local minimum`.
- Orchestrator-owned compaction when a step reaches `reviewed -> compact` (durable `stepSummary`).

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
