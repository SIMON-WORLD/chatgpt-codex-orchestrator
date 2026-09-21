import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AppServerExecutor,
  CODEX_START_PHASES,
  buildSandboxPolicy,
} from '../../src/executor/app-server-executor.js';
import { JobMap, PRE_TURN_NOT_MATERIALIZED } from '../../src/executor/job-map.js';

class RecoveryClient {
  constructor({ resumeError = null, turns = [], historyMode = null, replayBeforeResumeError = null, pages = null } = {}) {
    this.resumeError = resumeError;
    this.turns = turns;
    this.historyMode = historyMode;
    this.replayBeforeResumeError = replayBeforeResumeError;
    this.pages = pages;
    this.requests = [];
    this.isRunning = true;
    this._connected = true;
    this._closing = false;
  }
  onNotification(handler) { this.notificationHandler = handler; }
  onServerRequest() {}
  onExit(handler) { this.exitHandler = handler; }
  async connect() { this.isRunning = true; this._connected = true; return this; }
  async close() { this.isRunning = false; this._connected = false; }
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/resume') {
      if (this.replayBeforeResumeError && this.notificationHandler) {
        this.notificationHandler({
          method: 'turn/started',
          params: { threadId: params.threadId, turn: this.replayBeforeResumeError },
        });
      }
      if (this.resumeError) throw new Error(this.resumeError);
      return { thread: { id: params.threadId, ...(this.historyMode ? { historyMode: this.historyMode } : {}) } };
    }
    if (method === 'thread/read') {
      return { thread: { id: params.threadId, turns: this.turns, ...(this.historyMode ? { historyMode: this.historyMode } : {}) } };
    }
    if (method === 'thread/turns/list') {
      const index = params.cursor == null ? 0 : Number(params.cursor);
      const page = (this.pages || [this.turns])[index] || [];
      return { data: page, nextCursor: index + 1 < (this.pages || [this.turns]).length ? String(index + 1) : null };
    }
    throw new Error('unexpected request: ' + method);
  }
}

class StartClient {
  constructor() {
    this.requests = [];
    this.isRunning = true;
    this._connected = true;
    this._closing = false;
    this.beforeTurnStart = null;
  }
  onNotification(handler) { this.notificationHandler = handler; }
  onServerRequest() {}
  onExit() {}
  async connect() { return this; }
  async close() { this.isRunning = false; this._connected = false; }
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-start' }, sandbox: 'read-only' };
    if (method === 'thread/settings/update') {
      if (this.notificationHandler) {
        this.notificationHandler({
          method: 'thread/settings/updated',
          params: {
            threadId: params.threadId,
            threadSettings: {
              sandboxPolicy: params.sandboxPolicy,
              approvalPolicy: params.approvalPolicy,
              cwd: params.cwd,
              activePermissionProfile: null,
            },
          },
        });
      }
      return {};
    }
    if (method === 'turn/start') {
      if (this.beforeTurnStart) this.beforeTurnStart();
      return { turn: { id: 'turn-start' } };
    }
    throw new Error('unexpected request: ' + method);
  }
}

function fixture(clientOptions = {}, { persistenceProfile = 'configured' } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-turn-orphan-'));
  const workspaceRoot = path.join(dataRoot, 'repo');
  const profile = path.join(dataRoot, 'codex-home');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  const client = new RecoveryClient(clientOptions);
  const jobMap = new JobMap({ dataRoot });
  const exec = new AppServerExecutor({
    client,
    jobMap,
    persistenceProfile: persistenceProfile === 'configured' ? profile : persistenceProfile,
  });
  return { dataRoot, workspaceRoot, workspaceId: 'ws-141', profile, client, jobMap, exec };
}

function exactVerifiedContract(workspaceRoot, networkAccess = false) {
  const sandboxPolicy = buildSandboxPolicy('workspace_write', { workspaceRoot, networkAccess });
  return {
    accessMode: 'workspace_write',
    sandbox: 'workspace-write',
    sandboxPolicy,
    approvalPolicy: 'on-request',
    isWriter: true,
    networkAccess,
    requestPermission: { sandbox: 'workspace-write', approvalPolicy: 'on-request', sandboxPolicy },
    effectiveVerified: true,
    effectiveSandbox: 'workspace-write',
    effectiveApprovalPolicy: 'on-request',
    effectiveWritableRoots: [workspaceRoot],
    effectiveWritableRootMatch: true,
    effectiveNetworkAccess: networkAccess,
    verifiedForRequestedContract: JSON.stringify({ accessMode: 'workspace_write', networkAccess, sandboxPolicy }),
    verifiedAt: 123456789,
  };
}

