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

// ---- r1 regression: replacement bounds, size bounds, create contract, lifecycle ----

test('oldText empty is rejected', async () => {
  const { root, ws, cs } = setup();
  const file = path.join(root, 'a.txt'); fs.writeFileSync(file, 'hello', 'utf8');
  await assert.rejects(() => cs.preview({ workspaceId: ws.workspaceId, change: { path: 'a.txt', baseHash: computeSha256(Buffer.from('hello')), replacements: [{ oldText: '', newText: 'x' }] } }), /oldText must be non-empty/);
});

test('expectedOccurrences excessive (above hard bound) is rejected', async () => {
  const { root, ws, cs } = setup();
  const file = path.join(root, 'a.txt'); fs.writeFileSync(file, 'ab', 'utf8');
  await assert.rejects(() => cs.preview({ workspaceId: ws.workspaceId, change: { path: 'a.txt', baseHash: computeSha256(Buffer.from('ab')), replacements: [{ oldText: 'ab', newText: 'x', expectedOccurrences: 17 }] } }), /expectedOccurrences must be a positive integer/);
});

test('total actual occurrences across specs exceeds bound', async () => {
  const { root, ws, cs } = setup();
  // 10 A + 10 B. Two specs, each 10 occurrences -> total 20 > 16.
  const file = path.join(root, 'a.txt'); fs.writeFileSync(file, 'A'.repeat(10) + 'B'.repeat(10), 'utf8');
  await assert.rejects(() => cs.preview({ workspaceId: ws.workspaceId, change: { path: 'a.txt', baseHash: computeSha256(fs.readFileSync(file)), replacements: [{ oldText: 'A', newText: 'a', expectedOccurrences: 10 }, { oldText: 'B', newText: 'b', expectedOccurrences: 10 }] } }), /total actual replacements exceeds bound/);
});

test('replacement-byte budget counts multiplicity (newText * occurrences)', async () => {
  const { root, ws, cs } = setup();
  const bigNew = 'y'.repeat(3000); // 3000 bytes * 16 occurrences > 32*1024
  const file = path.join(root, 'a.txt'); fs.writeFileSync(file, 'Z'.repeat(16), 'utf8');
  await assert.rejects(() => cs.preview({ workspaceId: ws.workspaceId, change: { path: 'a.txt', baseHash: computeSha256(fs.readFileSync(file)), replacements: [{ oldText: 'Z', newText: bigNew, expectedOccurrences: 16 }] } }), /replacement text budget exceeds bound/);
});

test('proposed existing file exceeding 256 KiB bound is rejected', async () => {
  const { root, ws, cs } = setup();
  // 240 KiB existing, one replacement of ~20 KiB pushes proposed over 256 KiB,
  // while staying within the 32 KiB replacement-byte budget.
  const existing = 'x'.repeat(240 * 1024) + '\nTOKEN';
  const file = path.join(root, 'a.txt'); fs.writeFileSync(file, existing, 'utf8');
  const newText = 'y'.repeat(20 * 1024);
  await assert.rejects(() => cs.preview({ workspaceId: ws.workspaceId, change: { path: 'a.txt', baseHash: computeSha256(fs.readFileSync(file)), replacements: [{ oldText: 'TOKEN', newText, expectedOccurrences: 1 }] } }), /proposed file exceeds 256 KiB bound/);
});

test('createContent exceeding 64 KiB bound is rejected', async () => {
  const { ws, cs } = setup();
  await assert.rejects(() => cs.preview({ workspaceId: ws.workspaceId, change: { path: 'new.txt', createContent: 'a'.repeat(70 * 1024) } }), /new file exceeds size bound/);
});

test('create cannot be combined with replacements', async () => {
  const { ws, cs } = setup();
  await assert.rejects(() => cs.preview({ workspaceId: ws.workspaceId, change: { path: 'new.txt', createContent: 'x', replacements: [{ oldText: 'a', newText: 'b' }] } }), /create cannot be combined with replacements/);
});

test('create requires baseHash to be null', async () => {
  const { ws, cs } = setup();
  await assert.rejects(() => cs.preview({ workspaceId: ws.workspaceId, change: { path: 'new.txt', createContent: 'x', baseHash: computeSha256(Buffer.from('x')) } }), /create requires baseHash to be null/);
});

test('new target appeared between preview/apply does NOT wedge ownership', async () => {
  const { root, ws, cs, owner } = setup();
  const p = await cs.preview({ workspaceId: ws.workspaceId, change: { path: 'new.txt', createContent: 'fresh' } });
  fs.writeFileSync(path.join(root, 'new.txt'), 'externally created', 'utf8'); // target now exists
  await assert.rejects(() => cs.apply({ workspaceId: ws.workspaceId, changeSetId: p.changeSetId }), /new target appeared after preview/);
  // Pre-mutation failure -> reconciled + released, NOT left as unknown.
  assert.equal(owner.owner, 'none');
  assert.equal(owner.unitState, null);
  // The externally created file is untouched.
  assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'externally created');
});

