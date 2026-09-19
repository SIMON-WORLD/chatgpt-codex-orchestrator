// chatgpt-codex-orchestrator: bounded read-only git status/diff (v0.2 M2).
// Parent validates repository/mode; execution is exclusively delegated through
// the pinned DesktopCommander child fixed-command adapter.

import fs from 'node:fs';
import { WorkspaceError } from './workspace.js';

const MAX_OUTPUT = 200 * 1024;
const DIFF_MODES = ['worktree', 'staged'];

async function gitThroughChild(child, workspaceRoot, mode) {
  if (typeof child?.runGit !== 'function') throw new WorkspaceError('desktop commander child adapter is required');
  try {
    const result = await child.runGit({ workspaceRoot: fs.realpathSync.native(workspaceRoot), mode });
    const output = typeof result === 'string' ? result : result?.output;
    if (typeof output !== 'string') throw new WorkspaceError('desktop commander git returned no output');
    const bytes = Buffer.from(output, 'utf8');
    return {
      output: bytes.length > MAX_OUTPUT ? bytes.subarray(0, MAX_OUTPUT).toString('utf8') : output,
      truncated: !!(result && typeof result === 'object' && result.truncated) || bytes.length > MAX_OUTPUT,
    };
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError('desktop commander git operation failed');
  }
}

export async function gitStatus({ workspaceId } = {}, registry, { child = null } = {}) {
  const ws = registry.get(workspaceId);
  if (!ws.isGitRepo) throw new WorkspaceError('workspace is not a git repository');
  const result = await gitThroughChild(child, ws.root, 'status');
  return { status: result.output.trim(), truncated: result.truncated };
}

export async function gitDiff({ workspaceId, mode = 'worktree' } = {}, registry, { child = null } = {}) {
  const ws = registry.get(workspaceId);
  if (!ws.isGitRepo) throw new WorkspaceError('workspace is not a git repository');
  if (!DIFF_MODES.includes(mode)) throw new WorkspaceError(`unsupported git diff mode: ${mode}`);
  const result = await gitThroughChild(child, ws.root, mode);
  return { mode, diff: result.output, truncated: result.truncated };
}

export const GIT_DIFF_MODES = DIFF_MODES;
