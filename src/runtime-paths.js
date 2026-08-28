// chatgpt-codex-orchestrator: unified runtime data root (Batch D1).
// All runtime data lives under a platform user-level dir, never in the target repo
// or in the orchestrator repo.
import os from 'node:os';
import path from 'node:path';

export function getDataRoot() {
  if (typeof process !== 'undefined' && process.env) {
    if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'chatgpt-codex-orchestrator');
    if (process.env.HOME) return path.join(process.env.HOME, '.chatgpt-codex-orchestrator');
  }
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