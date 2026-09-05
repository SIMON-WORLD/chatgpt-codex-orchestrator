import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppServerExecutor } from '../../src/executor/app-server-executor.js';
import { JobMap } from '../../src/executor/job-map.js';

const BINDING = {
  taskId: 'post-m7-brain-continuity-implementation',
  stepId: 'brain-continuity-implementation',
  identity: 'brain-continuity@main:c4088fd3',
};

class DiagnosticClient {
  constructor(states = {}) {
    this.states = states;
    this.requests = [];
    this.isRunning = true;
    this._connected = true;
    this._closing = false;
  }
  onNotification() {}
  onServerRequest() {}
  onExit() {}
  async connect() { this.isRunning = true; this._connected = true; return this; }
  async close() { this.isRunning = false; this._connected = false; }
  async request(method, params) {
    this.requests.push({ method, params });
    const state = this.states[params.threadId];
    if (method === 'thread/resume') {
      if (!state || state.failResume) throw new Error(`RAW_RESUME_BACKEND:${params.threadId}`);
      if (state.resumeNoThreadIdentity) return { thread: {} };
      return { thread: { id: params.threadId } };
    }
    if (method === 'thread/read') {
      if (!state || state.failRead) throw new Error(`RAW_READ_BACKEND:${params.threadId}`);
      return { thread: { id: params.threadId, turns: state.turns } };
    }
    throw new Error(`unexpected request: ${method}`);
  }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-diagnostics-authoritative-'));
  const workspaceRoot = path.join(root, 'repo');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const client = new DiagnosticClient();
  const jobMap = new JobMap({ dataRoot: root });
  const exec = new AppServerExecutor({ client, jobMap });
  return { root, workspaceRoot, workspaceId: 'ws-current', client, jobMap, exec };
}

function candidate(x, name, stateSpec = {}, entryPatch = {}) {
  const created = x.jobMap.create();
  const threadId = `thread-${name}`;
  const turnId = `turn-${name}`;
  const unitId = `unit-${name}`;
  const turns = stateSpec.turns || [{ id: turnId, status: stateSpec.status || 'completed' }];
  const entry = {
    ...x.jobMap.load(created.jobId),
    ...BINDING,
    workspaceId: x.workspaceId,
    workspaceRoot: x.workspaceRoot,
    state: 'recovery_required',
    accessMode: 'workspace_write',
    isWriter: true,
    threadId,
    turnId,
    mutationUnitId: unitId,
    turnUnits: { [turnId]: unitId },
    ...entryPatch,
  };
  fs.writeFileSync(x.jobMap._file(created.jobId), JSON.stringify(entry, null, 2), 'utf8');
  x.client.states[threadId] = { turns, ...stateSpec };
  return { jobId: created.jobId, threadId, turnId, unitId };
}

function args(x) {
  return { workspaceId: x.workspaceId, workspaceRoot: x.workspaceRoot, ...BINDING };
}

function assertObservationOnly(client) {
  assert.ok(client.requests.length > 0);
  assert.ok(client.requests.every((r) => r.method === 'thread/resume' || r.method === 'thread/read'));
  for (const forbidden of ['thread/start', 'turn/start', 'turn/interrupt']) {
    assert.equal(client.requests.some((r) => r.method === forbidden), false);
  }
}

