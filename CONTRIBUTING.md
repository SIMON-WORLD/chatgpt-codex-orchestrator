# Contributing

Thanks for your interest in contributing to `chatgpt-codex-orchestrator`. This is a small, focused project that keeps **ChatGPT as the planner/reviewer** and **Codex as the local executor** in a durable, recoverable loop. It is currently **Alpha** (`v0.1.0-alpha.1`).

Before you start, read [`README.md`](README.md) for the public overview and [`docs/architecture.md`](docs/architecture.md) for the current architecture and boundaries.

## Before you start

- The project is Alpha; behavior can change between releases.
- Please read `README.md` and `docs/architecture.md` to understand current behavior and boundaries.
- Issues and PRs should not assume roadmap features already exist.

## Development setup

Requires **Node.js `>= 18`** and an ESM project (`"type": "module"`). The existing tests use Node's built-in test runner.

```bash
git clone https://github.com/SIMON-WORLD/chatgpt-codex-orchestrator.git
cd chatgpt-codex-orchestrator
npm install
npm test
```

There is no separate build step for the test suite.

## Making changes

- Keep changes focused. Avoid bundling unrelated refactors into a feature or fix PR.
- Preserve the public API and backward compatibility unless the change explicitly requires otherwise.
- Update tests when behavior changes.
- Update documentation when user-visible behavior, limitations, commands, or architecture change.
- Never commit secrets, tokens, runtime state, or generated local artifacts.

## Architecture and protocol changes

Because this is an orchestrator, if you change orchestration behavior, consider:

- The ChatGPT planner/reviewer vs Codex executor ownership boundary.
- The `TASK` / `REVISE` / `ASK_USER` / `DONE` protocol behavior.
- The acceptance/evidence gating semantics.
- Durable Task State and recovery behavior.
- The supported (`conversation: 'new'`) vs experimental (`conversation: 'current'` / `adopt-current`) conversation modes.
- Secret redaction and runtime/process-boundary implications.

See [`docs/architecture.md`](docs/architecture.md) rather than reproducing the full architecture here.

## Tests

The baseline verification command is:

```bash
npm test
```

- Run targeted tests during development where appropriate.
- Run the full `npm test` before opening a pull request.
- Add regression tests for bug fixes and tests for new behavior.

Do not assume lint, typecheck, or additional build commands exist unless they are defined in `package.json`.

## Documentation

Update the relevant docs when behavior changes:

- `README.md` and `README.zh-CN.md` for public-facing behavior (keep the two in sync).
- `docs/architecture.md` for current architecture or protocol changes.
- `CHANGELOG.md` for release-relevant changes.
- `SKILL.md` when user-facing operational instructions change.

Preserve bilingual parity when editing homepage content.

## Pull requests

A good PR includes:

- A clear title and description.
- An explanation of the problem and the change.
- The behavior/architecture impact, where relevant.
- Test evidence.
- Any limitations or follow-up work.
- A reviewable, focused scope.

No signed commits, DCO, CLA, conventional-commit format, issue-number linkage, or specific branch naming are required.

## Bug reports and feature requests

When filing an issue, use the relevant GitHub issue template when available. Templates are provided under `.github/ISSUE_TEMPLATE/` as part of the contribution infrastructure.

## Security and sensitive information

Please do not include credentials, bearer tokens, API keys, cookies, or private conversation contents in issues or pull requests. Redact sensitive logs before sharing. There is no dedicated private vulnerability reporting channel at this time; if you find a security concern, raise it through the normal issue process without posting secrets.

## License

Contributions are submitted under the repository's [MIT License](LICENSE).
