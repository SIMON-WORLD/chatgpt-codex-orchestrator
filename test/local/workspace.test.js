import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { WorkspaceRegistry, WorkspaceError } from '../../src/local/workspace.js';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello', 'utf8');
  return root;
}

test('workspace_open allowed repo succeeds and returns isGitRepo', () => {
  const root = makeRoot();
  const reg = new WorkspaceRegistry({ allowedRoots: [root] });
  const out = reg.open({ path: path.join(root, 'repo') });
  assert.ok(out.workspaceId);
  assert.equal(out.isGitRepo, true);
  assert.ok(fs.statSync(out.root).isDirectory());
});

test('workspace_open ignores arbitrary home/root outside allowedRoots', () => {
  const root = makeRoot();
  const reg = new WorkspaceRegistry({ allowedRoots: [path.join(root, 'repo')] });
  assert.throws(() => reg.open({ path: root }), WorkspaceError);
  assert.throws(() => reg.open({ path: os.homedir() }), WorkspaceError);
});

test('workspace_open non-existent path fails', () => {
  const root = makeRoot();
  const reg = new WorkspaceRegistry({ allowedRoots: [root] });
  assert.throws(() => reg.open({ path: path.join(root, 'nope') }), WorkspaceError);
});

test('resolve rejects .. traversal', () => {
  const root = makeRoot();
  const reg = new WorkspaceRegistry({ allowedRoots: [root] });
  const ws = reg.open({ path: path.join(root, 'repo') });
  assert.throws(() => reg.resolve(ws.workspaceId, '..'), WorkspaceError);
  assert.throws(() => reg.resolve(ws.workspaceId, '../../etc'), WorkspaceError);
});

test('resolve rejects absolute path escape', () => {
  const root = makeRoot();
  const reg = new WorkspaceRegistry({ allowedRoots: [root] });
  const ws = reg.open({ path: path.join(root, 'repo') });
  assert.throws(() => reg.resolve(ws.workspaceId, root.replace(/\\/g, '/')), WorkspaceError);
});

test('resolve rejects symlink/junction escape where testable', (t) => {
  const root = makeRoot();
  const reg = new WorkspaceRegistry({ allowedRoots: [root] });
  const ws = reg.open({ path: path.join(root, 'repo') });
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top-secret', 'utf8');
  const link = path.join(root, 'repo', 'escape');
  try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { t.skip('symlink not permitted: ' + e.message); return; }
  assert.throws(() => reg.resolve(ws.workspaceId, 'escape/secret.txt'), WorkspaceError);
});

test('unknown workspaceId fails', () => {
  const reg = new WorkspaceRegistry({ allowedRoots: [process.cwd()] });
  assert.throws(() => reg.resolve('nope', 'file.txt'), WorkspaceError);
});

test('default allowedRoots uses process cwd', () => {
  const reg = new WorkspaceRegistry();
  assert.equal(reg.hasAllowedRoots, true);
  assert.ok(reg.allowedRoots.includes(path.resolve(process.cwd())));
});