test('authoritative recovery preflight aggregates all seven structured observation categories without identity or raw-error leakage', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());

  const secrets = [];
  const missing = candidate(x, 'missing-thread', {}, { threadId: null });
  secrets.push(missing.jobId, missing.turnId);

  const resumeFailed = candidate(x, 'resume-failed', { failResume: true });
  secrets.push(resumeFailed.jobId, resumeFailed.threadId, resumeFailed.turnId);

  const resumeNoThread = candidate(x, 'resume-no-thread', { resumeNoThreadIdentity: true });
  secrets.push(resumeNoThread.jobId, resumeNoThread.threadId, resumeNoThread.turnId);

  const readFailed = candidate(x, 'read-failed', { failRead: true });
  secrets.push(readFailed.jobId, readFailed.threadId, readFailed.turnId);

  const bindingNone = candidate(x, 'binding-none', {}, { mutationUnitId: null, turnUnits: {} });
  secrets.push(bindingNone.jobId, bindingNone.threadId, bindingNone.turnId);

  const bindingMultiple = candidate(
    x,
    'binding-multiple',
    { turns: [{ id: 'turn-multiple-a', status: 'completed' }, { id: 'turn-multiple-b', status: 'completed' }] },
    { turnUnits: {} },
  );
  secrets.push(bindingMultiple.jobId, bindingMultiple.threadId, bindingMultiple.turnId, 'turn-multiple-a', 'turn-multiple-b');

  const lifecycleUnreadable = candidate(x, 'lifecycle-unreadable', { status: 'waitingOnApproval' });
  secrets.push(lifecycleUnreadable.jobId, lifecycleUnreadable.threadId, lifecycleUnreadable.turnId);

  const result = await x.exec.reconcileRecoveryPreflight(args(x));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'reconciliation_unresolved');
  assert.equal(result.unresolvedCandidateCount, 7);
  assert.deepEqual(result.reasonCounts, {
    missing_thread_identity: 1,
    resume_failed: 1,
    resume_no_thread_identity: 1,
    read_failed: 1,
    turn_binding_none: 1,
    turn_binding_multiple: 1,
    lifecycle_unreadable: 1,
  });
  assert.equal(Object.values(result.reasonCounts).reduce((a, b) => a + b, 0), result.unresolvedCandidateCount);

  const publicText = JSON.stringify(result);
  assert.equal(publicText.includes('RAW_RESUME_BACKEND'), false);
  assert.equal(publicText.includes('RAW_READ_BACKEND'), false);
  for (const secret of secrets) assert.equal(publicText.includes(secret), false);
  for (const forbiddenKey of ['jobId', 'threadId', 'turnId', 'createdAt', 'updatedAt', 'jobs', 'candidates']) {
    assert.equal(Object.prototype.hasOwnProperty.call(result, forbiddenKey), false);
  }
  assertObservationOnly(x.client);
});

test('authoritative recovery preflight preserves safe_to_start after terminal remediation', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  candidate(x, 'terminal-a', { status: 'completed' });
  candidate(x, 'terminal-b', { status: 'failed' });

  const result = await x.exec.reconcileRecoveryPreflight(args(x));
  assert.deepEqual(result, {
    ok: true,
    status: 'safe_to_start',
    dangerousCandidateCount: 0,
    nextAction: 'codex_start_allowed',
  });
  assertObservationOnly(x.client);
});

test('authoritative recovery preflight preserves unique recover_existing behavior', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  candidate(x, 'terminal', { status: 'completed' });
  const active = candidate(x, 'active', { status: 'inProgress' });

  const result = await x.exec.reconcileRecoveryPreflight(args(x));
  assert.equal(result.ok, true);
  assert.equal(result.status, 'recover_existing');
  assert.equal(result.dangerousCandidateCount, 1);
  assert.equal(result.nextAction, 'codex_reconcile');
  assert.equal(result.recovery.mode, 'job_id');
  assert.equal(result.recovery.jobId, active.jobId);
  assertObservationOnly(x.client);
});

test('authoritative recovery preflight preserves ambiguity when multiple active candidates remain', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  const a = candidate(x, 'active-a', { status: 'inProgress' });
  const b = candidate(x, 'active-b', { status: 'inProgress' });

  const result = await x.exec.reconcileRecoveryPreflight(args(x));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ambiguous');
  assert.equal(result.dangerousCandidateCount, 2);
  const text = JSON.stringify(result);
  for (const secret of [a.jobId, a.threadId, a.turnId, b.jobId, b.threadId, b.turnId]) assert.equal(text.includes(secret), false);
  assertObservationOnly(x.client);
});
