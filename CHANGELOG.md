# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). For detailed engineering and development notes, see [Development History](docs/development-history.md).

## [Unreleased]

No documented unreleased changes yet. Work is listed under the release it first appears in.
### Added

- Read-only brain-command status check: `npm run status:brain-command` (scripts/brain-command-status.mjs → `brainCommandStatus`). Verifies the user-level launcher Skill is discoverable and `$CODEX_HOME/brain-command/config.json` exists/parses, prints `orchestratorRoot` / `dataRoot` / `workspaceRoot` and the defaults, never prints secrets, and returns exit 0 (healthy) or 1 (missing/invalid). Does not change any orchestration core semantics.
## [0.1.0-alpha.3]

Alpha.3 — Direct Brain Loop dogfood baseline. The default `$brain-command` path is the Direct Brain Loop: the current Codex agent talks to ChatGPT through the Codex in-app browser (`iab`) only, executes each milestone-sized Brain TASK itself, sends a compact RESULT back to the same conversation, and publishes on DONE after the publish gate. Existing-conversation adoption (by title / URL / `--adopt-current`), composer fail-closed safety, publish identity preflight, and the post-DONE boundary are part of the frozen baseline. The detached worker / TaskService / nested-Codex runtime is retained as experimental, not the default.

### Added

- Direct Brain Loop (default): current Codex agent ↔ ChatGPT via the Codex in-app browser (`iab`); the current Codex agent is the executor.
- Existing ChatGPT conversation adoption: `adoptConversation({ conversationUrl | conversationId | title })` and `adoptCurrent()`; title lookup by accessible name/text/ARIA + stable `a[href*="/c/"]`; unique match opens, no-match fails without creating a conversation, duplicate returns ambiguity/ASK_USER; real `/c/<id>` captured and bound.
- Composer safety: `resolveComposer` targets only the real composer (`#prompt-textarea` / composer-scoped contenteditable), fails closed (`ComposerUnavailableError`) instead of targeting a historical editable block, and never modifies history.
- Milestone-sized Brain TASK governance in the takeover/governance prompt.
- Publish identity preflight (`src/publish-policy.js`): configures repo-local git identity before commit only when an expected `name`/`email` is configured; default no-force-push / no-history-rewrite.
- Post-DONE boundary: after `DONE` the target repo must not receive non-Brain-reviewed product changes.
- Browser isolation: `InAppBrowserTransport.connect()` requires the `iab` browser and fails clearly (`IABUnavailableError`) without falling back to `getForUrl`/Edge/Chrome.

### Changed

- Default path removed from the detached worker runtime; worker/TaskService/nested-Codex + durable recovery are marked legacy / experimental (comments + docs).
- Version bumped to `0.1.0-alpha.3`.


## [0.1.0-alpha.2]

Alpha.2 — Delta Packets + Fast Bootstrap. Adds the canonical `brain-command` launcher, a deterministic bootstrap fast path, compact-by-default delta packets, tiered verification, and orchestrator-owned completed-step compaction. The structured protocol is the runtime default; the legacy text protocol remains a compatible fallback.

### Added

