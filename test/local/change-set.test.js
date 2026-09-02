import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { ChangeSetService, computeSha256 } from '../../src/local/change-set.js';
import { OperationState } from '../../src/state/operation-state.js';
import { VerifyService } from '../../src/local/verify.js';
import { MutationOwner, MutationOwnerError } from '../../src/state/mutation-owner.js';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'));
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const ws = registry.open({ path: root });
  const owner = new MutationOwner();
  const ops = new OperationState({ dataRoot: root });
  const cs = new ChangeSetService({ workspaceRegistry: registry, operationState: ops, mutationOwner: owner });
  return { root, registry, ws, owner, ops, cs };
}

test('preview exact replacement succeeds and mutates nothing', async () => {
  const { root, ws, cs } = setup();
  const file = path.join(root, 'a.txt');
  fs.writeFileSync(file, 'hello world', 'utf8');
  const base = computeSha256(Buffer.from('hello world'));
  const p = await cs.preview({ workspaceId: ws.workspaceId, change: { path: 'a.txt', baseHash: base, replacements: [{ oldText: 'world', newText: 'there', expectedOccurrences: 1 }] } });
  assert.ok(p.changeSetId && p.proposedHash);
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello world'); // no mutation
});

test('wrong baseHash fails', async () => {
  const { root, ws, cs } = setup();
  const file = path.join(root, 'a.txt'); fs.writeFileSync(file, 'hello', 'utf8');
  await assert.rejects(() => cs.preview({ workspaceId: ws.workspaceId, change: { path: 'a.txt', baseHash: 'deadbeef', replacements: [{ oldText: 'hello', newText: 'bye' }] } }), /baseHash mismatch/);
});

test('apply succeeds; resultHash == proposedHash', async () => {
  const { root, ws, cs, ops } = setup();
  const file = path.join(root, 'a.txt'); fs.writeFileSync(file, 'hello world', 'utf8');
  const base = computeSha256(Buffer.from('hello world'));
  const p = await cs.preview({ workspaceId: ws.workspaceId, change: { path: 'a.txt', baseHash: base, replacements: [{ oldText: 'world', newText: 'there' }] } });
  const a = await cs.apply({ workspaceId: ws.workspaceId, changeSetId: p.changeSetId });
  assert.equal(a.resultHash, p.proposedHash);
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello there');
});

test('stale file between preview/apply fails', async () => {
  const { root, ws, cs } = setup();
  const file = path.join(root, 'a.txt'); fs.writeFileSync(file, 'hello', 'utf8');
  const base = computeSha256(Buffer.from('hello'));
  const p = await cs.preview({ workspaceId: ws.workspaceId, change: { path: 'a.txt', baseHash: base, replacements: [{ oldText: 'hello', newText: 'hi' }] } });
  fs.writeFileSync(file, 'changed', 'utf8'); // external change
  await assert.rejects(() => cs.apply({ workspaceId: ws.workspaceId, changeSetId: p.changeSetId }), /stale file between preview and apply/);
});

test('create small new file succeeds; idempotent replay is a no-op', async () => {
  const { root, ws, cs } = setup();
  const p = await cs.preview({ workspaceId: ws.workspaceId, change: { path: 'new.txt', baseHash: null, createContent: 'fresh content' } });
  const a = await cs.apply({ workspaceId: ws.workspaceId, changeSetId: p.changeSetId });
  assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'fresh content');
  const replay = await cs.apply({ workspaceId: ws.workspaceId, changeSetId: p.changeSetId });
  assert.equal(replay.idempotentReplay, true);
});

test('edit apply requires chatgpt owner; conflicting owner blocked before mutation', async () => {
  const { root, ws, cs, owner } = setup();
  const file = path.join(root, 'a.txt'); fs.writeFileSync(file, 'hello', 'utf8');
  const p = await cs.preview({ workspaceId: ws.workspaceId, change: { path: 'a.txt', baseHash: computeSha256(Buffer.from('hello')), replacements: [{ oldText: 'hello', newText: 'bye' }] } });
  // A Codex mutation is active -> edit apply must fail closed before mutation.
  owner.acquire('codex', 'unit-codex');
  await assert.rejects(() => cs.apply({ workspaceId: ws.workspaceId, changeSetId: p.changeSetId }), MutationOwnerError);
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello'); // unchanged
});

test('verify: read_only check succeeds; workspace_effect check; unknown fails; caller cannot inject command', async () => {
  const { ws, registry, owner } = setup();
  // A non-destructive check (node -e) is injected via SERVER policy.
  const checks = {
    syntax: { command: process.execPath, args: ['-e', 'process.exit(0)'], effect: 'read_only', timeoutMs: 5000 },
    build: { command: process.execPath, args: ['-e', 'process.exit(0)'], effect: 'workspace_effect', timeoutMs: 5000 },
  };
  const v = new VerifyService({ workspaceRegistry: registry, mutationOwner: owner, verifyChecks: checks });
  const r = await v.run({ workspaceId: ws.workspaceId, check: 'syntax' });
  assert.equal(r.passed, true);
  assert.equal(r.effect, 'read_only');
  const w = await v.run({ workspaceId: ws.workspaceId, check: 'build' });
  assert.equal(w.passed, true);
  assert.equal(w.effect, 'workspace_effect');
  await assert.rejects(() => v.run({ workspaceId: ws.workspaceId, check: 'rm -rf /' }), /unknown verify check/);
});
