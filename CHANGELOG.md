# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). For detailed engineering and development notes, see [Development History](docs/development-history.md).

## [Unreleased]

No documented unreleased changes yet. Work is listed under the release it first appears in.

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