function seedPreTurn(x, {
  threadId = 'thread-pre-turn',
  unitId = 'unit-pre-turn',
  phase = CODEX_START_PHASES.WRITER_RESERVED_TURN_START_PENDING,
  dispatched = false,
  state = 'recovery_required',
  persistenceProfile = x.profile,
  legacy = false,
  patch = {},
} = {}) {
  const base = x.jobMap.create();
  const entry = {
    ...x.jobMap.load(base.jobId),
    taskId: 'issue-141',
    stepId: 'runtime-fix',
    identity: 'issue-141-pre-turn-orphan-runtime',
    workspaceId: x.workspaceId,
    workspaceRoot: x.workspaceRoot,
    threadId,
    turnId: null,
    mutationUnitId: unitId,
    turnUnits: {},
    state,
    ownershipReleased: false,
    startupPhase: phase,
    turnStartDispatched: dispatched,
    persistenceProfile,
    ...exactVerifiedContract(x.workspaceRoot),
    ...patch,
  };
  if (legacy) {
    delete entry.startupPhase;
    delete entry.turnStartDispatched;
    delete entry.persistenceProfile;
  }
  x.jobMap.save(base.jobId, entry);
  return x.jobMap.load(base.jobId);
}

function exactNoRollout(threadId) {
  return 'app-server error: {"code":-32603,"message":"no rollout found for thread id ' + threadId + '"}';
}

test('startup ordering persists permission -> exact writer -> dispatch intent -> durable turn binding', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-turn-start-order-'));
  const workspaceRoot = path.join(dataRoot, 'repo');
  const profile = path.join(dataRoot, 'codex-home');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  const client = new StartClient();
  const jobMap = new JobMap({ dataRoot });
  const exec = new AppServerExecutor({ client, jobMap, persistenceProfile: profile });
  t.after(() => exec.shutdown());

  client.beforeTurnStart = () => {
    const job = jobMap.list()[0];
    assert.equal(job.effectiveVerified, true);
    assert.equal(job.startupPhase, CODEX_START_PHASES.WRITER_RESERVED_TURN_START_PENDING);
    assert.equal(job.turnStartDispatched, true);
    assert.equal(job.turnId, null);
    assert.equal(exec.owner.owner, 'codex');
    assert.equal(exec.owner.unitId, job.mutationUnitId);
  };

  const result = await exec.start({
    prompt: 'bounded write',
    accessMode: 'workspace_write',
    workspaceRoot,
    workspaceId: 'ws-order',
  });
  const job = jobMap.load(result.jobId);
  assert.equal(job.persistenceProfile, path.resolve(profile));
  assert.equal(job.startupPhase, CODEX_START_PHASES.TURN_BOUND);
  assert.equal(job.turnStartDispatched, true);
  assert.equal(job.turnUnits[result.turnId], job.mutationUnitId);
  assert.deepEqual(client.requests.map((r) => r.method), [
    'thread/start',
    'thread/settings/update',
    'turn/start',
  ]);
});

for (const dispatched of [false, true]) {
  test('exact no-rollout safely terminalizes a verified pre-turn orphan (dispatched=' + dispatched + ')', async (t) => {
    const x = fixture();
    t.after(() => x.exec.shutdown());
    const job = seedPreTurn(x, { dispatched });
    x.client.resumeError = exactNoRollout(job.threadId);
    x.exec.owner.acquire('codex', job.mutationUnitId);

    const result = await x.exec.reconcile({ jobId: job.jobId });
    assert.equal(result.reconciled, true);
    assert.equal(result.resolution, PRE_TURN_NOT_MATERIALIZED);
    assert.equal(result.recoveryCode, PRE_TURN_NOT_MATERIALIZED);
    assert.equal(result.recoveryRequired, false);
    assert.equal(result.ownershipReleased, true);
    assert.equal(x.exec.owner.owner, 'none');

    const durable = x.jobMap.load(job.jobId);
    assert.equal(durable.state, PRE_TURN_NOT_MATERIALIZED);
    assert.equal(durable.recoveryCode, PRE_TURN_NOT_MATERIALIZED);
    assert.equal(durable.reconciledMutationUnitId, job.mutationUnitId);
    assert.equal(durable.turnId, null);
  });
}

test('legacy exact orphan can use narrow same-dataRoot configured-profile compatibility path', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  const job = seedPreTurn(x, { legacy: true });
  x.client.resumeError = exactNoRollout(job.threadId);

  const result = await x.exec.reconcile({ jobId: job.jobId });
  assert.equal(result.resolution, PRE_TURN_NOT_MATERIALIZED);
  const durable = x.jobMap.load(job.jobId);
  assert.equal(durable.persistenceProfile, path.resolve(x.profile));
  assert.equal(durable.persistenceProfileInferredLegacy, true);
});

