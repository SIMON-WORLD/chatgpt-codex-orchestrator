import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { VerifyService } from '../../src/local/verify.js';
import { MutationOwner, MutationOwnerError } from '../../src/state/mutation-owner.js';

function setup(checks = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const ws = registry.open({ path: root });
  const owner = new MutationOwner();
  const v = new VerifyService({ workspaceRegistry: registry, mutationOwner: owner, verifyChecks: checks });
  return { root, registry, ws, owner, v };
}

test('verify construction rejects an invalid effect', () => {
  const checks = { bad: { command: process.execPath, args: ['-e', 'process.exit(0)'], effect: 'not-an-effect', timeoutMs: 5000 } };
  assert.throws(() => setup(checks), /invalid verify effect/);
});

test('verify construction rejects a non-positive or non-integer timeout', () => {
  assert.throws(() => setup({ a: { command: process.execPath, args: [], effect: 'read_only', timeoutMs: 0 } }), /timeoutMs must be a positive integer/);
  assert.throws(() => setup({ a: { command: process.execPath, args: [], effect: 'read_only', timeoutMs: 99.5 } }), /timeoutMs must be a positive integer/);
  assert.throws(() => setup({ a: { command: process.execPath, args: [], effect: 'read_only', timeoutMs: 999999999 } }), /timeoutMs must be a positive integer/);
});

test('read_only fails closed when another mutation unit is active', async () => {
  const checks = { syntax: { command: process.execPath, args: ['-e', 'process.exit(0)'], effect: 'read_only', timeoutMs: 5000 } };
  const { ws, owner, v } = setup(checks);
  owner.acquire('codex', 'unit-codex');
  await assert.rejects(() => v.run({ workspaceId: ws.workspaceId, check: 'syntax' }), /another mutation unit is active/);
  assert.equal(owner.owner, 'codex');
});

test('workspace_effect fails before spawn when codex already owns the workspace', async () => {
  const checks = { build: { command: process.execPath, args: ['-e', 'process.exit(0)'], effect: 'workspace_effect', timeoutMs: 5000 } };
  const { ws, owner, v } = setup(checks);
  owner.acquire('codex', 'unit-codex');
  await assert.rejects(() => v.run({ workspaceId: ws.workspaceId, check: 'build' }), MutationOwnerError);
  // Ownership was never handed to chatgpt and spawn never happened.
  assert.equal(owner.owner, 'codex');
  assert.equal(owner.unitId, 'unit-codex');
});

test('output-bound truncation does NOT kill the verify process', async () => {
  const checks = { big: { command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(70000)); process.exit(0)'], effect: 'workspace_effect', timeoutMs: 30000 } };
  const { ws, owner, v } = setup(checks);
  const r = await v.run({ workspaceId: ws.workspaceId, check: 'big' });
  assert.equal(r.termination, 'normal_terminal');
  assert.equal(r.timedOut, false);
  assert.equal(r.passed, true);
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.length <= 64 * 1024);
  // normal terminal -> reconciled + released
  assert.equal(owner.owner, 'none');
  assert.equal(owner.unitState, null);
});

test('workspace_effect non-zero exit reconciles + releases owner (passed=false)', async () => {
  const checks = { fail: { command: process.execPath, args: ['-e', 'process.exit(3)'], effect: 'workspace_effect', timeoutMs: 5000 } };
  const { ws, owner, v } = setup(checks);
  const r = await v.run({ workspaceId: ws.workspaceId, check: 'fail' });
  assert.equal(r.termination, 'normal_terminal');
  assert.equal(r.exitCode, 3);
  assert.equal(r.timedOut, false);
  assert.equal(r.passed, false);
  assert.equal(owner.owner, 'none');
  assert.equal(owner.unitState, null);
});

test('timeout is timeout_or_uncertain and owner is NOT released', async () => {
  const checks = { hang: { command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 10000)'], effect: 'workspace_effect', timeoutMs: 300 } };
  const { ws, owner, v } = setup(checks);
  const r = await v.run({ workspaceId: ws.workspaceId, check: 'hang' });
  assert.equal(r.termination, 'timeout_or_uncertain');
  assert.equal(r.timedOut, true);
  assert.equal(owner.owner, 'chatgpt'); // NOT released
  assert.equal(owner.unitState, 'unknown'); // no silent release
});

test('spawn failure (missing binary) is spawn_failed and owner reconciled+released', async () => {
  const checks = { missing: { command: path.join(os.tmpdir(), 'definitely-missing-binary-xyz-0123'), args: [], effect: 'workspace_effect', timeoutMs: 5000 } };
  const { ws, owner, v } = setup(checks);
  const r = await v.run({ workspaceId: ws.workspaceId, check: 'missing' });
  assert.equal(r.termination, 'spawn_failed');
  assert.equal(r.passed, false);
  assert.equal(owner.owner, 'none');
  assert.equal(owner.unitState, null);
});

test('caller only supplies check name; command/argv surface is closed', async () => {
  const checks = { syntax: { command: process.execPath, args: ['-e', 'process.exit(0)'], effect: 'read_only', timeoutMs: 5000 } };
  const { ws, v } = setup(checks);
  // Unknown check fails closed.
  await assert.rejects(() => v.run({ workspaceId: ws.workspaceId, check: 'rm -rf /' }), /unknown verify check/);
  // A caller that tries to smuggle command/argv has no such parameter surface — those
  // extra keys are ignored and the server-owned spec still runs.
  const r = await v.run({ workspaceId: ws.workspaceId, check: 'syntax', command: 'rm', args: ['-rf', '/'] });
  assert.equal(r.passed, true);
  assert.equal(r.effect, 'read_only');
});
