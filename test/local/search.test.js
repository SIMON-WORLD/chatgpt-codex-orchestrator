import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { search } from '../../src/local/search.js';

function make() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'export const marker = 1;\n// TODO marker here\n', 'utf8');
  fs.writeFileSync(path.join(root, '.env'), 'MARKER=secret', 'utf8');
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'dep.js'), 'marker in dep', 'utf8');
  // Generate many matches to test maxResults.
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), `line marker ${i}`, 'utf8');
  const reg = new WorkspaceRegistry({ allowedRoots: [root] });
  const ws = reg.open({ path: root });
  return { reg, ws, root };
}

test('bounded search succeeds and returns file+line+snippet', () => {
  const { reg, ws } = make();
  const r = search({ workspaceId: ws.workspaceId, query: 'marker', path: 'src', maxResults: 50 }, reg);
  assert.ok(r.matches.length >= 1);
  const m = r.matches.find((x) => x.path.endsWith('index.js'));
  assert.ok(m && m.line >= 1 && typeof m.snippet === 'string');
});

test('sensitive/generated paths are skipped', () => {
  const { reg, ws } = make();
  const r = search({ workspaceId: ws.workspaceId, query: 'marker' }, reg);
  assert.equal(r.matches.some((m) => m.path.includes('node_modules')), false);
  assert.equal(r.matches.some((m) => m.path === '.env'), false);
});

test('maxResults is enforced', () => {
  const { reg, ws } = make();
  const r = search({ workspaceId: ws.workspaceId, query: 'marker', maxResults: 5 }, reg);
  assert.equal(r.truncated, true);
  assert.ok(r.matches.length <= 5);
});
