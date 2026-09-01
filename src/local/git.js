// chatgpt-codex-orchestrator: bounded read-only git status/diff (v0.2 M2).
// Uses exact argv via child_process (never a shell). Only a small explicit mode
// set is allowed: worktree | staged. No arbitrary revision/string injection.

import { execFile } from 'node:child_process';
import { WorkspaceError } from './workspace.js';

const MAX_OUTPUT = 200 * 1024;
const DIFF_MODES = ['worktree', 'staged'];

function gitCmd(registry, workspaceId, args, { maxOutput = MAX_OUTPUT } = {}) {
  const ws = registry.get(workspaceId);
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', ws.root, ...args], { encoding: 'utf8', maxBuffer: maxOutput + 1024, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').slice(0, 300);
        return reject(new WorkspaceError(`git failed: ${msg}`));
      }
      const truncated = Buffer.byteLength(stdout, 'utf8') > maxOutput;
      resolve({ output: stdout.slice(0, maxOutput), truncated });
    });
  });
}

export async function gitStatus({ workspaceId } = {}, registry) {
  const ws = registry.get(workspaceId);
  if (!ws.isGitRepo) throw new WorkspaceError('workspace is not a git repository');
  const { output, truncated } = await gitCmd(registry, workspaceId, ['status', '--short', '--branch']);
  return { status: output.trim(), truncated };
}

export async function gitDiff({ workspaceId, mode = 'worktree' } = {}, registry) {
  const ws = registry.get(workspaceId);
  if (!ws.isGitRepo) throw new WorkspaceError('workspace is not a git repository');
  if (!DIFF_MODES.includes(mode)) throw new WorkspaceError(`unsupported git diff mode: ${mode}`);
  const args = mode === 'staged'
    ? ['diff', '--cached', '--no-ext-diff']
    : ['diff', '--no-ext-diff'];
  const { output, truncated } = await gitCmd(registry, workspaceId, args);
  return { mode, diff: output, truncated };
}

export const GIT_DIFF_MODES = DIFF_MODES;
