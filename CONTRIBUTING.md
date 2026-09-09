# Contributing

Thanks for your interest in contributing to `chatgpt-codex-orchestrator`.

The project builds a **Capability Orchestrator with ChatGPT as the authoritative Brain**. ChatGPT owns investigation, architecture, routing, governance, independent verification, and final acceptance; Native capabilities, Direct Local, Codex, and future specialist executors perform bounded work.

The latest formal release is **`v0.1.0-alpha.3`**. The repository operational contract is now capability-first **v0.2**; this does **not** itself create a new tag/version/release. M0–M7, Brain Continuity, Direct Local canonical-path hardening, bounded mission continuation, Stable Runtime activation, and the explicit default-policy review are complete/accepted. Issue #33 / PR #45 materialized that authorized default policy in code/Skill/docs; M8/release remains separate. See [`PROJECT_STATUS.md`](PROJECT_STATUS.md).

Before you start, read:

- [`README.md`](README.md) — public overview;
- [`PROJECT_STATUS.md`](PROJECT_STATUS.md) — current phase and active gate;
- [`CAPABILITY_ROUTING.md`](CAPABILITY_ROUTING.md) — normative routing/executor policy;
- [`docs/architecture.md`](docs/architecture.md) — current technical architecture;
- [`docs/README.md`](docs/README.md) — documentation authority / historical RFC map.

## Before you start

- The project is Alpha; behavior can change between releases.
- Issues and PRs must distinguish the latest tagged **Alpha.3 compatibility boundary** from the current **capability-first v0.2 operational contract**.
- Historical RFCs are design evidence; do not assume their original “proposed/no implementation” status describes current `main`.
- New architecture should be driven by real evidence and dogfood, not by abstraction for its own sake.
- Prefer existing ChatGPT/OpenAI capabilities over reimplementing them locally.

## Development setup

Requires **Node.js `>= 22`**, Git, and an ESM project (`"type": "module"`). The test suite uses Node's built-in test runner.

```bash
git clone https://github.com/SIMON-WORLD/chatgpt-codex-orchestrator.git
cd chatgpt-codex-orchestrator
npm install
npm test
```

There is no separate build step for the baseline test suite.

## Making changes

- Keep changes focused. Avoid bundling unrelated refactors into a feature or fix PR.
- Preserve backward compatibility unless an accepted change explicitly requires otherwise.
- Update tests when behavior changes.
- Update documentation when user-visible behavior, limitations, commands, architecture, routing policy, or project status changes.
- Never commit secrets, tokens, runtime state, private conversation contents, or generated local artifacts.
- Do not claim executor success as final project acceptance without the required evidence/gates.
- Do not introduce a second writer for the same mutable resource without an explicit ownership design.

## Architecture and governance changes

When changing orchestration behavior, consider the current authority model:

- **ChatGPT Parent Brain** owns project-level architecture, routing, governance, `ACCEPT / REVISE / DONE`.
- **Executor RESULT** is evidence candidate, not Brain truth.
- Runtime capability discovery precedes routing; capability availability is not a permanent assumption.
- Native-first: do not route through Local MCP or Codex merely for architectural uniformity.
- Direct Local is for bounded local operations; Codex is for sustained local coding execution.
- `HYBRID` is composition, not an executor or mutation owner.
- Prefer milestone-sized delegation; the Parent should not micromanage every local edit/test command.

Canonical Governance controls are:

```text
PLAN / TASK / RESULT / REVISE / REPLAN / ASK_USER / PUBLISH / DONE
```

If your change touches persistence/recovery, also review [`docs/rfc-v0.2-brain-continuity.md`](docs/rfc-v0.2-brain-continuity.md). Current continuity requirements include fail-closed persistence, bounded semantic recovery, stale Parent fencing, single canonical Governance writer, no manual internal-ID relay, and isolated fault-injection dogfood.

## Alpha.3 release / compatibility boundary

The latest tagged release remains `v0.1.0-alpha.3`, but its feature-frozen IAB Direct Brain Loop is now an **explicit compatibility/fallback path only**. The repository operational default is capability-first v0.2, and capability/provider failure must never silently enter Alpha.3.

Legacy browser/worker code under `src/legacy/`, its tests, and Alpha.3 instructions are intentionally retained for compatibility. Do not delete them, and do not reactivate them as the normal path through an implicit fallback.

## Tests

The baseline verification command is:

```bash
npm test
```

- Run targeted tests during development where appropriate.
- Run the full `npm test` before opening a pull request.
- Add regression tests for bug fixes and tests for new behavior.
- Run additional real runtime/dogfood verification when the acceptance contract requires it; CI alone is not a substitute for runtime evidence when the feature is inherently runtime-dependent.

Do not assume lint, typecheck, or additional build commands exist unless they are defined in `package.json`.

## Documentation

Update the relevant docs when behavior changes:

- `README.md` and `README.en.md` for public-facing behavior; keep their substantive content in sync.
- `README.zh-CN.md` is only a compatibility redirect to the Chinese `README.md`.
- `PROJECT_STATUS.md` for accepted phase/gate changes.
- `ROADMAP.md` for accepted high-level path changes.
- `CAPABILITY_ROUTING.md` for normative routing/executor policy changes.
- `docs/architecture.md` for current architecture/runtime boundary changes.
- `docs/rfc-*` for evidence-backed design contracts/decisions; do not rewrite historical RFCs as though they were always current.
- `CHANGELOG.md` for release-relevant or meaningful unreleased changes.
- `SKILL.md` / `skills/brain-command/SKILL.md` when operational-default or release/compatibility boundaries change.

See [`docs/README.md`](docs/README.md) before modifying historical design documents.

## Pull requests

A good PR includes:

- a clear title and problem statement;
- the intended scope and non-goals;
- behavior / architecture / routing impact where relevant;
- acceptance criteria and real evidence;
- test/CI results;
- limitations and follow-up work;
- documentation/status updates when applicable.

No signed commits, DCO, CLA, conventional-commit format, issue-number linkage, or specific branch naming are currently required.

## Bug reports and feature requests

Use the GitHub issue templates under `.github/ISSUE_TEMPLATE/` where possible. Include the relevant runtime path/route and repository commit/version, because explicit Alpha.3 compatibility behavior and the v0.2 operational path are intentionally different.

## Security and sensitive information

Do not include credentials, bearer tokens, API keys, cookies, private repository data, private conversation contents, or local runtime secrets in issues or PRs. Redact sensitive logs before sharing.

There is currently no dedicated private vulnerability reporting channel. If you report a security concern through a public issue, describe the problem without posting secrets or exploit-sensitive private data.

## License

Contributions are submitted under the repository's [MIT License](LICENSE).
