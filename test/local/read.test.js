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
  return { reg, ws };
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
