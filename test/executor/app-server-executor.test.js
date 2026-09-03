import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppServerExecutor, extractAssistantText } from '../../src/executor/app-server-executor.js';
import { AppServerClient } from '../../src/executor/app-server-client.js';
import { JobMap } from '../../src/executor/job-map.js';
import { ApprovalError } from '../../src/executor/approval.js';
import { MutationOwnerError } from '../../src/state/mutation-owner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, '..', '..', 'test-fixtures', 'executor', 'fake-app-server.mjs');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(fn, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await sleep(5);
  }
  return false;
}

function makeExecutor({ approval = '0', die = null, dataRoot = null, failTurnStart = false, slowTurn = false, turnFail = false, noConfirmInterrupt = false } = {}) {
  const root = dataRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const env = { ...process.env, FAKE_APP_SERVER_APPROVAL: approval, FAKE_APP_SERVER_STATE_DIR: root };
  if (die !== null) env.FAKE_APP_SERVER_DIE_MS = String(die);
  if (failTurnStart) env.FAKE_APP_SERVER_FAIL_TURN_START = '1';
  if (slowTurn) env.FAKE_APP_SERVER_SLOW_TURN = '1';
  if (turnFail) env.FAKE_APP_SERVER_TURN_FAIL = '1';
  if (noConfirmInterrupt) env.FAKE_APP_SERVER_NO_CONFIRM_INTERRUPT = '1';
  const client = new AppServerClient({ codexBin: process.execPath, spawnArgs: [fixture], env });
  const jobMap = new JobMap({ dataRoot: root });
  return new AppServerExecutor({ client, jobMap });
}

async function startExecutor(executor, prompt = 'do the task', accessMode = 'workspace_write') {
  const res = await executor.start({ prompt, accessMode });
  return res;
}

test('start creates job + thread + turn', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await startExecutor(exec);
  assert.ok(r.jobId);
  assert.ok(r.threadId);
  assert.ok(r.turnId);
  assert.equal(r.state, 'running');
  const job = exec.load(r.jobId);
  assert.equal(job.threadId, r.threadId);
  assert.equal(job.turnId, r.turnId);
});

test('mapping persists before successful acknowledgement', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await startExecutor(exec);
  const job = exec.load(r.jobId);
  assert.ok(job.threadId && job.turnId);
});

test('get retrieves structured state', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await startExecutor(exec);
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  const st = await exec.get({ jobId: r.jobId });
  assert.equal(st.jobId, r.jobId);
  assert.equal(st.threadId, r.threadId);
  assert.equal(st.live, true);
  assert.equal(st.recoveryRequired, false);
  assert.ok(st.turn && st.turn.status);
});

test('continue reuses SAME thread and gets a new turnId', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await startExecutor(exec);
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  const c = await exec.continue({ jobId: r.jobId, instruction: 'continue' });
  assert.equal(c.threadId, r.threadId);
  assert.notEqual(c.turnId, r.turnId);
  const job = exec.load(r.jobId);
  assert.equal(job.threadId, r.threadId);
  assert.equal(job.turnId, c.turnId);
});

test('interrupt reaches resolved state', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, slowTurn: true });
  t.after(() => exec.shutdown());
  const r = await startExecutor(exec);
  // authoritative reconcile must confirm the interrupt and release execution ownership.
  const ir = await exec.interrupt({ jobId: r.jobId });
  assert.equal(ir.reconciliation, 'confirmed');
  assert.equal(ir.state, 'interrupted');
  assert.equal(ir.ownershipReleased, true);
  assert.equal(await waitFor(() => exec.load(r.jobId).state === 'interrupted'), true);
});

test('approval is surfaced and exact approval response is accepted', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ approval: '1', dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await startExecutor(exec);
  assert.equal(await waitFor(() => exec._approvals.size > 0), true);
  const approvalId = [...exec._approvals.keys()][0];
  const info = exec._approvals.get(approvalId).info;
  assert.equal(info.method, 'item/commandExecution/requestApproval');
  const resp = await exec.respondApproval({ jobId: r.jobId, approvalId, decision: 'approve' });
  assert.equal(resp.ok, true);
  assert.equal(exec._approvals.size, 0);
});

test('stale approval fails closed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  await assert.rejects(
    exec.respondApproval({ jobId: 'job-x', approvalId: 'does-not-exist', decision: 'approve' }),
    ApprovalError,
  );
});

test('clean shutdown leaves no child', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  await startExecutor(exec);
  await exec.shutdown();
  assert.equal(exec.client.isRunning, false);
});

test('simulated process death is detected', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ die: 1500, dataRoot: root });
  await startExecutor(exec);
  assert.equal(await waitFor(() => exec.client.isRunning === false, 2000), true);
});

test('persisted job mapping can be loaded after executor restart', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec1 = makeExecutor({ dataRoot: root });
  const r = await startExecutor(exec1);
  await exec1.shutdown();
  const exec2 = makeExecutor({ dataRoot: root });
  t.after(() => exec2.shutdown());
  const job = exec2.load(r.jobId);
  assert.ok(job);
  assert.equal(job.threadId, r.threadId);
  assert.equal(job.turnId, r.turnId);
});

test('reconciliation does not blindly create a duplicate turn', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await startExecutor(exec);
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  const resumed = await exec.resume({ jobId: r.jobId });
  const job = exec.load(r.jobId);
  assert.equal(resumed.threadId, r.threadId);
  assert.equal(job.threadId, r.threadId);
  assert.equal(job.turnId, r.turnId);
});

