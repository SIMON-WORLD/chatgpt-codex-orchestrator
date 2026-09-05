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

class ReconcileOnlyClient {
  constructor(states = {}) {
    this.states = states;
    this.requests = [];
    this.isRunning = true;
    this._connected = true;
    this._closing = false;
  }
  onNotification(handler) { this.notificationHandler = handler; }
  onServerRequest() {}
  onExit() {}
  async connect() { this.isRunning = true; this._connected = true; return this; }
  async close() { this.isRunning = false; this._connected = false; }
  async request(method, params) {
    this.requests.push({ method, params });
    const state = this.states[params.threadId];
    if (method === 'thread/resume') {
      if (!state || state.failResume) throw new Error('resume unavailable');
      if (state.replayTurnStarted && this.notificationHandler) {
        const turn = state.turns.find((t) => t.status === 'inProgress');
        if (turn) this.notificationHandler({ method: 'turn/started', params: { threadId: params.threadId, turn } });
      }
      return { thread: { id: params.threadId } };
    }
    if (method === 'thread/read') {
      if (!state || state.failRead) throw new Error('read unavailable');
      return { thread: { id: params.threadId, turns: state.turns } };
    }
    throw new Error(`unexpected request: ${method}`);
  }
}

function fixture(states = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-remediation-'));
  const workspaceRoot = path.join(root, 'repo');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const client = new ReconcileOnlyClient(states);
  const jobMap = new JobMap({ dataRoot: root });
  const exec = new AppServerExecutor({ client, jobMap });
  return { root, workspaceRoot, workspaceId: 'ws-current', client, jobMap, exec };
}

function candidate(x, name, status, { createdAt = 100, updatedAt = 100 } = {}) {
  const job = x.jobMap.create();
  const threadId = `thread-${name}`;
  const turnId = `turn-${name}`;
  const unitId = `unit-${name}`;
  const entry = {
    ...x.jobMap.load(job.jobId),
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
    createdAt,
    updatedAt,
  };
  fs.writeFileSync(x.jobMap._file(job.jobId), JSON.stringify(entry, null, 2), 'utf8');
  x.client.states[threadId] = { turns: [{ id: turnId, status }] };
  return { jobId: job.jobId, threadId, turnId, unitId };
}

function remediationArgs(x) {
  return { workspaceId: x.workspaceId, workspaceRoot: x.workspaceRoot, ...BINDING };
}

function assertReconcileOnlyRequests(client) {
  assert.ok(client.requests.length > 0);
  assert.ok(client.requests.every((r) => r.method === 'thread/resume' || r.method === 'thread/read'));
  assert.equal(client.requests.some((r) => r.method === 'thread/start'), false);
  assert.equal(client.requests.some((r) => r.method === 'turn/start'), false);
  assert.equal(client.requests.some((r) => r.method === 'turn/interrupt'), false);
}

test('recovery remediation: one stale terminal candidate is cleared rather than mechanically recovered', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  candidate(x, 'single-stale', 'completed');

  const result = await x.exec.reconcileRecoveryPreflight(remediationArgs(x));
  assert.equal(result.status, 'safe_to_start');
  assert.equal(result.dangerousCandidateCount, 0);
  assertReconcileOnlyRequests(x.client);
});

test('recovery remediation: three stale candidates reconcile terminal -> safe_to_start', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  candidate(x, 'a', 'completed');
  candidate(x, 'b', 'failed');
  candidate(x, 'c', 'interrupted');

  const before = x.jobMap.recoveryPreflight(remediationArgs(x));
  assert.equal(before.error, 'ambiguous');
  assert.equal(before.dangerousCandidateCount, 3);

  const result = await x.exec.reconcileRecoveryPreflight(remediationArgs(x));
  assert.deepEqual(result, {
    ok: true,
    status: 'safe_to_start',
    dangerousCandidateCount: 0,
    nextAction: 'codex_start_allowed',
  });
  assertReconcileOnlyRequests(x.client);
});

test('recovery remediation: two terminal + one active returns the unique existing execution, never newest', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  candidate(x, 'terminal-newest-1', 'completed', { createdAt: 9999, updatedAt: 9999 });
  const active = candidate(x, 'active-oldest', 'inProgress', { createdAt: 1, updatedAt: 1 });
  candidate(x, 'terminal-newest-2', 'failed', { createdAt: 10000, updatedAt: 10000 });

  const result = await x.exec.reconcileRecoveryPreflight(remediationArgs(x));
  assert.equal(result.ok, true);
  assert.equal(result.status, 'recover_existing');
  assert.equal(result.dangerousCandidateCount, 1);
  assert.equal(result.recovery.jobId, active.jobId);
  assert.equal(result.nextAction, 'codex_reconcile');
  assert.equal(result.recovery.mode, 'job_id');
  assert.deepEqual(result.recovery.binding, BINDING);
  assert.equal('createdAt' in result, false);
  assert.equal('updatedAt' in result, false);
  assertReconcileOnlyRequests(x.client);
});

test('recovery remediation: two genuinely active candidates remain ambiguous without identity disclosure', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  candidate(x, 'a', 'inProgress');
  candidate(x, 'b', 'inProgress');

  const result = await x.exec.reconcileRecoveryPreflight(remediationArgs(x));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ambiguous');
  assert.equal(result.dangerousCandidateCount, 2);
  assert.equal('jobId' in result, false);
  assert.equal('jobs' in result, false);
  assert.equal('candidates' in result, false);
  assertReconcileOnlyRequests(x.client);
});

test('recovery remediation: replayed in-progress notifications cannot let hidden candidates acquire MutationOwner', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  const a = candidate(x, 'a', 'inProgress');
  const b = candidate(x, 'b', 'inProgress');
  x.client.states[a.threadId].replayTurnStarted = true;
  x.client.states[b.threadId].replayTurnStarted = true;

  const result = await x.exec.reconcileRecoveryPreflight(remediationArgs(x));
  assert.equal(result.error, 'ambiguous');
  assert.equal(result.dangerousCandidateCount, 2);
  assert.equal(x.exec.owner.owner, 'none');
});

test('recovery remediation: an unreconcilable hidden candidate fails closed and leaks no candidate identity', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  candidate(x, 'terminal', 'completed');
  const broken = candidate(x, 'broken', 'completed');
  x.client.states[broken.threadId].failRead = true;

  const result = await x.exec.reconcileRecoveryPreflight(remediationArgs(x));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'reconciliation_unresolved');
  assert.equal(result.unresolvedCandidateCount, 1);
  assert.equal('jobId' in result, false);
  assert.equal('jobs' in result, false);
  assert.equal('candidates' in result, false);
  assert.equal(JSON.stringify(result).includes(broken.jobId), false);
  assert.equal(JSON.stringify(result).includes(broken.threadId), false);
  assertReconcileOnlyRequests(x.client);
});
