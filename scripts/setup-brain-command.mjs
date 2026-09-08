// chatgpt-codex-orchestrator: one-time brain-command setup CLI (Alpha.2 packaging).
// Installs the launcher Skill to $HOME/.agents/skills/brain-command/SKILL.md and
// creates/updates $CODEX_HOME/brain-command/config.json. Deterministically resolves
// the three roots; accepts explicit CLI overrides. One-time only — normal task
// startup never reruns this (it only reads the config).
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupBrainCommand } from '../src/bootstrap.js';
import { getDataRoot } from '../src/runtime-paths.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

// User-scoped machine paths: explicit arg wins, else env, else deterministic default.
const codexHome = arg('--codex-home') || process.env.CODEX_HOME || undefined;
const home = arg('--home') || process.env.HOME || process.env.USERPROFILE || os.homedir();
const orchestratorRoot = arg('--orchestrator-root') || repoRoot;                                   // the orchestrator install location
const dataRoot = arg('--data-root') || process.env.CHATGPT_ORCHESTRATOR_DATA_ROOT || getDataRoot(); // durable task data root
const workspaceRoot = arg('--workspace-root') || process.cwd();                                     // the target repo for tasks

const config = {
  orchestratorRoot,
  dataRoot,
  workspaceRoot,
  defaultBrain: 'chatgpt',
  defaultExecutor: 'codex',
  defaultConversationMode: 'new',
  // Operational default (Issue #33): capability-first v0.2 / Stable Runtime.
  // Alpha.3 legacy IAB is only an explicit opt-in compatibility fallback
  // (config.defaultRuntime='alpha3' and/or BRAIN_COMMAND_LEGACY=1).
  defaultRuntime: 'v0.2',
};

const res = setupBrainCommand({ codexHome, home, config });

console.log('brain-command setup complete.');
console.log('  installed skill: ' + res.skillPath);
console.log('  config file:     ' + res.configPath);
console.log('  orchestratorRoot:' + config.orchestratorRoot);
console.log('  dataRoot:        ' + config.dataRoot);
console.log('  workspaceRoot:   ' + config.workspaceRoot);
const runtime = res.config && res.config.defaultRuntime ? res.config.defaultRuntime : 'v0.2';
console.log('  defaults:        brain=chatgpt executor=codex conversation=new runtime=' + runtime + ' (v0.2 capability-first; Alpha.3 legacy IAB = explicit opt-in)');
