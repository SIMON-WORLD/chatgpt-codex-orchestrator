# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). For detailed engineering and development notes, see [Development History](docs/development-history.md).

## [Unreleased]

The current unreleased line is **capability-first v0.2**. The v0.2 substrate, Brain Continuity, Direct Local hardening, bounded mission continuation, Stable Runtime activation, and default-policy review are already accepted on `main`; Issue #33 materializes the authorized repository operational-default flip in the current candidate. This does **not** version-bump, tag, or formally release v0.2. The latest formal release remains `v0.1.0-alpha.3`.

### Added

- Capability-first routing model with four top-level routes: `CHATGPT_NATIVE`, `CHATGPT_DIRECT_LOCAL`, `CODEX_DELEGATE`, and `HYBRID`.
- Local Capability Plane: Custom MCP App / Secure Tunnel / Local MCP integration for workspace-scoped local capability.
- Direct Local read/search/git status/diff, bounded change-set editing, sensitive-path checks, and allowlisted verification.
- Codex App Server executor with structured job/thread/turn lifecycle, approvals, reconciliation, permission verification, and workspace-scoped mutation ownership.
- Deterministic Router + canonical Governance service with `PLAN / TASK / RESULT / REVISE / REPLAN / ASK_USER / PUBLISH / DONE` semantics and explicit executor/machine/Brain acceptance separation.
- v0.2 production runtime entry (`npm run start:v0.2`) and local/App Server smoke/E2E scripts.
- M7-C durable Codex orchestration binding (`taskId / stepId / identity`) plus bounded `codex_recover`: unique-match recovery only; `not_found / ambiguous / wrong_workspace / stale` fail closed; no most-recent guessing or generic force unlock.
- Brain Continuity contract and implementation: durable Governance, bounded Parent re-entry, authority fencing, Context Capsule semantics, capability freshness, single canonical Governance writer, and isolated restart/re-entry dogfood.
- Read-only brain-command status check: `npm run status:brain-command` (`scripts/brain-command-status.mjs` → `brainCommandStatus`). Verifies the user-level launcher Skill is discoverable and `$CODEX_HOME/brain-command/config.json` exists/parses, prints safe configuration fields, never prints secrets, and returns exit 0 healthy / 1 missing-or-invalid.
- Durable new-task admission gate (Issue #29): a genuinely new `PLAN` on a fresh/restarted durable Governance runtime scans the durable namespace first; non-terminal ambiguity/recovery requirements fail closed.
- Task-scoped mutation authorization (Issue #29): selectors are not authority; local/Codex mutations validate durable Governance scope and authority while already-authorized running execution survives bounded recovery/reconciliation.
- Narrow bounded worktree bootstrap primitive (Issue #29): `worktree_create(repo, targetPath, branch, startPoint)` with strict trust-root containment and no generic shell/repo manager/scheduler.
- Stable Runtime exact-revision activation bootstrap (Issue #36).
- Bounded current-step execution continuation claim separated from Parent control authority (Issue #34).

### Changed

- The repository operational contract is capability-first: ChatGPT is the authoritative Brain; runtime capability discovery precedes routing; Native capabilities are reused when sufficient; Codex is a sustained local coding executor rather than the default downstream for every task.
- Issue #33 makes `v0.2` the effective `brain-command` runtime family by default, keeps `alpha3` as an explicit compatibility opt-in, and fails closed rather than silently routing capability/provider failure into the legacy IAB path.
- The Alpha.3/Alpha.4 IAB implementation remains structurally isolated under `src/legacy/` and feature-frozen as an explicit compatibility/fallback path.
- M7 real-project routing dogfood, Brain Continuity implementation/re-entry dogfood, Direct Local canonical-path hardening, bounded mission continuation, Stable Runtime activation, and the explicit default-policy review are complete and accepted.

### Not released yet

- Issue #33 still requires its own exact-candidate PR/CI and project-level Parent independent acceptance before merge; the implementation mission does not self-accept the project default decision.
- No `v0.2` version bump, tag, formal release, or M8 transition has occurred.
- The last tagged Alpha.3 release remains available only as the explicit feature-frozen compatibility boundary after the operational-default change.

## [0.1.0-alpha.3]

Alpha.3 — Direct Brain Loop dogfood baseline. The default `$brain-command` path in that tagged release is the Direct Brain Loop: the current Codex agent talks to ChatGPT through the Codex in-app browser (`iab`) only, executes each milestone-sized Brain TASK itself, sends a compact RESULT back to the same conversation, and publishes on DONE after the publish gate. Existing-conversation adoption, composer fail-closed safety, publish identity preflight, and the post-DONE boundary are part of the frozen baseline. The detached worker / TaskService / nested-Codex runtime is retained as experimental, not the default for that release.

### Added

- Direct Brain Loop (Alpha.3 release default): current Codex agent ↔ ChatGPT via the Codex in-app browser (`iab`).
- Existing ChatGPT conversation adoption and fail-closed identity/composer safety.
- Milestone-sized Brain TASK governance and publish identity preflight.
- Browser isolation: IAB only, no Edge/Chrome fallback.

### Changed

- Detached worker runtime became legacy / experimental.
- Version bumped to `0.1.0-alpha.3`.

## [0.1.0-alpha.2]

Alpha.2 — Delta Packets + Fast Bootstrap. Adds the canonical `brain-command` launcher, deterministic bootstrap fast path, compact-by-default delta packets, tiered verification, and orchestrator-owned completed-step compaction.

### Added

- `brain-command` canonical launcher Skill.
- `src/bootstrap.js` user-scoped config resolution and deterministic repo resolution.
- Delta packet protocol and verification tiers.
- User-runnable setup entrypoint: `npm run setup:brain-command`.

### Changed

- Normal Step Packets carry only RFC delta fields.
- Version bumped to `0.1.0-alpha.2`.

## [0.1.0-alpha.1]

The initial public alpha baseline, used internally as a dogfood build of the durable ChatGPT-command orchestration loop.

### Added

- Durable ChatGPT → Codex orchestration loop.
- Brain control loop and structured acceptance/evidence gate.
- Durable task state and recovery support.
- Brain project binding / profile support.

### Experimental

- `conversation: 'current'` / `adopt-current` retained without a stability promise.

---

For detailed historical engineering notes, see [Development History](docs/development-history.md).
