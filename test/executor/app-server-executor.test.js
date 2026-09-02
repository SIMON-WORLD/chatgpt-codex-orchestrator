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

function makeExecutor({ approval = '0', die = null, dataRoot = null, failTurnStart = false, slowTurn = false } = {}) {
  const root = dataRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const env = { ...process.env, FAKE_APP_SERVER_APPROVAL: approval, FAKE_APP_SERVER_STATE_DIR: root };
  if (die !== null) env.FAKE_APP_SERVER_DIE_MS = String(die);
  if (failTurnStart) env.FAKE_APP_SERVER_FAIL_TURN_START = '1';
  if (slowTurn) env.FAKE_APP_SERVER_SLOW_TURN = '1';
  const client = new AppServerClient({ codexBin: process.execPath, spawnArgs: [fixture], env });
  const jobMap = new JobMap({ dataRoot: root });
  return new AppServerExecutor({ client, jobMap });
}

async function startExecutor(executor, prompt = 'do the task') {
  const res = await executor.start({ prompt });
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
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await startExecutor(exec);
  const ir = await exec.interrupt({ jobId: r.jobId });
  assert.equal(ir.state, 'interrupted');
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
  const exec = makeExecutor({ die: 300, dataRoot: root });
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
  await assert.rejects(() => exec.start({ prompt: 'x' }), MutationOwnerError);
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
  exec.owner.markUnitState('reconciled');
  assert.equal(exec.release().released, true);
  assert.equal(exec.owner.owner, 'none');
  const c = await exec.continue({ jobId: r.jobId, instruction: 'continue' });
  assert.equal(exec.owner.owner, 'codex'); // continue acquired ownership
  assert.ok(c.turnId);
});

test('turn/start failure -> ownership cannot be silently handed to another writer', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, failTurnStart: true });
  t.after(() => exec.shutdown());
  await assert.rejects(() => exec.start({ prompt: 'x' }));
  assert.equal(exec.owner.owner, 'codex');
  assert.equal(exec.owner.unitState, 'unknown');
  assert.throws(() => exec.owner.release(), /not reconciled/);
  assert.throws(() => exec.owner.acquire('chatgpt', 'other'), /owned by codex/);
});

test('crash after threadId persisted but before turnId leaves provisional mapping', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root, failTurnStart: true });
  t.after(() => exec.shutdown());
  await assert.rejects(() => exec.start({ prompt: 'x' }));
  const job = exec.jobMap.list().find((j) => j.state === 'recovery_required');
  assert.ok(job);
  assert.ok(job.threadId);
  assert.equal(job.turnId, null);
});

test('restart loads provisional mapping after crash', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec1 = makeExecutor({ dataRoot: root, failTurnStart: true });
  await assert.rejects(() => exec1.start({ prompt: 'x' }));
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
  await assert.rejects(() => exec.start({ prompt: 'x' }));
  const job = exec.jobMap.list().find((j) => j.state === 'recovery_required');
  await assert.rejects(() => exec.resume({ jobId: job.jobId }), /refusing to guess|ambiguous/);
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
  await assert.rejects(() => exec.start({ prompt: 'b' }), MutationOwnerError);
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
  const exec = makeExecutor({ dataRoot: root, die: 300 });
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
  const exec = makeExecutor({ dataRoot: root, slowTurn: true, die: 300 });
  const r = await startExecutor(exec);
  assert.equal(exec.owner.unitState, 'running');
  await waitFor(() => exec.client.isRunning === false, 3000);
  const after = exec.load(r.jobId);
  assert.equal(after.state, 'recovery_required');
  assert.equal(exec.owner.unitState, 'unknown');
});

test('pending binary approval replay surfaced again, no second mutation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ approval: '1', dataRoot: root, die: 300 });
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
  await assert.rejects(() => execB.start({ prompt: 'b' }), MutationOwnerError);
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
