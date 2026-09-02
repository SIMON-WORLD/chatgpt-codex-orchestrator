// chatgpt-codex-orchestrator: bounded read-only git status/diff (v0.2 M2).
// Uses exact argv via child_process (never a shell) with bounded collection: a
// large diff is collected up to the cap and returned as truncated:true rather
// than failing solely because output exceeds the display cap.

import { spawn } from 'node:child_process';
import { WorkspaceError } from './workspace.js';

const MAX_OUTPUT = 200 * 1024;
const DIFF_MODES = ['worktree', 'staged'];

function gitCmd(registry, workspaceId, args, { maxOutput = MAX_OUTPUT } = {}) {
  const ws = registry.get(workspaceId);
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', ws.root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let size = 0;
    let output = '';
    let stderr = '';
    let truncated = false;
    child.stdout.on('data', (d) => {
      if (truncated) return;
      const remain = maxOutput - size;
      if (remain <= 0) { truncated = true; try { child.kill('SIGTERM'); } catch {} return; }
      // A single chunk larger than the remaining capacity contributes only the
      // remaining prefix (keep bytes, not dropped entirely).
      const keep = d.subarray(0, remain);
      output += keep.toString('utf8');
      size += keep.length;
      if (size >= maxOutput) { truncated = true; try { child.kill('SIGTERM'); } catch {} }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code, signal) => {
      // Termination BY OUR OWN output bound is a successful truncated result,
      // not a git failure.
      if (truncated) return resolve({ output, truncated });
      if (code !== 0) return reject(new WorkspaceError(`git failed: ${stderr.slice(0, 300)}`));
      resolve({ output, truncated });
    });
    child.on('error', (e) => reject(e));
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
  const args = mode === 'staged' ? ['diff', '--cached', '--no-ext-diff'] : ['diff', '--no-ext-diff'];
  const { output, truncated } = await gitCmd(registry, workspaceId, args);
  return { mode, diff: output, truncated };
}

export const GIT_DIFF_MODES = DIFF_MODES;
