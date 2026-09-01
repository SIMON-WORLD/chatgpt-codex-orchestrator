import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { WorkspaceRegistry, WorkspaceError } from '../../src/local/workspace.js';
import { gitStatus, gitDiff } from '../../src/local/git.js';

function makeGit() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n', 'utf8');
  execFileSync('git', ['add', 'a.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n', 'utf8'); // untracked/worktree change
  execFileSync('git', ['add', 'b.txt'], { cwd: repo });         // staged
  const reg = new WorkspaceRegistry({ allowedRoots: [root] });
  const ws = reg.open({ path: repo });
  return { reg, ws };
}

test('git_status works', async () => {
  const { reg, ws } = makeGit();
  const r = await gitStatus({ workspaceId: ws.workspaceId }, reg);
  assert.ok(r.status.includes('b.txt'));
});

test('git_diff worktree works', async () => {
  const { reg, ws } = makeGit();
  const r = await gitDiff({ workspaceId: ws.workspaceId, mode: 'worktree' }, reg);
  assert.ok(typeof r.diff === 'string');
});

test('git_diff staged works', async () => {
  const { reg, ws } = makeGit();
  const r = await gitDiff({ workspaceId: ws.workspaceId, mode: 'staged' }, reg);
  assert.ok(r.diff.includes('b.txt'));
});

test('unsupported git diff mode / arbitrary revision is rejected', async () => {
  const { reg, ws } = makeGit();
  await assert.rejects(() => gitDiff({ workspaceId: ws.workspaceId, mode: 'HEAD~1' }, reg), WorkspaceError);
  await assert.rejects(() => gitDiff({ workspaceId: ws.workspaceId, mode: '; rm -rf /' }, reg), WorkspaceError);
});

test('git_status on non-git workspace fails closed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nongit-'));
  const reg = new WorkspaceRegistry({ allowedRoots: [root] });
  const ws = reg.open({ path: root });
  await assert.rejects(() => gitStatus({ workspaceId: ws.workspaceId }, reg), WorkspaceError);
});