test('response-lost materialized terminal turn uses normal authoritative turn recovery', async (t) => {
  const x = fixture({ turns: [{ id: 'turn-real', status: 'completed' }] });
  t.after(() => x.exec.shutdown());
  const job = seedPreTurn(x);
  const result = await x.exec.reconcile({ jobId: job.jobId });
  assert.equal(result.resolution, 'terminal');
  assert.equal(result.state, 'completed');
  assert.equal(result.ownershipReleased, true);
  const durable = x.jobMap.load(job.jobId);
  assert.equal(durable.turnId, 'turn-real');
  assert.equal(durable.turnUnits['turn-real'], job.mutationUnitId);
  assert.equal(durable.state, 'completed');
  assert.notEqual(durable.recoveryCode, PRE_TURN_NOT_MATERIALIZED);
});

test('materialized inProgress turn is bound and retains exact writer', async (t) => {
  const x = fixture({ turns: [{ id: 'turn-live', status: 'inProgress' }] });
  t.after(() => x.exec.shutdown());
  const job = seedPreTurn(x);
  const result = await x.exec.reconcile({ jobId: job.jobId });
  assert.equal(result.resolution, 'in_progress');
  assert.equal(result.recoveryRequired, false);
  assert.equal(result.ownershipReleased, false);
  assert.equal(x.exec.owner.owner, 'codex');
  assert.equal(x.exec.owner.unitId, job.mutationUnitId);
  const durable = x.jobMap.load(job.jobId);
  assert.equal(durable.turnUnits['turn-live'], job.mutationUnitId);
  assert.equal(durable.state, 'running');
});

test('paginated materialized turn recovery remains authoritative', async (t) => {
  const x = fixture({ historyMode: 'paginated', pages: [[{ id: 'turn-page', status: 'completed' }]] });
  t.after(() => x.exec.shutdown());
  const job = seedPreTurn(x);
  const result = await x.exec.reconcile({ jobId: job.jobId });
  assert.equal(result.resolution, 'terminal');
  assert.equal(result.state, 'completed');
  assert.ok(x.client.requests.some((r) => r.method === 'thread/turns/list'));
});

test('generic resume failure retains recovery_required and never releases exact owner', async (t) => {
  const x = fixture({ resumeError: 'transport unavailable' });
  t.after(() => x.exec.shutdown());
  const job = seedPreTurn(x);
  x.exec.owner.acquire('codex', job.mutationUnitId);
  const result = await x.exec.reconcile({ jobId: job.jobId });
  assert.equal(result.reconciled, false);
  assert.equal(result.recoveryRequired, true);
  assert.equal(x.jobMap.load(job.jobId).state, 'recovery_required');
  assert.equal(x.exec.owner.owner, 'codex');
});

test('no-rollout error naming a different thread id retains ownership', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  const job = seedPreTurn(x);
  x.client.resumeError = exactNoRollout('thread-someone-else');
  x.exec.owner.acquire('codex', job.mutationUnitId);
  const result = await x.exec.reconcile({ jobId: job.jobId });
  assert.equal(result.reconciled, false);
  assert.equal(x.exec.owner.owner, 'codex');
  assert.equal(x.jobMap.load(job.jobId).state, 'recovery_required');
});

test('missing effective permission proof fails closed despite exact no-rollout', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  const job = seedPreTurn(x, { patch: { effectiveVerified: false } });
  x.client.resumeError = exactNoRollout(job.threadId);
  const result = await x.exec.reconcile({ jobId: job.jobId });
  assert.equal(result.reconciled, false);
  assert.equal(result.observationCode, 'pre_turn_permission_unverified');
  assert.equal(x.jobMap.load(job.jobId).state, 'recovery_required');
});

test('existing current-unit turn binding blocks pre-turn shortcut', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  const job = seedPreTurn(x, { patch: { turnUnits: { 'turn-evidence': 'unit-pre-turn' } } });
  x.client.resumeError = exactNoRollout(job.threadId);
  const result = await x.exec.reconcile({ jobId: job.jobId });
  assert.equal(result.reconciled, false);
  assert.equal(result.observationCode, 'pre_turn_unit_turn_binding_present');
  assert.equal(x.jobMap.load(job.jobId).state, 'recovery_required');
});

test('ambiguous legacy startup state stays fail closed', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  const job = seedPreTurn(x, { legacy: true, state: 'starting' });
  x.client.resumeError = exactNoRollout(job.threadId);
  const result = await x.exec.reconcile({ jobId: job.jobId });
  assert.equal(result.reconciled, false);
  assert.equal(result.observationCode, 'pre_turn_startup_phase_ambiguous');
  assert.equal(x.jobMap.load(job.jobId).state, 'recovery_required');
});