test('mutation_owner blocks conflicting ownership', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  await startExecutor(exec);
  assert.throws(() => exec.owner.assertCanWrite('chatgpt'), /owned by codex/);
});

test('owner=chatgpt -> start fails BEFORE turn/start reaches fake App Server', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  exec.owner.acquire('chatgpt', 'unit-x');
  await assert.rejects(() => exec.start({ prompt: 'x', accessMode: 'workspace_write' }), MutationOwnerError);
  const job = exec.jobMap.list().find((j) => j.state === 'recovery_required');
  assert.ok(job);
  assert.ok(job.threadId);
  assert.equal(job.turnId, null);
});

test('owner=none -> continue actually acquires codex ownership', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await startExecutor(exec);
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  // M7 contract: on authoritative terminal the execution owner is auto-released to none.
  assert.equal(exec.owner.owner, 'none');
  const c = await exec.continue({ jobId: r.jobId, instruction: 'continue' });
  assert.equal(exec.owner.owner, 'codex'); // continue acquired ownership
  assert.ok(c.turnId);
});

test('turn/start failure -> ownership cannot be silently handed to another writer', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, failTurnStart: true });
  t.after(() => exec.shutdown());
  await assert.rejects(() => exec.start({ prompt: 'x', accessMode: 'workspace_write' }));
  assert.equal(exec.owner.owner, 'codex');
  assert.equal(exec.owner.unitState, 'unknown');
  assert.throws(() => exec.owner.release(), /not reconciled/);
  assert.throws(() => exec.owner.acquire('chatgpt', 'other'), /owned by codex/);
});

test('crash after threadId persisted but before turnId leaves provisional mapping', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, failTurnStart: true });
  t.after(() => exec.shutdown());
  await assert.rejects(() => exec.start({ prompt: 'x', accessMode: 'workspace_write' }));
  const job = exec.jobMap.list().find((j) => j.state === 'recovery_required');
  assert.ok(job);
  assert.ok(job.threadId);
  assert.equal(job.turnId, null);
});

test('restart loads provisional mapping after crash', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec1 = makeExecutor({ dataRoot: root, failTurnStart: true });
  await assert.rejects(() => exec1.start({ prompt: 'x', accessMode: 'workspace_write' }));
  await exec1.shutdown();
  const exec2 = makeExecutor({ dataRoot: root });
  t.after(() => exec2.shutdown());
  const job = exec2.jobMap.list().find((j) => j.state === 'recovery_required');
  assert.ok(job && job.threadId && !job.turnId);
});

test('ambiguous recovery fails closed rather than guessing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, failTurnStart: true });
  t.after(() => exec.shutdown());
  await assert.rejects(() => exec.start({ prompt: 'x', accessMode: 'workspace_write' }));
  const job = exec.jobMap.list().find((j) => j.state === 'recovery_required');
  await assert.rejects(() => exec.resume({ jobId: job.jobId }), /refusing to guess|ambiguous|no candidate|multiple candidate/);
  const after = exec.load(job.jobId);
  assert.equal(after.turnId, null);
});

test('respondApproval for a different job fails closed and keeps approval unresolved', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ approval: '1', dataRoot: root });
  t.after(() => exec.shutdown());
  const rA = await startExecutor(exec);
  assert.equal(await waitFor(() => exec._approvals.size > 0), true);
  const approvalId = [...exec._approvals.keys()][0];
  await assert.rejects(
    exec.respondApproval({ jobId: 'job-b', approvalId, decision: 'approve' }),
    ApprovalError,
  );
  assert.equal(exec._approvals.has(String(approvalId)), true);
});

test('concurrent job: active unit blocks a second start before its turn/start', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, slowTurn: true });
  t.after(() => exec.shutdown());
  const rA = await startExecutor(exec);
  assert.equal(await waitFor(() => exec.owner.unitState === 'running'), true);
  await assert.rejects(() => exec.start({ prompt: 'b', accessMode: 'workspace_write' }), MutationOwnerError);
  // job B provisioned but no turn started.
  const jobB = exec.jobMap.list().find((j) => j.state === 'recovery_required' && j.jobId !== rA.jobId && j.threadId && !j.turnId);
  assert.ok(jobB);
});

test('concurrent job: premature continue while active unit fails', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, slowTurn: true });
  t.after(() => exec.shutdown());
  const rA = await startExecutor(exec);
  assert.equal(await waitFor(() => exec.owner.unitState === 'running'), true);
  await assert.rejects(() => exec.continue({ jobId: rA.jobId, instruction: 'x' }), MutationOwnerError);
});

test('after reconciled unit, next continuation may acquire a new unit', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const rA = await startExecutor(exec);
  await waitFor(() => exec.load(rA.jobId).state === 'completed');
  const c = await exec.continue({ jobId: rA.jobId, instruction: 'next' });
  assert.ok(c.turnId);
  assert.equal(exec.owner.owner, 'codex');
});

