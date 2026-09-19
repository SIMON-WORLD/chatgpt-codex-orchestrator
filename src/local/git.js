// chatgpt-codex-orchestrator: bounded read-only git status/diff (v0.2 M2).
// Uses exact argv via child_process (never a shell) for the legacy direct
// helper. The MCP server may inject the DesktopCommander child after the
// workspace/repository/mode checks below have completed.

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { WorkspaceError } from './workspace.js';
import { extractTextContent, fixedGitCommand } from './desktop-commander-child.js';

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
      const keep = d.subarray(0, remain);
      output += keep.toString('utf8');
      size += keep.length;
      if (size >= maxOutput) { truncated = true; try { child.kill('SIGTERM'); } catch {} }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      if (truncated) return resolve({ output, truncated });
      if (code !== 0) return reject(new WorkspaceError(`git failed: ${stderr.slice(0, 300)}`));
      resolve({ output, truncated });
    });
    child.on('error', (e) => reject(e));
  });
}

async function gitThroughChild(child, workspaceRoot, mode) {
  if (!child) throw new WorkspaceError('desktop commander child adapter is unavailable');
  try {
    if (typeof child.runGit === 'function') {
      const result = await child.runGit({ workspaceRoot: fs.realpathSync.native(workspaceRoot), mode });
      const output = typeof result === 'string' ? result : result?.output;
      if (typeof output !== 'string') throw new WorkspaceError('desktop commander git returned no output');
      return { output, truncated: !!(result && typeof result === 'object' && result.truncated) };
    }
    if (typeof child.callTool !== 'function') throw new WorkspaceError('desktop commander child adapter is unavailable');
    const canonicalRoot = fs.realpathSync.native(workspaceRoot);
    const textOf = (result) => typeof result === 'string' ? result : extractTextContent(result);
    const started = textOf(await child.callTool('start_process', {
      command: fixedGitCommand(canonicalRoot, mode),
      timeout_ms: 5000,
      shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
      origin: 'llm',
    }));
    const pidMatch = started.match(/\bPID\s+(\d+)/i);
    const pid = pidMatch ? Number(pidMatch[1]) : null;
    let text = started;
    let output = started.replace(/^[\s\S]*?Initial output:\s*\n?/i, '');
    for (let attempt = 0; attempt < 8 && pid && !/Process completed with exit code\s+-?\d+/i.test(text); attempt += 1) {
      const next = textOf(await child.callTool('read_process_output', { pid, offset: 0, length: 5000, timeout_ms: 1000 }));
      text = next;
      if (!/^\(No output in requested range\)$/i.test(next.trim())) output = next.replace(/^\[Reading [^\n]*\]\s*\n\s*/i, '');
      if (/Process completed with exit code\s+-?\d+/i.test(text) || !/Process is running|Process still running/i.test(text)) break;
    }
    const exit = text.match(/Process completed with exit code\s+(-?\d+)/i);
    if (pid && !exit && /Process is running|Process still running/i.test(text)) {
      try { await child.callTool('force_terminate', { pid }); } catch {}
      throw new WorkspaceError('desktop commander git operation timed out');
    }
    if (exit && Number(exit[1]) !== 0) throw new WorkspaceError('desktop commander git operation failed');
    output = output.replace(/\n?\s*(?:⏳\s*)?Process is running\.?.*$/is, '');
    output = output.replace(/\n?\s*✅?\s*Process completed with exit code\s+-?\d+[^\n]*$/i, '');
    const bytes = Buffer.from(output, 'utf8');
    return { output: bytes.length > MAX_OUTPUT ? bytes.subarray(0, MAX_OUTPUT).toString('utf8') : output, truncated: bytes.length > MAX_OUTPUT };
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError('desktop commander git operation failed');
  }
}

export async function gitStatus({ workspaceId } = {}, registry, { child = null } = {}) {
  const ws = registry.get(workspaceId);
  if (!ws.isGitRepo) throw new WorkspaceError('workspace is not a git repository');
  const result = child
    ? await gitThroughChild(child, ws.root, 'status')
    : await gitCmd(registry, workspaceId, ['status', '--short', '--branch']);
  return { status: result.output.trim(), truncated: result.truncated };
}

export async function gitDiff({ workspaceId, mode = 'worktree' } = {}, registry, { child = null } = {}) {
  const ws = registry.get(workspaceId);
  if (!ws.isGitRepo) throw new WorkspaceError('workspace is not a git repository');
  if (!DIFF_MODES.includes(mode)) throw new WorkspaceError(`unsupported git diff mode: ${mode}`);
  const result = child
    ? await gitThroughChild(child, ws.root, mode)
    : await gitCmd(registry, workspaceId, mode === 'staged' ? ['diff', '--cached', '--no-ext-diff'] : ['diff', '--no-ext-diff']);
  return { mode, diff: result.output, truncated: result.truncated };
}

export const GIT_DIFF_MODES = DIFF_MODES;
