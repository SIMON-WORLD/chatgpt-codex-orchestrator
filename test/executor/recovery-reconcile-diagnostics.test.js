import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppServerExecutor } from '../../src/executor/app-server-executor.js';
import { JobMap } from '../../src/executor/job-map.js';
import { reconcileRecoveryPreflightWithDiagnostics } from '../../src/executor/recovery-reconcile-diagnostics.js';

const BINDING = {
  taskId: 'post-m7-brain-continuity-implementation',
  stepId: 'brain-continuity-implementation',
  identity: 'brain-continuity@main:c4088fd3',
};

class DiagnosticClient {
  constructor() {
    this.states = {};
    this.requests = [];
    this.isRunning = true;
    this._connected = true;
    this._closing = false;
  }
  onNotification() {}
  onServerRequest() {}
  onExit() {}
  async connect() { return this; }
  async close() { this.isRunning = false; this._connected = false; }
  async request(method, params) {
    this.requests.push({ method, threadId: params.threadId });
    const state = this.states[params.threadId] || {};
    if (method === 'thread/resume') {
      if (state.resumeError) throw new Error(state.resumeError);
      if (state.resumeNoThreadIdentity) return { thread: {} };
      return { thread: { id: params.threadId } };
    }
    if (method === 'thread/read') {
      if (state.readError) throw new Error(state.readError);
      return { thread: { id: params.threadId, turns: state.turns || [] } };
    }
    throw new Error(`unexpected request: ${method}`);
  }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-diagnostics-'));
  const workspaceRoot = path.join(root, 'repo');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const client = new DiagnosticClient();
  const jobMap = new JobMap({ dataRoot: root });
  const exec = new AppServerExecutor({ client, jobMap });
  return { root, workspaceRoot, workspaceId: 'ws-current', client, jobMap, exec };
}

function candidate(x, name, options = {}) {
  const created = x.jobMap.create();
  const threadId = options.threadId === null ? null : `thread-${name}`;
  const turnId = `turn-${name}`;
  const unitId = options.mutationUnitId === null ? null : `unit-${name}`;
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
    turnUnits: options.turnUnits ?? (unitId ? { [turnId]: unitId } : {}),
  };
  fs.writeFileSync(x.jobMap._file(created.jobId), JSON.stringify(entry, null, 2), 'utf8');
  if (threadId) {
    x.client.states[threadId] = {
      turns: options.turns ?? [{ id: turnId, status: options.status || 'completed' }],
      resumeError: options.resumeError,
      resumeNoThreadIdentity: options.resumeNoThreadIdentity,
      readError: options.readError,
    };
  }
  return { jobId: created.jobId, threadId, turnId, unitId };
}

function args(x) {
  return { workspaceId: x.workspaceId, workspaceRoot: x.workspaceRoot, ...BINDING };
}

test('aggregate recovery diagnostics classify every authoritative observation failure without leaking identities or raw App Server errors', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());

  const identities = [];
  identities.push(candidate(x, 'missing-thread', { threadId: null }));
  identities.push(candidate(x, 'resume-failed', { resumeError: 'SECRET_RESUME_FAILURE_TEXT' }));
  identities.push(candidate(x, 'resume-no-thread', { resumeNoThreadIdentity: true }));
  identities.push(candidate(x, 'read-failed', { readError: 'SECRET_READ_FAILURE_TEXT' }));
  identities.push(candidate(x, 'binding-none', { mutationUnitId: null, turnUnits: {} }));
  identities.push(candidate(x, 'binding-multiple', {
    turnUnits: {},
    turns: [
      { id: 'turn-binding-multiple-a', status: 'completed' },
      { id: 'turn-binding-multiple-b', status: 'completed' },
    ],
  }));
  identities.push(candidate(x, 'lifecycle-unreadable', { status: 'paused' }));

  const result = await reconcileRecoveryPreflightWithDiagnostics(x.exec, args(x));

  assert.deepEqual(result, {
    ok: false,
    error: 'reconciliation_unresolved',
    reason: 'one or more hidden recovery-risk executions could not be authoritatively reconciled; refusing to infer safety',
    unresolvedCandidateCount: 7,
    reasonCounts: {
      missing_thread_identity: 1,
      resume_failed: 1,
      resume_no_thread_identity: 1,
      read_failed: 1,
      turn_binding_none: 1,
      turn_binding_multiple: 1,
      lifecycle_unreadable: 1,
    },
  });

  const publicJson = JSON.stringify(result);
  assert.equal(publicJson.includes('SECRET_RESUME_FAILURE_TEXT'), false);
  assert.equal(publicJson.includes('SECRET_READ_FAILURE_TEXT'), false);
  assert.equal('jobId' in result, false);
  assert.equal('threadId' in result, false);
  assert.equal('turnId' in result, false);
  assert.equal('jobs' in result, false);
  assert.equal('candidates' in result, false);
  assert.equal('createdAt' in result, false);
  assert.equal('updatedAt' in result, false);
  for (const value of identities.flatMap((i) => [i.jobId, i.threadId, i.turnId]).filter(Boolean)) {
    assert.equal(publicJson.includes(value), false);
  }
  assert.equal(x.client.requests.some((r) => r.method === 'thread/start'), false);
  assert.equal(x.client.requests.some((r) => r.method === 'turn/start'), false);
  assert.equal(x.client.requests.some((r) => r.method === 'turn/interrupt'), false);
});

test('diagnostic wrapper preserves terminal and in-progress remediation semantics', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  candidate(x, 'terminal-a', { status: 'completed' });
  const active = candidate(x, 'active', { status: 'inProgress' });
  candidate(x, 'terminal-b', { status: 'failed' });

  const result = await reconcileRecoveryPreflightWithDiagnostics(x.exec, args(x));
  assert.equal(result.ok, true);
  assert.equal(result.status, 'recover_existing');
  assert.equal(result.dangerousCandidateCount, 1);
  assert.equal(result.nextAction, 'codex_reconcile');
  assert.equal(result.recovery.mode, 'job_id');
  assert.equal(result.recovery.jobId, active.jobId);
  assert.deepEqual(result.recovery.binding, BINDING);
});