test('process death -> SAME client reconnect -> resume reattaches same thread, no duplicate thread/turn', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, die: 1500 });
  const r = await startExecutor(exec);
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  // Wait for the fake fixture to exit (simulated process death).
  await waitFor(() => exec.client.isRunning === false, 3000);
  // Resume on the SAME client/executor: reconnects and uses thread/resume.
  const resumed = await exec.resume({ jobId: r.jobId });
  const job = exec.load(r.jobId);
  assert.equal(resumed.threadId, r.threadId);
  assert.equal(job.threadId, r.threadId);
  assert.equal(job.turnId, r.turnId); // no duplicate thread/turn
  // No duplicate thread/start, no duplicate turn/start: threadId & turnId unchanged.
  assert.equal(exec.client.isRunning, true);
});

test('unexpected death while job running -> job recovery_required + owner unknown', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, slowTurn: true, die: 1500 });
  const r = await startExecutor(exec);
  assert.equal(exec.owner.unitState, 'running');
  await waitFor(() => exec.client.isRunning === false, 3000);
  const after = exec.load(r.jobId);
  assert.equal(after.state, 'recovery_required');
  assert.equal(exec.owner.unitState, 'unknown');
});

test('pending binary approval replay surfaced again, no second mutation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ approval: '1', dataRoot: root, die: 1500 });
  const r = await startExecutor(exec);
  assert.equal(await waitFor(() => exec._approvals.size > 0), true);
  // Do NOT answer the approval. Wait for process death.
  await waitFor(() => exec.client.isRunning === false, 3000);
  // Resume reconnects; thread/resume re-emits the still-pending approval.
  await exec.resume({ jobId: r.jobId });
  assert.equal(await waitFor(() => exec._approvals.size > 0), true);
  const approvalId = [...exec._approvals.keys()][0];
  const resp = await exec.respondApproval({ jobId: r.jobId, approvalId, decision: 'approve' });
  assert.equal(resp.ok, true);
  const job = exec.load(r.jobId);
  assert.equal(job.threadId, r.threadId);
  assert.equal(job.turnId, r.turnId); // no second mutation/turn
});

test('mutationUnitId is persisted with the job and changed on continue', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await startExecutor(exec);
  const job = exec.load(r.jobId);
  assert.ok(job.mutationUnitId && job.mutationUnitId.length > 0);
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  const c = await exec.continue({ jobId: r.jobId, instruction: 'x' });
  const job2 = exec.load(r.jobId);
  assert.notEqual(job2.mutationUnitId, job.mutationUnitId);
});

test('full executor restart reconstructs ownership from persisted mutationUnitId', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const execA = makeExecutor({ dataRoot: root, slowTurn: true });
  const rA = await startExecutor(execA);
  const persisted = execA.load(rA.jobId);
  assert.ok(persisted.mutationUnitId);
  await execA.shutdown(); // executor A disappears; turn still inProgress (slow)
  const execB = makeExecutor({ dataRoot: root });
  t.after(() => execB.shutdown());
  await execB.resume({ jobId: rA.jobId });
  assert.equal(execB.owner.owner, 'codex');
  assert.equal(execB.owner.unitId, persisted.mutationUnitId);
  assert.equal(execB.owner.unitState, 'running');
});

test('active recovered job blocks a new mutation after restart', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const execA = makeExecutor({ dataRoot: root, slowTurn: true });
  const rA = await startExecutor(execA);
  await execA.shutdown();
  const execB = makeExecutor({ dataRoot: root });
  t.after(() => execB.shutdown());
  await execB.resume({ jobId: rA.jobId });
  await assert.rejects(() => execB.start({ prompt: 'b', accessMode: 'workspace_write' }), MutationOwnerError);
  const jobB = execB.jobMap.list().find((j) => j.state === 'recovery_required' && j.jobId !== rA.jobId && j.threadId && !j.turnId);
  assert.ok(jobB);
});


test('extractAssistantText handles real App Server agentMessage (camelCase text)', () => {
  const turn = { status: 'completed', items: [
    { type: 'userMessage', text: 'hi' },
    { type: 'agentMessage', text: 'REAL_CODEX_SMOKE_OK', phase: 'final_answer' },
  ] };
  assert.equal(extractAssistantText(turn), 'REAL_CODEX_SMOKE_OK');
});

test('extractAssistantText handles legacy agent_message input_text content', () => {
  const turn = { items: [
    { type: 'agent_message', content: [{ type: 'input_text', text: 'hello legacy' }] },
  ] };
  assert.equal(extractAssistantText(turn), 'hello legacy');
});

test('extractAssistantText excludes user/assistant non-output items', () => {
  const turn = { items: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'keep' }] },
    { type: 'message', role: 'user', content: [{ type: 'output_text', text: 'drop' }] },
    { type: 'reasoning', content: [{ type: 'text', text: 'drop-2' }] },
  ] };
  assert.equal(extractAssistantText(turn), 'keep');
});


// ---- M7 mutation-lifecycle hardening ---------------------------------------

test('start requires an explicit accessMode (fail closed, no silent read-only)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  await assert.rejects(() => exec.start({ prompt: 'x' }), /accessMode/);
  // missing accessMode must NOT have started a mutation thread/owner.
  assert.equal(exec.owner.owner, 'none');
});

test('accessMode=workspace_write maps to sandbox workspace-write and is persisted', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'x', accessMode: 'workspace_write' });
  const job = exec.load(r.jobId);
  assert.equal(job.accessMode, 'workspace_write');
  assert.equal(job.sandbox, 'workspace-write');
  // The App Server thread/start actually received the workspace-write sandbox.
  const st = await exec.get({ jobId: r.jobId });
  assert.equal(st.accessMode, 'workspace_write');
});

