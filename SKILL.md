---
name: chatgpt-codex-orchestrator
description: "Alpha entry for the ChatGPT-command orchestrator (v0.1.0-alpha.3). Use when the user wants to run a coding task with ChatGPT as planner/reviewer and Codex as executor. The canonical launcher Skill is `brain-command`; its default path is the Direct Brain Loop (current Codex agent + built-in browser + ChatGPT). The detached worker/TaskService runtime is legacy/experimental. Released Alpha.3 operational default = legacy IAB Direct Brain Loop (feature-frozen); v0.2 canonical architecture (ChatGPT Custom MCP App -> Secure Tunnel -> local MCP -> Router/Governance -> Direct Local or Codex App Server) completed M7 real-project dogfood but is NOT yet the CLI/Skill default because the post-M7 Brain Continuity/default-policy gate remains open."
---

# ChatGPT-command orchestrator (v0.1.0-alpha.3)

Drives the currently released ChatGPT <-> Codex loop. The agent drives it; the user only speaks the goal.

> **Status boundary:** this file documents the released Alpha.3 operational fallback. The canonical development architecture is capability-first v0.2; see `PROJECT_STATUS.md`, `CAPABILITY_ROUTING.md`, `docs/architecture.md`, and `docs/rfc-v0.2-brain-continuity.md` for current project state. Do not infer current v0.2 milestone status from legacy runtime mechanics below.

## Default: Direct Brain Loop

The canonical released launcher Skill is **`brain-command`**. Its default path is the **Direct Brain Loop**: the current Codex agent uses the built-in browser to open/reuse one ChatGPT conversation, sends the goal + governance contract, receives `PLAN` / `TASK`, executes the `TASK` itself, sends a compact `RESULT` back to the same conversation, and repeats until `PUBLISH` -> publication transaction -> external readback -> terminal `DONE`. Provider-neutral by name; **Default Brain = ChatGPT**, **Default Executor = the current Codex agent**. See `skills/brain-command/SKILL.md`. Normal startup does NOT inspect orchestrator source and does NOT do broad filesystem discovery.

**Browser isolation:** canonical released Direct Mode uses the Codex **in-app browser (iab) only** — it never attaches to the user's Edge/Chrome/external browser and there is no fallback; if the IAB is unavailable, stop and report instead of switching browser backend.

**Existing conversation:** `$brain-command --conversation "<title>"` / `--conversation-url <url>` / `--adopt-current` continue an existing ChatGPT conversation (no new conversation). By default a new dedicated Brain conversation is created.

## v0.2 canonical (post-M7 status — NOT the released default)

The released operational default remains the **Direct Brain Loop** over the built-in IAB (Alpha.3, feature-frozen). A separate **v0.2 canonical** path exists and is the active development architecture:

`ChatGPT (Custom MCP App)` → `OpenAI Secure Tunnel` → `local MCP` → `Router/Governance` → `Direct Local` or `Codex App Server`.

- **M5** completed the Secure Tunnel + real ChatGPT/Codex App Server production E2E.
- **M6** completed the structural isolation of the IAB / Alpha.4 implementation under `src/legacy/`.
- **M7** real-project capability-routing dogfood is **COMPLETE / ACCEPTED**: Native-only, Codex-required, and Hybrid paths passed.
- The separate operational-default decision is currently **DEFERRED** while the accepted **Brain Continuity / Governance durability** contract is being implemented and real restart/re-entry dogfood remains pending.
- v0.2 therefore is **not yet** the CLI/Skill default, has not been released, and M8 has not started.
- The IAB path is **feature-frozen**, **not deleted**.

## Legacy / experimental runtime (not the default Direct Brain Loop)

The detached worker/TaskService runtime is legacy / experimental, retained for compatibility:

- `doctor` — preflight checks (IAB runtime, ChatGPT composer/login, codex CLI, git, state/log dirs, localhost IPC, context provider; prints chosen dataRoot + source).
- `start` — `TaskService.startTask({ goal, repoDir, conversation: 'new' })`. New conversation + persistent Codex thread. (Default mode = `new`.)
- `resume` — `TaskService.resumeTask({ taskId })` (or turn-sliced `advanceTask(taskId)` loop).
- `status` — `TaskService.getTaskStatus(taskId)`.
- `status:brain-command` — read-only check that the user-level launcher Skill is discoverable and the brain-command config exists/parses; prints `orchestratorRoot` / `dataRoot` / `workspaceRoot` and the defaults; never prints secrets; exit 0 healthy / 1 missing-or-invalid. `npm run status:brain-command` (`scripts/brain-command-status.mjs`).
- `cancel` — `TaskService.cancelTask(taskId)`.
- `adopt-current` — **EXPERIMENTAL** (`TaskService.adoptConversation`, `conversation:'current'`). Not a stable promise in this alpha because selected-tab identity is unstable across node-REPL invocations in the historical Codex Desktop / IAB environment.

## Protocol (Alpha.2/Alpha.3 released path)

- Structured protocol is the default: `PLAN` / `REPLAN` (Brain -> Orchestrator control/state, not forwarded to Codex), compact `TASK`, compact `RESULT`, plus the existing `REVISE` / `ASK_USER` / `PUBLISH` / `DONE`. The legacy text protocol remains a compatible fallback.
- Verification tiers: step / milestone / final, with authority precedence `mandatory orchestrator boundary > Brain requested level > Codex local minimum`.
- `PUBLISH` authorizes publication (publication gate + transaction + external observable readback). `DONE` is terminal and never authorizes publishing; after `DONE` no further control is valid.
- Governance prefers milestone-sized TASKs: PLAN comprehensively once, combine coherent implementation work, let Codex iterate inside one TASK, return to the Brain only at meaningful review/decision boundaries. After `DONE`, the target repo must not receive non-Brain-reviewed product changes.

## Runtime wiring (agent-side, legacy detached path)

The detached worker runtime runs an ordinary Node process; the IAB BrainSession runs in the node REPL. This is **legacy / experimental** and not the canonical v0.2 startup path. The agent:

1. starts the worker once (non-elevated, `--data-root <durable>`): `node scripts/codex-worker-host.mjs --repo <repoDir> --port 0 [--bypass] [--session <codexSessionId>] [--data-root <dir>] [--ready-file <file>]`.
2. reads the ready file for `{ port, token }`.
3. builds a TaskService whose runtime provides `makeDataStore` (worker-backed durable state), `openBrain`/`adoptBrain`/`reopenBrain`/`rebindBrain`, and `makeExecutor`.
4. drives `advanceTask` in a turn-sliced loop (each unit well under the node-REPL time cap) until DONE / ASK_USER / recovery_required.

No user-visible port/token/node-REPL details are exposed.

## Security / ownership

- Data root: worker owns a durable writable root (no elevation, no dangerous bypass). If none writable -> doctor FAIL with `CHATGPT_ORCHESTRATOR_DATA_ROOT` guidance.
- Secrets are redacted from logs/state; bearer token appears on the legacy codex child argv (local governor auth) — redacted but not removed.
- Never modifies other IAB tabs; an adopted user tab (when used) is not closed.

## Current development authority

For v0.2 implementation work, use these current sources rather than this released fallback guide:

- `PROJECT_STATUS.md` — current phase / blocker / next action;
- `ROADMAP.md` — accepted high-level path;
- `CAPABILITY_ROUTING.md` — normative routing/executor policy;
- `docs/architecture.md` — current technical architecture;
- `docs/rfc-v0.2-brain-continuity.md` — accepted Brain Continuity contract, implementation pending;
- GitHub current code / PR / CI — implementation truth.
