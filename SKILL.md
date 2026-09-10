---
name: chatgpt-codex-orchestrator
description: "Compatibility entry for the ChatGPT-command orchestrator. Repository operational default = capability-first v0.2: discover current ChatGPT/runtime capability, prefer Native when sufficient, use Stable Runtime Direct Local for bounded local work, and use Codex only for sustained local coding when required. Formal release = v0.2.0; publication truth is authoritative from live GitHub tag/Release readback. Issue #46/M8 is CLOSED/DONE historical release-control evidence. Alpha.3 built-in-IAB Direct Brain Loop remains feature-frozen as an explicit compatibility/fallback path only, never a silent fallback."
---

# ChatGPT-command orchestrator (v0.2 release line)

The repository's operational contract is capability-first v0.2. The user supplies the goal; ChatGPT remains the authoritative Brain and routes work from actual runtime/session capability. `v0.2.0` is formally published; publication truth is determined by live GitHub tag/Release state rather than package/version prose.

> **Status boundary:** capability-first v0.2 is the repository operational default contract; Alpha.3/IAB is explicit feature-frozen compatibility only. M8 / Issue #46 is CLOSED / DONE and retained as historical release-control evidence, not a live release gate or current release authority. See GitHub current `main`/PR/CI/tag/Release, `CAPABILITY_ROUTING.md`, `PROJECT_STATUS.md`, `ROADMAP.md`, and active Issue/mission for current truth.

## Default: capability-first v0.2

The canonical launcher Skill is **`brain-command`**. Its normal path begins with **runtime capability discovery**: use `CHATGPT_NATIVE` when sufficient; when local capability is required, bind the Stable Runtime workspace and choose `CHATGPT_DIRECT_LOCAL` for bounded exact work or `CODEX_DELEGATE` for sustained coding. `HYBRID` composes these planes without becoming a mutation owner. See `skills/brain-command/SKILL.md` and `CAPABILITY_ROUTING.md`.

**Alpha.3 compatibility:** the retained Direct Brain Loop uses the Codex **in-app browser (iab) only** when explicitly selected. IAB unavailability or any current capability loss must not silently switch the v0.2 path into Alpha.3.

**Existing conversation:** `$brain-command --conversation "<title>"` / `--conversation-url <url>` / `--adopt-current` continue an existing ChatGPT conversation (no new conversation). By default a new dedicated Brain conversation is created.

## v0.2 operational default

The repository operational default is **capability-first v0.2**. Native capability is used directly when sufficient; the local capability plane is:

`ChatGPT (Custom MCP App)` → `OpenAI Secure Tunnel` → `local MCP` → `Router/Governance` → `Direct Local` or `Codex App Server`.

- **M5** completed the Secure Tunnel + real ChatGPT/Codex App Server production E2E.
- **M6** completed the structural isolation of the IAB / Alpha.4 implementation under `src/legacy/`.
- **M7** real-project capability-routing dogfood is **COMPLETE / ACCEPTED**: Native-only, Codex-required, and Hybrid paths passed.
- **Brain Continuity**, Direct Local canonical-path hardening, bounded execution claims, Stable Runtime activation, and the explicit operational-default policy review are **COMPLETE / ACCEPTED**.
- Issue #33 / PR #45 materialized the authorized v0.2 default flip. Issue #46 later completed the separately gated M8 publication transaction; `v0.2.0` is formally released and Issue #46 is now historical release-control evidence.
- The IAB path is **feature-frozen**, **not deleted**, and available only through explicit compatibility/fallback selection.

## Alpha.3 / legacy compatibility runtime (explicit opt-in only)

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
- Secrets are redacted from surfaced logs/state; the bearer token still exists on the legacy Codex child argv (local governor auth).
- Never modifies other IAB tabs; an adopted user tab (when used) is not closed.

## Release/operator boundary

For the v0.2 release line, use [`docs/releases/v0.2.0.md`](docs/releases/v0.2.0.md) for exact-revision Stable Runtime upgrade/rollback, Governance schema compatibility/recovery, Node support, and the historical gated publication-control contract. Formal `v0.2.0` publication is already complete and remains proven by live GitHub tag/Release readback. Do not hand-edit durable Governance JSON and do not treat a package version field as release proof.

## Current development authority

For a fresh session / replacement Brain, recover in this order:

`GitHub current main → CAPABILITY_ROUTING.md → PROJECT_STATUS.md → ROADMAP.md → active Issue/mission if any → runtime capability discovery → act or escalate`.

Use these sources rather than the legacy compatibility mechanics above:

- GitHub current `main` / code / PR / CI / tag / Release / active Issue — implementation/project/publication truth;
- `CAPABILITY_ROUTING.md` — current routing/executor/Parent-mission policy;
- `PROJECT_STATUS.md` — stable current status baseline;
- `ROADMAP.md` — accepted high-level path;
- `docs/architecture.md` — current technical architecture;
- `docs/rfc-v0.2-brain-continuity.md` — accepted Brain Continuity contract and historical design rationale; implementation + real dogfood are complete;
- `docs/releases/v0.2.0.md` — v0.2.0 release/operator and historical publication-control contract.

ChatGPT Project Instructions / Project Sources are downstream convenience mirrors, not live status databases or authority sources. Routine repository changes do not require manual mirror maintenance; when live GitHub capability is available, prefer current GitHub truth over stale mirrors.