test('accessMode=read_only maps to sandbox read-only', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'x', accessMode: 'read_only' });
  const job = exec.load(r.jobId);
  assert.equal(job.accessMode, 'read_only');
  assert.equal(job.sandbox, 'read-only');
});

test('completed turn auto-releases codex execution ownership (idempotent)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'x', accessMode: 'workspace_write' });
  if (exec.owner.owner === 'none') exec.owner.acquire('codex', exec.load(r.jobId).mutationUnitId);
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  assert.equal(exec.owner.owner, 'none');
  const st = await exec.get({ jobId: r.jobId });
  assert.equal(st.ownershipReleased, true);
  assert.equal(st.mutationOwner, 'none');
  assert.equal(st.mutationUnitState, 'released');
});

test('failed turn auto-releases codex execution ownership', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, turnFail: true });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'x', accessMode: 'workspace_write' });
  if (exec.owner.owner === 'none') exec.owner.acquire('codex', exec.load(r.jobId).mutationUnitId);
  await waitFor(() => exec.load(r.jobId).state === 'failed');
  assert.equal(exec.owner.owner, 'none');
  const st = await exec.get({ jobId: r.jobId });
  assert.equal(st.turn.status, 'failed');
  assert.equal(st.ownershipReleased, true);
});

test('interrupt confirms terminal and releases codex ownership', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'x', accessMode: 'workspace_write' });
  const ir = await exec.interrupt({ jobId: r.jobId });
  // fake marks the turn interrupted immediately; authoritative reconcile confirms terminal.
  assert.equal(ir.reconciliation, 'confirmed');
  assert.equal(ir.ownershipReleased, true);
  await waitFor(() => exec.load(r.jobId).state === 'interrupted');
  assert.equal(exec.owner.owner, 'none');
});

test('unresolved interrupt keeps owner and reports recoveryRequired (fail-closed)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, slowTurn: true, noConfirmInterrupt: true });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'x', accessMode: 'workspace_write' });
  const ir = await exec.interrupt({ jobId: r.jobId });
  assert.equal(ir.reconciliation, 'unresolved');
  assert.equal(ir.ownershipReleased, false);
  assert.equal(ir.recoveryRequired, true);
  assert.equal(exec.owner.owner, 'codex'); // NOT released
  // Direct Local / new Codex mutation must remain blocked.
  assert.throws(() => exec.owner.acquire('chatgpt', 'other'), /owned by codex/);
});

test('get self-heals: authoritative terminal reconciles + releases', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'x', accessMode: 'workspace_write' });
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  // Re-acquire to simulate a stale owner flag; get() should heal based on authoritative read.
  if (exec.owner.owner === 'none') exec.owner.acquire('codex', exec.load(r.jobId).mutationUnitId);
  const st = await exec.get({ jobId: r.jobId });
  assert.equal(st.ownershipReleased, true);
  assert.equal(exec.owner.owner, 'none');
});

test('accessMode inherited on continue (no silent escalation)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'x', accessMode: 'workspace_write' });
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  const c = await exec.continue({ jobId: r.jobId, instruction: 'more' });
  assert.equal(c.accessMode, 'workspace_write');
  const job = exec.load(r.jobId);
  assert.equal(job.accessMode, 'workspace_write');
  // Wait for the continue's turn to finish so execution ownership is released before next start.
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  // read_only job must not be escalated by continue.
  const r2 = await exec.start({ prompt: 'y', accessMode: 'read_only' });
  await waitFor(() => exec.load(r2.jobId).state === 'completed');
  const c2 = await exec.continue({ jobId: r2.jobId, instruction: 'more' });
  assert.equal(c2.accessMode, 'read_only');
});


// ---- M7 hardening R2 -----------------------------------------------------

test('read_only start does not acquire writer ownership', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'read_only' });
  assert.equal(exec.owner.owner, 'none');
  assert.equal(r.mutationOwner, 'none');
  const job = exec.load(r.jobId);
  assert.equal(job.isWriter, false);
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  assert.equal(exec.owner.owner, 'none'); // still no writer lock after terminal
});

test('read_only continue does not acquire writer ownership', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'read_only' });
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  const c = await exec.continue({ jobId: r.jobId, instruction: 'b' });
  assert.equal(exec.owner.owner, 'none');
  assert.equal(c.mutationOwner, 'none');
});

test('read_only process death leaves no writer lock', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, die: 1500 });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'read_only' });
  assert.equal(exec.owner.owner, 'none');
  await waitFor(() => exec.client.isRunning === false, 3000);
  assert.equal(exec.owner.owner, 'none'); // no lingering writer lock after read-only death
});

test('stale Turn A terminal notification does not affect Turn B', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'workspace_write' });
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  const oldTurnId = r.turnId;
  const threadId = r.threadId;
  // Advance the job to a NEW active unit (Turn B) that the writer currently holds.
  const turnB = 'turn-b-stale-test';
  exec.jobMap.update(r.jobId, { mutationUnitId: 'mu-b', turnId: turnB, state: 'running', ownershipReleased: false });
  exec.owner.acquire('codex', 'mu-b');
  assert.equal(exec.owner.owner, 'codex');
  // A LATE terminal notification for the OLD Turn A arrives.
  exec._handleNotification({ method: 'turn/completed', params: { threadId, turn: { id: oldTurnId, status: 'completed' } } });
  const after = exec.load(r.jobId);
  assert.equal(after.turnId, turnB); // not overwritten by Turn A
  assert.equal(after.state, 'running'); // Turn B state preserved
  assert.equal(exec.owner.owner, 'codex'); // Turn B writer NOT released
  assert.equal(exec.owner.unitId, 'mu-b');
});