test('stale file between preview/apply does NOT wedge ownership', async () => {
  const { root, ws, cs, owner } = setup();
  const file = path.join(root, 'a.txt'); fs.writeFileSync(file, 'hello', 'utf8');
  const p = await cs.preview({ workspaceId: ws.workspaceId, change: { path: 'a.txt', baseHash: computeSha256(Buffer.from('hello')), replacements: [{ oldText: 'hello', newText: 'bye' }] } });
  fs.writeFileSync(file, 'changed', 'utf8');
  await assert.rejects(() => cs.apply({ workspaceId: ws.workspaceId, changeSetId: p.changeSetId }), /stale file between preview and apply/);
  assert.equal(owner.owner, 'none');
  assert.equal(owner.unitState, null);
});

test('no durable temp file is left behind by a stale-file failure', async () => {
  const { root, ws, cs } = setup();
  const file = path.join(root, 'a.txt'); fs.writeFileSync(file, 'hello', 'utf8');
  const p = await cs.preview({ workspaceId: ws.workspaceId, change: { path: 'a.txt', baseHash: computeSha256(Buffer.from('hello')), replacements: [{ oldText: 'hello', newText: 'bye' }] } });
  fs.writeFileSync(file, 'changed', 'utf8');
  await assert.rejects(() => cs.apply({ workspaceId: ws.workspaceId, changeSetId: p.changeSetId }));
  const leftovers = fs.readdirSync(root).filter((f) => f.startsWith('.edit-'));
  assert.deepEqual(leftovers, []);
});

test('applied op whose target changed externally transitions to recovery_required and cannot reapply', async () => {
  const { root, ws, cs, ops } = setup();
  const file = path.join(root, 'a.txt'); fs.writeFileSync(file, 'hello', 'utf8');
  const base = computeSha256(Buffer.from('hello'));
  const p = await cs.preview({ workspaceId: ws.workspaceId, change: { path: 'a.txt', baseHash: base, replacements: [{ oldText: 'hello', newText: 'bye' }] } });
  const a = await cs.apply({ workspaceId: ws.workspaceId, changeSetId: p.changeSetId });
  assert.equal(a.status, 'applied');
  // External change after apply.
  fs.writeFileSync(file, 'something else', 'utf8');
  await assert.rejects(() => cs.apply({ workspaceId: ws.workspaceId, changeSetId: p.changeSetId }), /applied but target hash differs/);
  assert.equal(ops.load(p.changeSetId).status, 'recovery_required');
  // recovery_required cannot be reapplied; re-preview first.
  await assert.rejects(() => cs.apply({ workspaceId: ws.workspaceId, changeSetId: p.changeSetId }), /recovery_required changeSet cannot be reapplied/);
});

test('sensitive / internal / generated paths are blocked from mutation', async () => {
  const { root, ws, cs } = setup();
  for (const rel of ['.env', '.git/config', 'node_modules/pkg/index.js', 'build/out.js', '.codex/config.toml', 'secrets/token.txt']) {
    await assert.rejects(() => cs.preview({ workspaceId: ws.workspaceId, change: { path: rel, createContent: 'x' } }), /edit blocked: high-risk\/internal\/generated path/);
  }
});

test('symlink/junction create escape is rejected', async (t) => {
  const { root, ws, cs } = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  const link = path.join(root, 'link');
  try {
    if (process.platform === 'win32') fs.symlinkSync(outside, link, 'junction');
    else fs.symlinkSync(outside, link);
  } catch (e) {
    t.skip('symlink creation not permitted in this environment');
    return;
  }
  await assert.rejects(() => cs.preview({ workspaceId: ws.workspaceId, change: { path: 'link/escape.txt', createContent: 'x' } }), /symlink\/junction escapes workspace/);
});

test('existing-file executable bit is preserved on apply (POSIX only)', async (t) => {
  if (process.platform === 'win32') { t.skip('executable bits are POSIX-only'); return; }
  const { root, ws, cs } = setup();
  const file = path.join(root, 'run.sh');
  fs.writeFileSync(file, '#!/bin/sh\necho hi\n', 'utf8');
  fs.chmodSync(file, 0o755);
  const base = computeSha256(fs.readFileSync(file));
  const p = await cs.preview({ workspaceId: ws.workspaceId, change: { path: 'run.sh', baseHash: base, replacements: [{ oldText: 'echo hi', newText: 'echo bye' }] } });
  const a = await cs.apply({ workspaceId: ws.workspaceId, changeSetId: p.changeSetId });
  assert.equal(a.status, 'applied');
  const mode = fs.statSync(file).mode & 0o111;
  assert.ok(mode & 0o100, 'executable bit should be preserved');
  assert.equal(fs.readFileSync(file, 'utf8'), '#!/bin/sh\necho bye\n');
});
