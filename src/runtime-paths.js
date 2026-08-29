// chatgpt-codex-orchestrator: unified runtime data root (Batch D1).
// All runtime data lives under a platform user-level dir, never in the target repo
// or in the orchestrator repo. The data root is resolved from the runtime environment
// adapter (normal process.env or the trusted REPL nodeRepl.env) so it works in both.
import os from 'node:os';
import path from 'node:path';
import { getEnv } from './runtime-env.js';

export function getDataRoot() {
  const env = getEnv();
  if (env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'chatgpt-codex-orchestrator');
  if (env.HOME) return path.join(env.HOME, '.chatgpt-codex-orchestrator');
  return path.join(os.homedir(), '.chatgpt-codex-orchestrator');
}

export const DEFAULT_DATA_ROOT = getDataRoot();

export function runtimePaths(dataRoot = DEFAULT_DATA_ROOT) {
  return {
    dataRoot,
    tasks: path.join(dataRoot, 'tasks'),
    logs: path.join(dataRoot, 'logs'),
    runtime: path.join(dataRoot, 'runtime'),
    projects: path.join(dataRoot, 'projects'),
    locks: path.join(dataRoot, 'locks'),
  };
}

// Deterministic worker ready-file path. The worker bootstrap and the IAB launcher MUST
// agree on exactly this path so the worker can be consumed without any manual path.
export function canonicalReadyFile(dataRoot = DEFAULT_DATA_ROOT) {
  return path.join(runtimePaths(dataRoot).runtime, 'brain-command.ready.json');
}