test('reconcile terminal releases writer', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'workspace_write' });
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  if (exec.owner.owner === 'none') exec.owner.acquire('codex', exec.load(r.jobId).mutationUnitId);
  const rec = await exec.reconcile({ jobId: r.jobId });
  assert.equal(rec.resolution, 'terminal');
  assert.equal(rec.ownershipReleased, true);
  assert.equal(exec.owner.owner, 'none');
});

test('reconcile inProgress retains writer', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, slowTurn: true });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'workspace_write' });
  assert.equal(exec.owner.owner, 'codex');
  const rec = await exec.reconcile({ jobId: r.jobId });
  assert.equal(rec.resolution, 'in_progress');
  assert.equal(rec.ownershipReleased, false);
  assert.equal(exec.owner.owner, 'codex'); // retained
});

test('ambiguous reconciliation fails closed (no candidate for current unit)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, slowTurn: true });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'workspace_write' });
  assert.equal(exec.owner.owner, 'codex');
  // current unit has NO identifiable turn (pending-continue with no turn created) -> 0 candidates.
  exec.jobMap.update(r.jobId, { mutationUnitId: 'unitB-no-turn' });
  const rec = await exec.reconcile({ jobId: r.jobId });
  assert.equal(rec.resolution, 'unresolved');
  assert.equal(rec.reconciled, false);
  assert.equal(rec.recoveryRequired, true);
  assert.equal(exec.owner.owner, 'codex'); // fail-closed: retained
});

test('codex_get on unreachable client -> recoveryRequired + nextAction=codex_reconcile', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, die: 1500 });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'workspace_write' });
  await waitFor(() => !exec.client.isRunning, 3000);
  const st = await exec.get({ jobId: r.jobId });
  assert.equal(st.recoveryRequired, true);
  assert.equal(st.nextAction, 'codex_reconcile');
});


test('observability: ownershipReleased=false never pairs with mutationUnitState=released', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, slowTurn: true });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'workspace_write' });
  const st = await exec.get({ jobId: r.jobId });
  // In-progress writer: not released, and state must clearly reflect the running unit.
  assert.equal(st.ownershipReleased, false);
  assert.notEqual(st.mutationUnitState, 'released'); // invariant
  assert.equal(st.mutationUnitState, 'running');
  assert.equal(st.mutationOwner, 'codex');
  // job vs owner mutation unit clarified.
  assert.equal(st.jobMutationUnitId, exec.load(r.jobId).mutationUnitId);
  assert.equal(st.ownerMutationUnitId, exec.load(r.jobId).mutationUnitId);
  // There must be NO misleading mutationUnitIdObs field.
  assert.equal('mutationUnitIdObs' in st, false);
});


// ---- M7 hardening R3 -----------------------------------------------------

test('R3 continue transition window: late Turn A terminal notification must not release Turn B', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'workspace_write' });
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  const turnA = r.turnId;
  const threadId = r.threadId;
  const unitA = exec.load(r.jobId).mutationUnitId;
  // The turn->unit map already associates Turn A with unit A (set by start()).
  assert.equal(exec._turnUnits.get(turnA), unitA);

  // ---- enter the continue transition window ----
  const unitB = 'unit-b-continue-window';
  const turnB = 'turn-b-continue-window';
  exec.owner.acquire('codex', unitB);            // B writer unit acquired
  exec.jobMap.update(r.jobId, { mutationUnitId: unitB, state: 'starting', ownershipReleased: false }); // job.mutationUnitId=B, turnId is STILL Turn A
  assert.equal(exec.load(r.jobId).turnId, turnA); // window: B turnId not yet written
  assert.equal(exec.owner.unitId, unitB);

  // ---- a LATE Turn A terminal notification arrives in this window ----
  exec._handleNotification({ method: 'turn/completed', params: { threadId, turn: { id: turnA, status: 'completed' } } });

  // B writer must NOT be released; owner unit remains B; B lifecycle not rewritten.
  assert.equal(exec.owner.owner, 'codex');
  assert.equal(exec.owner.unitId, unitB);
  const after = exec.load(r.jobId);
  assert.equal(after.turnId, turnA);       // not overwritten by Turn A
  assert.equal(after.state, 'starting');   // not flipped to 'completed' by Turn A
  assert.equal(after.mutationUnitId, unitB);

  // ---- B can later complete normally ----
  exec.jobMap.update(r.jobId, { turnId: turnB, state: 'running' });
  exec._turnUnits.set(turnB, unitB);
  exec._handleNotification({ method: 'turn/completed', params: { threadId, turn: { id: turnB, status: 'completed' } } });
  assert.equal(exec.owner.owner, 'none'); // B released after its own terminal
  assert.equal(exec.load(r.jobId).state, 'completed');
});

test('R3 reconcile inProgress + codex same unit -> retain (PASS)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, slowTurn: true });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'workspace_write' });
  assert.equal(exec.owner.owner, 'codex');
  const rec = await exec.reconcile({ jobId: r.jobId });
  assert.equal(rec.resolution, 'in_progress');
  assert.equal(rec.reconciled, true);
  assert.equal(exec.owner.owner, 'codex'); // retained
});

