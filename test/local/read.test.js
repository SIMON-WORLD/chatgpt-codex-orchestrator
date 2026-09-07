import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { readFile } from '../../src/local/read.js';

function make() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello world', 'utf8');
  fs.writeFileSync(path.join(root, '.env'), 'API_KEY=sk-secret123', 'utf8');
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3, 65, 66]), 'utf8');
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(200000), 'utf8');
  const reg = new WorkspaceRegistry({ allowedRoots: [root] });
  const ws = reg.open({ path: root });
  return { reg, ws, root };
}

test('bounded file read succeeds', () => {
  const { reg, ws } = make();
  const r = readFile({ workspaceId: ws.workspaceId, path: 'a.txt' }, reg);
  assert.equal(r.content, 'hello world');
  assert.equal(r.truncated, false);
});

test('huge output truncates', () => {
  const { reg, ws } = make();
  const r = readFile({ workspaceId: ws.workspaceId, path: 'big.txt' }, reg);
  assert.equal(r.truncated, true);
  assert.ok(r.content.length <= 64 * 1024 + 1);
});

test('sensitive file is blocked', () => {
  const { reg, ws } = make();
  assert.throws(() => readFile({ workspaceId: ws.workspaceId, path: '.env' }, reg), /sensitive/);
});

test('binary file is rejected', () => {
  const { reg, ws } = make();
  assert.throws(() => readFile({ workspaceId: ws.workspaceId, path: 'bin.dat' }, reg), /binary/);
});

// --- Issue #27: policy must be evaluated on the canonical target too ---

function tryDirLink(target, link) {
  try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); return true; }
  catch { return false; }
}
function tryFileLink(target, link) {
  try { fs.symlinkSync(target, link, 'file'); return true; }
  catch { return false; }
}

test('internal directory alias to a sensitive target is blocked (junction on Windows)', (t) => {
  const { reg, ws, root } = make();
  fs.mkdirSync(path.join(root, 'secrets'));
  fs.writeFileSync(path.join(root, 'secrets', 'token.txt'), 'TOKEN=abc', 'utf8');
  const link = path.join(root, 'alias-secrets');
  if (!tryDirLink(path.join(root, 'secrets'), link)) { t.skip('link creation not permitted in this environment'); return; }
  assert.throws(() => readFile({ workspaceId: ws.workspaceId, path: 'alias-secrets/token.txt' }, reg), /sensitive path blocked/);
});

test('safe internal directory alias remains readable (junction on Windows)', (t) => {
  const { reg, ws, root } = make();
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'readme.txt'), 'doc content', 'utf8');
  const link = path.join(root, 'docs-alias');
  if (!tryDirLink(path.join(root, 'docs'), link)) { t.skip('link creation not permitted in this environment'); return; }
  const r = readFile({ workspaceId: ws.workspaceId, path: 'docs-alias/readme.txt' }, reg);
  assert.equal(r.content, 'doc content');
});

test('safe internal file alias remains readable where file symlinks are permitted', (t) => {
  const { reg, ws, root } = make();
  const alias = path.join(root, 'alias.txt');
  if (!tryFileLink(path.join(root, 'a.txt'), alias)) { t.skip('file symlink creation not permitted in this environment'); return; }
  const r = readFile({ workspaceId: ws.workspaceId, path: 'alias.txt' }, reg);
  assert.equal(r.content, 'hello world');
});