test('alternate persisted Codex profile cannot authorize no-rollout release', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  const otherProfile = path.join(x.dataRoot, 'other-codex-home');
  const job = seedPreTurn(x, { persistenceProfile: otherProfile });
  x.client.resumeError = exactNoRollout(job.threadId);
  const result = await x.exec.reconcile({ jobId: job.jobId });
  assert.equal(result.reconciled, false);
  assert.equal(result.observationCode, 'persistence_profile_mismatch');
  assert.equal(x.jobMap.load(job.jobId).state, 'recovery_required');
});

test('unknown current Codex persistence profile cannot authorize no-rollout release', async (t) => {
  const x = fixture({}, { persistenceProfile: null });
  t.after(() => x.exec.shutdown());
  const job = seedPreTurn(x, { persistenceProfile: null });
  x.client.resumeError = exactNoRollout(job.threadId);
  const result = await x.exec.reconcile({ jobId: job.jobId });
  assert.equal(result.reconciled, false);
  assert.equal(result.observationCode, 'persistence_profile_unknown');
});

test('replayed turn/started evidence defeats no-rollout shortcut', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  const job = seedPreTurn(x);
  x.client.replayBeforeResumeError = { id: 'turn-replayed', status: 'inProgress' };
  x.client.resumeError = exactNoRollout(job.threadId);
  const result = await x.exec.reconcile({ jobId: job.jobId });
  assert.equal(result.reconciled, false);
  assert.equal(result.observationCode, 'pre_turn_replayed_turn_evidence');
  const durable = x.jobMap.load(job.jobId);
  assert.equal(durable.turnId, null);
  assert.deepEqual(durable.turnUnits, {});
});

test('process death alone only marks recovery_required; it never terminalizes', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  const job = seedPreTurn(x, { state: 'starting' });
  x.exec.owner.acquire('codex', job.mutationUnitId);
  x.exec._handleClientExit({ type: 'exit', code: 1, signal: null });
  assert.equal(x.jobMap.load(job.jobId).state, 'recovery_required');
  assert.notEqual(x.jobMap.load(job.jobId).state, PRE_TURN_NOT_MATERIALIZED);
  assert.equal(x.exec.owner.owner, 'codex');
  assert.equal(x.exec.owner.unitState, 'unknown');
});

test('safe classification cannot release a foreign MutationOwner', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  const job = seedPreTurn(x);
  x.client.resumeError = exactNoRollout(job.threadId);
  x.exec.owner.acquire('codex', 'foreign-unit');
  const result = await x.exec.reconcile({ jobId: job.jobId });
  assert.equal(result.reconciled, false);
  assert.equal(result.observationCode, 'pre_turn_foreign_owner');
  assert.equal(x.exec.owner.owner, 'codex');
  assert.equal(x.exec.owner.unitId, 'foreign-unit');
  assert.equal(x.jobMap.load(job.jobId).state, 'recovery_required');
});

test('recovery preflight becomes safe only after durable pre-turn terminalization', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  const job = seedPreTurn(x);
  x.client.resumeError = exactNoRollout(job.threadId);
  const args = {
    workspaceId: x.workspaceId,
    workspaceRoot: x.workspaceRoot,
    taskId: 'issue-141',
    stepId: 'runtime-fix',
    identity: 'issue-141-pre-turn-orphan-runtime',
  };
  const before = x.jobMap.recoveryPreflight(args);
  assert.equal(before.status, 'recover_existing');
  assert.equal(before.dangerousCandidateCount, 1);

  const reconciled = await x.exec.reconcileRecoveryPreflight(args);
  assert.equal(reconciled.status, 'safe_to_start');
  assert.equal(reconciled.dangerousCandidateCount, 0);
  assert.equal(x.jobMap.load(job.jobId).state, PRE_TURN_NOT_MATERIALIZED);

  const after = x.jobMap.recoveryPreflight(args);
  assert.equal(after.status, 'safe_to_start');
  assert.equal(after.dangerousCandidateCount, 0);
});

test('durable no-turn terminal state is idempotent and does not re-query App Server', async (t) => {
  const x = fixture();
  t.after(() => x.exec.shutdown());
  const job = seedPreTurn(x);
  x.client.resumeError = exactNoRollout(job.threadId);
  await x.exec.reconcile({ jobId: job.jobId });
  const count = x.client.requests.length;
  const second = await x.exec.reconcile({ jobId: job.jobId });
  assert.equal(second.resolution, PRE_TURN_NOT_MATERIALIZED);
  assert.equal(second.recoveryRequired, false);
  assert.equal(x.client.requests.length, count);
});