test('R3 reconcile inProgress + codex different unit -> unresolved fail closed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, slowTurn: true });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'workspace_write' });
  // Simulate a unit mismatch: the job's unit is NOT the active owner unit.
  exec.jobMap.update(r.jobId, { mutationUnitId: 'unit-other' });
  const originalOwnerUnit = exec.owner.unitId;
  const rec = await exec.reconcile({ jobId: r.jobId });
  assert.equal(rec.resolution, 'unresolved');
  assert.equal(rec.reconciled, false);
  assert.equal(rec.recoveryRequired, true);
  assert.ok(/ownership conflict|no candidate|multiple candidate|ambiguous/.test(rec.reason));
  assert.equal(exec.owner.owner, 'codex'); // not overwritten
  assert.equal(exec.owner.unitId, originalOwnerUnit); // foreign unit unchanged (NOT 'unit-other')
  assert.notEqual(exec.owner.unitId, 'unit-other');
});

test('R3 reconcile inProgress + chatgpt owner -> unresolved fail closed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, slowTurn: true });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'workspace_write' });
  // Simulate a chatgpt (Direct Local) owner holding the workspace.
  exec.owner.release({ force: true });
  exec.owner.acquire('chatgpt', 'direct-unit');
  const rec = await exec.reconcile({ jobId: r.jobId });
  assert.equal(rec.resolution, 'unresolved');
  assert.equal(rec.reconciled, false);
  assert.equal(rec.recoveryRequired, true);
  assert.ok(/chatgpt/.test(rec.reason));
  assert.equal(exec.owner.owner, 'chatgpt'); // not overwritten
  assert.equal(exec.owner.unitId, 'direct-unit');
});

test('R3 reconcile terminal does not release a foreign/newer codex unit', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'workspace_write' });
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  // Simulate a NEWER active codex unit (different from this job's unit).
  exec.owner.acquire('codex', 'newer-unit');
  exec.jobMap.update(r.jobId, { mutationUnitId: 'old-unit' });
  const rec = await exec.reconcile({ jobId: r.jobId });
  assert.equal(rec.resolution, 'unresolved');
  assert.equal(rec.reconciled, false);
  assert.ok(/ownership conflict|no candidate|multiple candidate|ambiguous/.test(rec.reason));
  assert.equal(exec.owner.owner, 'codex');
  assert.equal(exec.owner.unitId, 'newer-unit'); // NOT released
});


// ---- M7 hardening R4: read_only is never a writer ------------------------

test('R4 read_only reconcile inProgress + owner none -> PASS, owner stays none', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, slowTurn: true });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'read_only' });
  assert.equal(exec.owner.owner, 'none');
  const rec = await exec.reconcile({ jobId: r.jobId });
  assert.equal(rec.resolution, 'in_progress');
  assert.equal(rec.reconciled, true);
  assert.equal(exec.owner.owner, 'none'); // MUST NOT acquire
});

test('R4 read_only reconcile inProgress + active codex writer -> PASS, writer unchanged', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, slowTurn: true });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'read_only' });
  assert.equal(exec.owner.owner, 'none');
  exec.owner.acquire('codex', 'writer-W');
  assert.equal(exec.owner.owner, 'codex');
  assert.equal(exec.owner.unitId, 'writer-W');
  const rec = await exec.reconcile({ jobId: r.jobId });
  assert.equal(rec.resolution, 'in_progress');
  assert.equal(rec.reconciled, true);
  assert.equal(rec.ownershipReleased, false);
  assert.equal(exec.owner.owner, 'codex'); // writer unchanged
  assert.equal(exec.owner.unitId, 'writer-W'); // writer unit unchanged
});

test('R4 read_only reconcile inProgress + active chatgpt writer -> PASS, writer unchanged', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, slowTurn: true });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'read_only' });
  exec.owner.acquire('chatgpt', 'chatgpt-W');
  assert.equal(exec.owner.owner, 'chatgpt');
  assert.equal(exec.owner.unitId, 'chatgpt-W');
  const rec = await exec.reconcile({ jobId: r.jobId });
  assert.equal(rec.resolution, 'in_progress');
  assert.equal(rec.reconciled, true);
  assert.equal(rec.ownershipReleased, false);
  assert.equal(exec.owner.owner, 'chatgpt'); // writer unchanged
  assert.equal(exec.owner.unitId, 'chatgpt-W'); // writer unit unchanged
});

test('R4 read_only terminal reconcile + active foreign writer -> PASS, writer unchanged', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'read_only' });
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  assert.equal(exec.owner.owner, 'none');
  // A foreign codex writer holds the workspace.
  exec.owner.acquire('codex', 'foreign-W');
  const rec = await exec.reconcile({ jobId: r.jobId });
  assert.equal(rec.resolution, 'terminal');
  assert.equal(rec.reconciled, true);
  assert.equal(exec.owner.owner, 'codex'); // writer NOT released
  assert.equal(exec.owner.unitId, 'foreign-W'); // writer unit unchanged
  // Also verify with a chatgpt writer.
  exec.owner.release({ force: true });
  exec.owner.acquire('chatgpt', 'chatgpt-W2');
  const rec2 = await exec.reconcile({ jobId: r.jobId });
  assert.equal(rec2.resolution, 'terminal');
  assert.equal(rec2.reconciled, true);
  assert.equal(exec.owner.owner, 'chatgpt'); // writer NOT released
  assert.equal(exec.owner.unitId, 'chatgpt-W2'); // writer unit unchanged
});

