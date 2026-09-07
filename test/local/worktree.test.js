import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorktreeService, WorktreeError } from '../../src/local/worktree.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';

function git(dir, args, env = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error('git failed: ' + (r.stderr || r.stdout));
  return r.stdout.trim();
}

function makeRepo(repoDir) {
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-q']);
  git(repoDir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init']);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

function fixture(prefix = 'wt-') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Windows temp dirs can be reported in 8.3 short-name form; canonicalize so path
  // comparisons use the same long-name representation the service uses internally.
  const root = fs.realpathSync.native(tmp);
  const repo = path.join(root, 'main-repo');
  const pool = path.join(root, 'wt-pool');
  fs.mkdirSync(pool, { recursive: true });
  const head = makeRepo(repo);
  return { root, repo, pool, head };
}

function service(repo, pool, extraRepos = []) {
  return new WorktreeService({ poolRoot: pool, trustedRepos: [repo, ...extraRepos] });
}

test('bounded worktree bootstrap creates inside the dedicated pool and returns the exact canonical path', async () => {
  const { repo, pool, head } = fixture();
  const svc = service(repo, pool);
  const target = path.join(pool, 'issue-1');
  const out = await svc.create({ repo, targetPath: target, branch: 'feat/issue-1', startPoint: head });
  assert.equal(path.resolve(out.path), path.resolve(target));
  assert.ok(fs.existsSync(out.path));
  assert.ok(fs.existsSync(path.join(out.path, '.git')));
  assert.equal(git(out.path, ['rev-parse', 'HEAD']), head);
  assert.equal(git(out.path, ['branch', '--show-current']), 'feat/issue-1');
  // Ordinary workspace_open binds the created worktree without any runtime restart.
  const registry = new WorkspaceRegistry({ allowedRoots: [repo, pool] });
  const ws = registry.open({ path: out.path });
  assert.equal(path.resolve(ws.root), path.resolve(out.path));
});

test('bounded worktree bootstrap accepts a relative target under the pool root', async () => {
  const { repo, pool, head } = fixture();
  const svc = service(repo, pool);
  const out = await svc.create({ repo, targetPath: 'nested/issue-2', branch: 'feat/issue-2', startPoint: head });
  assert.equal(path.resolve(out.path), path.resolve(pool, 'nested', 'issue-2'));
  assert.ok(fs.existsSync(out.path));
});

test('bounded worktree bootstrap rejects an already existing target', async () => {
  const { repo, pool, head } = fixture();
  const svc = service(repo, pool);
  const target = path.join(pool, 'existing');
  fs.mkdirSync(target, { recursive: true });
  await assert.rejects(() => svc.create({ repo, targetPath: target, branch: 'feat/x', startPoint: head }),
    (e) => e instanceof WorktreeError && e.code === 'target_exists');
});

test('bounded worktree bootstrap rejects pool escapes (outside pool, pool root, parent escape)', async () => {
  const { root, repo, pool, head } = fixture();
  const svc = service(repo, pool);
  await assert.rejects(() => svc.create({ repo, targetPath: path.join(root, 'escape'), branch: 'feat/x', startPoint: head }),
    (e) => e instanceof WorktreeError && e.code === 'pool_escape');
  await assert.rejects(() => svc.create({ repo, targetPath: pool, branch: 'feat/x', startPoint: head }),
    (e) => e instanceof WorktreeError && e.code === 'pool_escape');
  await assert.rejects(() => svc.create({ repo, targetPath: path.join(root, 'outside-pool', 'deep'), branch: 'feat/x', startPoint: head }),
    (e) => e instanceof WorktreeError && e.code === 'pool_escape');
});

test('bounded worktree bootstrap rejects an untrusted repo', async () => {
  const { root, repo, pool, head } = fixture();
  const other = path.join(root, 'other-repo');
  makeRepo(other);
  const svc = service(repo, pool);
  await assert.rejects(() => svc.create({ repo: other, targetPath: path.join(pool, 'issue-1'), branch: 'feat/x', startPoint: head }),
    (e) => e instanceof WorktreeError && e.code === 'untrusted_repo');
  // A non-git directory is also rejected as untrusted.
  const plain = path.join(root, 'plain-dir');
  fs.mkdirSync(plain);
  await assert.rejects(() => svc.create({ repo: plain, targetPath: path.join(pool, 'issue-2'), branch: 'feat/x', startPoint: head }),
    (e) => e instanceof WorktreeError && e.code === 'untrusted_repo');
});

test('bounded worktree bootstrap rejects unsafe/ambiguous branch and ref state', async () => {
  const { repo, pool, head } = fixture();
  const svc = service(repo, pool);
  for (const branch of ['-flag', 'a..b', 'HEAD', 'has space', 'a?b', 'trailing.']) {
    await assert.rejects(() => svc.create({ repo, targetPath: path.join(pool, 'issue-x'), branch, startPoint: head }),
      (e) => e instanceof WorktreeError && ['invalid_branch', 'bad_request'].includes(e.code), 'branch ' + JSON.stringify(branch));
  }
  // Branch that already exists is ambiguous/unsafe (no silent reuse).
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'branch', 'feat/exists']);
  await assert.rejects(() => svc.create({ repo, targetPath: path.join(pool, 'issue-x'), branch: 'feat/exists', startPoint: head }),
    (e) => e instanceof WorktreeError && e.code === 'branch_exists');
  // Unknown / option-like start points are rejected.
  await assert.rejects(() => svc.create({ repo, targetPath: path.join(pool, 'issue-x'), branch: 'feat/ok', startPoint: 'no-such-ref-xyz' }),
    (e) => e instanceof WorktreeError && e.code === 'invalid_start_point');
  await assert.rejects(() => svc.create({ repo, targetPath: path.join(pool, 'issue-x'), branch: 'feat/ok', startPoint: '-flag' }),
    (e) => e instanceof WorktreeError && e.code === 'invalid_start_point');
});
