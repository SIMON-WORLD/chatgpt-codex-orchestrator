import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppServerExecutor } from '../../src/executor/app-server-executor.js';
import { AppServerClient } from '../../src/executor/app-server-client.js';
import { JobMap } from '../../src/executor/job-map.js';
import { ApprovalError } from '../../src/executor/approval.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, '..', '..', 'test-fixtures', 'executor', 'fake-app-server.mjs');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(fn, timeout = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await sleep(5);
  }
  return false;
}

function makeExecutor({ approval = '0', die = null, dataRoot = null } = {}) {
  const env = { ...process.env, FAKE_APP_SERVER_APPROVAL: approval };
  if (die !== null) env.FAKE_APP_SERVER_DIE_MS = String(die);
  const client = new AppServerClient({ codexBin: process.execPath, spawnArgs: [fixture], env });
  const jobMap = new JobMap({ dataRoot });
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
  // Persisted mapping is readable independently of the live session.
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
  assert.ok(st.turn && st.turn.status);
});

test('continue reuses SAME thread and gets a new turnId', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await startExecutor(exec);
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
  const job = exec.load(r.jobId);
  assert.equal(await waitFor(() => exec.load(r.jobId).state === 'interrupted'), true);
});

test('approval is surfaced and exact approval response is accepted', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ approval: '1', dataRoot: root });
  t.after(() => exec.shutdown());
  const r = await startExecutor(exec);
  // Wait for the approval handler to record the pending approval.
  assert.equal(await waitFor(() => exec._approvals.size > 0), true);
  const approvalId = [...exec._approvals.keys()][0];
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
  // client.isRunning should be false; the child exited.
  assert.equal(exec.client.isRunning, false);
});

test('simulated process death is detected', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-'));
  const exec = makeExecutor({ die: 20, dataRoot: root });
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
  const resumed = await exec.resume({ jobId: r.jobId });
  const job = exec.load(r.jobId);
  // threadId/turnId unchanged: resume did not start a new thread/turn.
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
