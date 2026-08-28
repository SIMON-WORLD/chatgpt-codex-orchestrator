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

## Bootstrap (fast, deterministic)

The orchestrator repo exposes `src/bootstrap.js`. Normal startup must NOT do broad
filesystem discovery, search for old bridge/router skills, or rediscover the
orchestrator installation. It reads the user-scoped config directly.

1. Resolve the user-scoped config:

   ```js
   import { loadBrainCommandConfig, fastPreflight, fullDoctor } from '<orchestrator-root>/src/bootstrap.js';
   const config = loadBrainCommandConfig(); // reads $CODEX_HOME/brain-command/config.json
   ```

   `$CODEX_HOME` defaults to `~/.codex`. The config defines at least:
   `orchestratorRoot`, `dataRoot`, `workspaceRoot`, `defaultBrain='chatgpt'`,
   `defaultExecutor='codex'`, `defaultConversationMode='new'`.

2. If config is **absent / invalid / points at an unavailable install**:
   - Do **not** perform broad discovery.
   - Fail fast into setup / full-doctor guidance: `fullDoctor({ config })`.

3. Run the **fast preflight** (every task):

   ```js
   const pre = fastPreflight({ config });
   if (!pre.pass) { /* fall back to full doctor / setup */ }
   ```

   Fast preflight checks: orchestrator install resolvable, repo resolvable,
   Codex executable available, durable data root available, IAB/Brain transport callable.

4. Resolve the repo deterministically:

   ```js
   import { resolveRepoDir } from '<orchestrator-root>/src/bootstrap.js';
   const r = resolveRepoDir({ cwd: process.cwd(), explicitRepoPath, explicitGitHubRepo, config });
   ```

5. Start the orchestrator via `TaskService.startTask` (defaults: Brain=ChatGPT,
   Executor=Codex, conversation='new'). See the orchestrator `SKILL.md` for the
   worker / Brain wiring.

## Setup / one-time install

From the orchestrator repository, run the one-time setup command:

```
npm run setup:brain-command
```

Optional overrides: `--orchestrator-root <dir> --data-root <dir> --workspace-root <dir>`. It installs the Skill to `$HOME/.agents/skills/brain-command/SKILL.md` and writes `$CODEX_HOME/brain-command/config.json`. Equivalent to calling `setupBrainCommand` (see below).



Install the launcher Skill and write the user-scoped bootstrap config once (does NOT
run on every task; normal execution only reads config):

```js
import { setupBrainCommand } from '<orchestrator-root>/src/bootstrap.js';
setupBrainCommand({
  codexHome: process.env.CODEX_HOME, // optional; defaults to ~/.codex
  config: {
    orchestratorRoot: '<orchestrator-root>',
    dataRoot: '<durable-data-root>',
    workspaceRoot: '<workspace-root>',
    defaultBrain: 'chatgpt',
    defaultExecutor: 'codex',
    defaultConversationMode: 'new',
  },
});
```

This installs `$HOME/.agents/skills/brain-command/SKILL.md` (the canonical user Skill root) and creates/updates
`$CODEX_HOME/brain-command/config.json`, preserving machine-local paths. Use an
isolated `CODEX_HOME` when testing; the real user config is only written by setup.

## Full doctor

`fullDoctor` is used only for: initial setup, version/environment change,
fast-preflight failure, or an explicit user request. It is NOT required on every task.

## Scope boundaries (Alpha.2)

Do NOT implement: `adopt-current` stabilization, parallel executors, multiple Brain
providers, Brain Council, MCP context provider, GUI, cost ledger, remote runtime.
Default remains Brain=ChatGPT, Executor=Codex, conversation=new.