test('R4 read_only notification while writer active -> read-only state updates, writer unchanged', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, slowTurn: true });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'read_only' });
  const readOnlyTurn = r.turnId;
  const threadId = r.threadId;
  assert.equal(exec.owner.owner, 'none');
  exec.owner.acquire('codex', 'writer-W');
  assert.equal(exec.owner.owner, 'codex');
  assert.equal(exec.owner.unitId, 'writer-W');
  // A read_only turn/completed notification updates the read_only job lifecycle but
  // must never touch the active writer.
  exec._handleNotification({ method: 'turn/completed', params: { threadId, turn: { id: readOnlyTurn, status: 'completed' } } });
  const job = exec.load(r.jobId);
  assert.equal(job.state, 'completed'); // read_only lifecycle updated
  assert.equal(exec.owner.owner, 'codex'); // writer unchanged
  assert.equal(exec.owner.unitId, 'writer-W'); // writer unit unchanged
});


// ---- M7 hardening R5: durable turn->unit identity survives executor restart ----

test('R5 fresh executor recovery: stale Turn A notification recognized as old unit A from durable state', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  // Executor A: create job A (workspace_write) and persist durable turn->unit identity.
  const execA = makeExecutor({ dataRoot: root });
  const rA = await execA.start({ prompt: 'a', accessMode: 'workspace_write' });
  await waitFor(() => execA.load(rA.jobId).state === 'completed');
  const turnA = rA.turnId;
  const unitA = execA.load(rA.jobId).mutationUnitId;
  const threadId = rA.threadId;
  assert.equal(execA.load(rA.jobId).turnUnits[turnA], unitA); // durable identity persisted

  // Persist the continue-transition state: current/pending unit B, turnId still A.
  const unitB = 'unit-b-recovery';
  execA.jobMap.update(rA.jobId, { mutationUnitId: unitB, state: 'starting', ownershipReleased: false });
  await execA.shutdown();

  // Executor B: a FRESH executor with the same dataRoot recovers the durable JobMap.
  const execB = makeExecutor({ dataRoot: root });
  t.after(() => execB.shutdown());
  const recovered = execB.load(rA.jobId);
  assert.equal(execB._turnUnits.size, 0);             // in-memory map empty (no manual repopulation)
  assert.equal(recovered.turnUnits[turnA], unitA);    // durable identity available from JobMap
  assert.equal(recovered.mutationUnitId, unitB);      // durable current/pending unit

  // Reconstruct the B writer from durable state (the writer, not the turn-unit identity).
  execB.owner.acquire('codex', unitB);
  assert.equal(execB.owner.owner, 'codex');
  assert.equal(execB.owner.unitId, unitB);

  // Inject a LATE Turn A terminal notification.
  execB._handleNotification({ method: 'turn/completed', params: { threadId, turn: { id: turnA, status: 'completed' } } });

  // Turn A must be recognized as old unit A: B writer untouched, B lifecycle unchanged.
  assert.equal(execB.owner.owner, 'codex');        // B writer NOT released
  assert.equal(execB.owner.unitId, unitB);         // B writer unit unchanged
  const after = execB.load(rA.jobId);
  assert.equal(after.state, 'starting');           // not rewritten to 'completed' by A
  assert.equal(after.turnId, turnA);               // unchanged
  assert.equal(after.mutationUnitId, unitB);       // unchanged
  assert.equal(after.turnUnits[turnA], unitA);     // durable identity intact

  // B can later start + complete normally (its association persisted durably on start).
  const turnB = 'turn-b-recovery';
  execB.jobMap.update(rA.jobId, { turnId: turnB, state: 'running' });
  execB._handleNotification({ method: 'turn/started', params: { threadId, turn: { id: turnB, status: 'inProgress' } } });
  assert.equal(execB.load(rA.jobId).turnUnits[turnB], unitB); // durable association for B
  execB._handleNotification({ method: 'turn/completed', params: { threadId, turn: { id: turnB, status: 'completed' } } });
  assert.equal(execB.owner.owner, 'none'); // B writer released after its own terminal
  assert.equal(execB.load(rA.jobId).state, 'completed');
});


// ---- M7 hardening R6: pending-continue / process-death recovery ------------

test('R6 get safety: transition mismatch -> recoveryRequired + codex_reconcile, B writer retained', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'workspace_write' });
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  const turnA = r.turnId;
  const unitA = exec.load(r.jobId).turnUnits[turnA];
  // Crash-window durable state: current unit B, turnId still A (belongs to unit A).
  exec.jobMap.update(r.jobId, { mutationUnitId: 'unitB', turnId: turnA, state: 'starting', ownershipReleased: false });
  exec.owner.acquire('codex', 'unitB');
  assert.equal(exec.owner.owner, 'codex');
  assert.equal(exec.owner.unitId, 'unitB');
  const st = await exec.get({ jobId: r.jobId });
  assert.equal(st.recoveryRequired, true);
  assert.equal(st.nextAction, 'codex_reconcile');
  assert.equal(exec.owner.owner, 'codex');       // B writer NOT released
  assert.equal(exec.owner.unitId, 'unitB');
  assert.equal(st.state, 'starting');             // not rewritten by Turn A terminal
  assert.equal(st.mutationUnitState, 'running');  // writer retained (not 'released')
});

