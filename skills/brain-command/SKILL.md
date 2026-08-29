---
name: brain-command
description: "Canonical launcher for the ChatGPT-command orchestrator (v0.1.0-alpha.2). Use when the user wants to run a coding task with ChatGPT as the planner/brain and Codex as the local executor, e.g. '用 ChatGPT 指挥模式完成...', '让 ChatGPT 指挥 Codex...', or 'Use ChatGPT as the brain and Codex as executor...'. Provider-neutral name; default Brain = ChatGPT, default Executor = Codex."
---

# brain-command (Alpha.2 launcher)

Provider-neutral launcher skill. Default: **Brain = ChatGPT**, **Executor = Codex**, **conversation = new**.

## When to use

Trigger on natural-language requests such as:

- `用 ChatGPT 指挥模式完成...`
- `让 ChatGPT 指挥 Codex...`
- `Use ChatGPT as the brain and Codex as executor...`
- any request to run a coding task where ChatGPT plans/reviews and Codex executes.

Do **not** trigger for ordinary local-only coding.

## Run (canonical normal path)

For a normal `$brain-command <goal>`, follow this deterministic sequence. **Do not
inspect or read the orchestrator's `bootstrap.js` / `runtime-host.mjs` /
`worker-host.mjs` source during normal startup** — the launcher does that wiring for
you. You only need the two fixed entrypoints below. The runtime environment is
abstracted by `src/runtime-env.js` (real `process` in normal Node; the safe
`nodeRepl` surface in the trusted Codex REPL), so you never create a `process` shim
and never pass `preflight: false`.

1. **Load config (always).** The user-scoped config is `$CODEX_HOME/brain-command/config.json`
   (`$CODEX_HOME` defaults to `~/.codex`). It defines `orchestratorRoot`, `dataRoot`,
   `workspaceRoot`, `defaultBrain`, `defaultExecutor`, `defaultConversationMode`.

2. **Start the worker (ordinary-node entrypoint).** Run the worker bootstrap in an
   ordinary Node process (via the environment, not the node REPL):

   ```
   node "<orchestratorRoot>/scripts/brain-command-worker.mjs" --config "<configPath>"
   ```

   Do **not** pass `--ready-file` or `--repo`. The worker resolves the repo + data root
   from config, runs the worker-side preflight (data-root writability, Codex executable,
   runtime dirs), and writes the deterministic ready file at
   `<config.dataRoot>/runtime/brain-command.ready.json`. Optional: `--bypass`,
   `--session <codexSessionId>`, `--port N`.

3. **Invoke the canonical launcher (IAB/REPL entrypoint).** In the Codex node REPL:

   ```js
   const { runBrainCommand } = await import('file:///<orchestratorRoot>/scripts/brain-command-launcher.mjs');
   const result = await runBrainCommand({ goal: '<goal>' });
   nodeRepl.write(JSON.stringify(result, null, 2));
   ```

   The launcher loads config, resolves the repo, probes the in-app-browser (IAB), reads
   the canonical worker ready file, opens the ChatGPT Brain, and drives
   `TaskService.createTask` → repeated `advanceTask` until `DONE` / `ASK_USER` /
   `recovery_required`. It binds the worker client to the generated `taskId` and shuts
   the worker down automatically on every terminal/error path. Returns
   `{ taskId, status, lastControl, rounds, conversationId, conversationUrl, ownedTabId, repoDir }`.
   No `process` shim, no `preflight:false`, no source inspection.

4. **Defaults.** `conversation = 'new'` is the default; `Brain = ChatGPT`, `Executor = Codex`.

No repo/skill discovery is required: config is read from the known path, the repo is
resolved deterministically, and the two entrypoints above are fixed.

## Setup / one-time install

From the orchestrator repository, run the one-time setup command:

```
npm run setup:brain-command
```

Optional overrides: `--orchestrator-root <dir> --data-root <dir> --workspace-root <dir>`.
It installs the Skill to `$HOME/.agents/skills/brain-command/SKILL.md` and writes
`$CODEX_HOME/brain-command/config.json`. Equivalent to calling `setupBrainCommand`
(see Developer section).

## Status check (read-only)

From the orchestrator repository, verify that brain-command is correctly installed and configured:

```
npm run status:brain-command
```

Read-only. It checks that the user-level launcher Skill is discoverable at
`$HOME/.agents/skills/brain-command/SKILL.md`, checks that `$CODEX_HOME/brain-command/config.json`
exists and parses, and prints `orchestratorRoot`, `dataRoot`, `workspaceRoot`, `defaultBrain`,
`defaultExecutor`, `defaultConversationMode`. Never prints secrets/tokens. Exit code is 0
when healthy, non-zero when config is missing/invalid. `--json` is available.

## Developer / troubleshooting (source + API)

Only needed when the normal path fails and you are diagnosing the install itself, or
when extending the launcher. Not part of normal startup.

- Bootstrap API (`src/bootstrap.js`): `loadBrainCommandConfig`, `resolveRepoDir`,
  `resolveOrchestratorRoot`, `fastPreflight`, `fullDoctor`, `setupBrainCommand`,
  `brainCommandStatus`. `fastPreflight` checks: install resolvable, repo resolvable,
  Codex executable available, data root writable, IAB/Brain transport callable.
- Runtime environment adapter (`src/runtime-env.js`): `getRuntimeEnv`, `getCwd`,
  `getEnv`, `getHomeDir`, `getCodexHome`, `isTrustedRepl`. Normal Node uses the real
  `process`; the trusted Codex REPL uses the safe `nodeRepl` surface (no `process`
  shim). `canonicalReadyFile()` lives in `src/runtime-paths.js`.
- `fullDoctor` is only for initial setup, environment change, fast-preflight failure,
  or an explicit request — not required on every task.
- Canonical launcher (`scripts/brain-command-launcher.mjs`): `runBrainCommand`,
  `buildRuntime`, `createDataStore`, `runTaskLoop` — all built on `TaskService`
  (`createTask` / `advanceTask`). It intentionally does **not** use the legacy
  `LoopController` / `runRuntimeHost` path.
- Worker bootstrap (`scripts/brain-command-worker.mjs`) → `startWorkerHost`
  (`scripts/codex-worker-host.mjs`). The worker owns all durable data
  (tasks / logs / projects / locks / runtime) under `config.dataRoot`.
- The legacy `runRuntimeHost` (`scripts/runtime-host.mjs`) remains available for
  compatibility / smoke tests only; it is NOT the canonical brain-command path.

## Scope boundaries (Alpha.2)

Do NOT implement: `adopt-current` stabilization, parallel executors, multiple Brain
providers, Brain Council, MCP context provider, GUI, cost ledger, remote runtime.
Default remains Brain=ChatGPT, Executor=Codex, conversation=new.