- `brain-command` canonical launcher Skill (provider-neutral by name; default Brain = ChatGPT, Executor = Codex, conversation = new).
- `src/bootstrap.js`: user-scoped config resolution (`$CODEX_HOME/brain-command/config.json`), deterministic repo resolution, fast preflight, full doctor, dogfood metrics. No broad filesystem discovery on normal startup.
- Delta packet protocol: `PLAN` / `REPLAN` control tokens (Brain → Orchestrator state/control operations, not forwarded to Codex), plus compact `TASK` / compact `RESULT`.
- `src/verification.js`: step / milestone / final tiers, authority precedence (mandatory orchestrator boundary > Brain requested level > Codex local minimum), and repository-specific verification commands from the Project Profile / policy.
- Durable state additions (schemaVersion stays v1): `taskContract`, `repoContext`, `projectProfileRef`, `plan`, `currentStepId`, `verificationPolicy`, `stepSummaries`, `evidenceLedger`, `unresolvedRisks` — via load-time `hydrateTaskState`.
- Append-only `evidenceLedger` for real structured evidence; `acceptanceRegistry` remains the compatibility/status projection used by the DONE gate.
- Deterministic compaction: when a step reaches `reviewed`, the orchestrator writes a compact durable `stepSummary` (preserving acceptance outcome, evidence references, unresolved risks, and `completedSteps` idempotency).
- User-runnable setup entrypoint: `npm run setup:brain-command` (scripts/setup-brain-command.mjs). One-time install to `$HOME/.agents/skills/brain-command/SKILL.md` + `$CODEX_HOME/brain-command/config.json`; no Node REPL import required; normal startup never reruns it.
- Escalation: after 2 failed `REVISE` attempts on the same step, the engine can switch a compact `TASK` to the fuller contract packet.
- Canonical PLAN step identity: when a `PLAN` exists, the plan `stepId` (and its declared milestone) is the canonical identity for `TASK` / `REVISE` / `RESULT` / `evidenceLedger` / `currentStepId` / `reviewed` / `completedSteps` / `stepSummaries`. An unresolvable planned step or missing declared milestone raises a deterministic `ProtocolError`; legacy no-PLAN tasks keep `step-N` ids.
- Operational verification: the orchestrator resolves the effective level per boundary and injects only the relevant commands into the Codex prompt; mandatory milestone/final boundaries REQUIRE executable configured commands and raise a deterministic `VerificationPolicyError` when they have none. `DONE` cannot pass while a mandatory boundary is incomplete.
- brain-command setup loop: one-time `setupBrainCommand` installs the launcher Skill to the canonical `$HOME/.agents/skills/brain-command/SKILL.md` and writes config at `$CODEX_HOME/brain-command/config.json`; normal execution never reinstalls. The deprecated `$CODEX_HOME/skills` location is only a backward-compatible fallback.
- Broad-discovery telemetry: `broadDiscoveryOccurred` is meaningful — the fast path reports `false` and never invokes a broad search; an explicit setup/fallback helper marks `true`.

### Changed

- Normal Step Packets carry only the RFC delta fields; stable project facts are no longer re-stated per turn.
- Compact `RESULT` uses `changed` + `evidence` (+ optional `summary`) with no separate `tests` field; legacy `filesChanged`/`tests` inputs still parse.
- Version bumped to `0.1.0-alpha.2`.

## [0.1.0-alpha.1]

The initial public alpha baseline, used internally as a "dogfood" build of the durable ChatGPT-command orchestration loop.

### Added

- Durable ChatGPT → Codex orchestration loop: ChatGPT plans/reviews, Codex executes.
- Brain control loop: `TASK` / `REVISE` / `ASK_USER` / `DONE`.
- Structured acceptance/evidence gate: on `DONE`, each required acceptance must have real `pass` evidence, never inferred from the Codex exit code alone.
- Durable task state (schema v1) with turn-sliced advancement.
- Persistent Codex worker/thread integration (the same thread is reused across turns).
- Resume / recovery support for crash-safe continuation.
- Crash-safe per-task lock (owner pid + heartbeat; stale locks reclaimed).
- Brain project binding / profile support (`bindProject` / `getProjectBinding`).
- `PacketContextProvider`: bounded, secret-redacted repository context.
- `doctor` diagnostics and safe defaults (no dangerous bypass by default).

### Experimental

- `conversation: 'current'` / `adopt-current`: retained, but not a stability promise in this alpha, because selected-tab identity is unstable across node-REPL invocations in the current Codex Desktop / IAB environment.

---

For detailed historical engineering notes (M1/M2/M2.1, Batch A–C, crash-safe gates, and live E2E evidence), see [Development History](docs/development-history.md).