test('R6 reconcile discovers unseen B inProgress and binds it durably', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, slowTurn: true });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'workspace_write' });
  const turnA = r.turnId;
  const unitA = exec.load(r.jobId).turnUnits[turnA];
  // Force-release A's writer so continue can create Turn B (simulating a remote continue).
  exec.owner.release({ force: true });
  const cont = await exec.continue({ jobId: r.jobId, instruction: 'b' });
  const turnB = cont.turnId;
  const unitB = exec.load(r.jobId).mutationUnitId;
  // Revert to the crash-window durable state: turnId=A (old unit), current unit B, no turnB binding.
  exec.jobMap.update(r.jobId, { turnId: turnA, mutationUnitId: unitB, turnUnits: { [turnA]: unitA }, state: 'running', ownershipReleased: false });
  exec.owner.release({ force: true });
  exec.owner.acquire('codex', unitB); // reconstruct exact B writer
  const rec = await exec.reconcile({ jobId: r.jobId });
  assert.equal(rec.resolution, 'in_progress');
  assert.equal(rec.reconciled, true);
  assert.equal(rec.recoveryRequired, false);
  assert.equal(exec.load(r.jobId).turnId, turnB);          // job.turnId updated to B
  assert.equal(exec.load(r.jobId).turnUnits[turnB], unitB); // durable binding
  assert.equal(exec.owner.owner, 'codex');
  assert.equal(exec.owner.unitId, unitB); // exact B writer retained
});

test('R6 reconcile discovers unseen B terminal and releases only exact B writer', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'workspace_write' });
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  const turnA = r.turnId;
  const unitA = exec.load(r.jobId).turnUnits[turnA];
  const cont = await exec.continue({ jobId: r.jobId, instruction: 'b' });
  const turnB = cont.turnId;
  const unitB = exec.load(r.jobId).mutationUnitId;
  await waitFor(() => exec.load(r.jobId).state === 'completed'); // turnB terminal
  // Crash-window durable state.
  exec.jobMap.update(r.jobId, { turnId: turnA, mutationUnitId: unitB, turnUnits: { [turnA]: unitA }, state: 'starting' });
  exec.owner.release({ force: true });
  exec.owner.acquire('codex', unitB);
  const rec = await exec.reconcile({ jobId: r.jobId });
  assert.equal(rec.resolution, 'terminal');
  assert.equal(rec.reconciled, true);
  assert.equal(exec.load(r.jobId).turnUnits[turnB], unitB);
  assert.equal(exec.owner.owner, 'none'); // only exact unitB released
});

test('R6 ambiguous recovery: 0 candidates -> unresolved fail closed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, slowTurn: true });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'workspace_write' });
  const turnA = r.turnId;
  const unitA = exec.load(r.jobId).turnUnits[turnA];
  exec.jobMap.update(r.jobId, { mutationUnitId: 'unit-no-turn', turnUnits: { [turnA]: unitA } });
  const rec = await exec.reconcile({ jobId: r.jobId });
  assert.equal(rec.resolution, 'unresolved');
  assert.equal(rec.reconciled, false);
  assert.equal(rec.recoveryRequired, true);
  assert.equal(exec.owner.owner, 'codex'); // retained / fail-closed
});

test('R6 ambiguous recovery: >1 candidates -> unresolved fail closed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'workspace_write' });
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  const cont = await exec.continue({ jobId: r.jobId, instruction: 'b' });
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  // Two turns exist in the thread but NONE durably mapped to the current unit -> >1 candidates.
  const unitB = exec.load(r.jobId).mutationUnitId;
  exec.jobMap.update(r.jobId, { mutationUnitId: unitB, turnUnits: {} });
  const rec = await exec.reconcile({ jobId: r.jobId });
  assert.equal(rec.resolution, 'unresolved');
  assert.equal(rec.reconciled, false);
  assert.equal(rec.recoveryRequired, true);
});

test('R6 resume foreign-owner protection: does not release/overwrite foreign codex/chatgpt unit', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await exec.start({ prompt: 'a', accessMode: 'workspace_write' });
  await waitFor(() => exec.load(r.jobId).state === 'completed');
  const turnA = r.turnId;
  const unitA = exec.load(r.jobId).turnUnits[turnA];
  exec.jobMap.update(r.jobId, { mutationUnitId: 'unitB', turnId: turnA, turnUnits: { [turnA]: unitA } });
  // Foreign codex unit C holds the workspace.
  exec.owner.acquire('codex', 'unitC');
  await assert.rejects(() => exec.resume({ jobId: r.jobId }), /no candidate|ownership conflict|ambiguous|multiple candidate/);
  assert.equal(exec.owner.owner, 'codex');  // unit C NOT released
  assert.equal(exec.owner.unitId, 'unitC');
  // Foreign chatgpt unit holds the workspace -> writer resume fail closed.
  exec.owner.release({ force: true });
  exec.owner.acquire('chatgpt', 'direct-unit');
  await assert.rejects(() => exec.resume({ jobId: r.jobId }), /no candidate|ownership conflict|ambiguous|multiple candidate|chatgpt/);
  assert.equal(exec.owner.owner, 'chatgpt'); // NOT overwritten
  assert.equal(exec.owner.unitId, 'direct-unit');
});
