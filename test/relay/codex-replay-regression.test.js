import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayCore, RelayStore } from '../../src/relay/core.js';
import { RelayMcpFacade } from '../../src/relay/mcp-facade.js';
import { JobMap } from '../../src/executor/job-map.js';

const result = (value, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});
const body = (response) => JSON.parse(response.content[0].text);

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-235-regression-'));
  const store = new RelayStore(path.join(dir, 'relay.sqlite'));
  const core = new RelayCore({
    store, verifyBearer: async () => ({ issuer: 'https://issuer.example/', subject: 'user-a' }),
    presenceWindowMs: 60000,
  });
  const facade = new RelayMcpFacade({ core });
  const account = await core.accountForBearer('account-token');
  const begun = core.beginPairing({ displayName: 'Device A' });
  await core.approvePairing({ bearerToken: 'account-token', userCode: begun.userCode });
  const device = core.completePairing({ deviceCode: begun.deviceCode });
  const session = core.connectAgent({
    deviceId: device.deviceId, credential: device.credential,
    runtimeId: 'runtime-1', executorReady: true, protocolVersion: '1',
  });
  const workspace = store.createWorkspaceAffinity({
    accountId: account.account_id, deviceId: device.deviceId, runtimeId: 'runtime-1',
    localWorkspaceId: 'local-workspace', now: core.now(),
  });
  let closed = false;
  const close = () => { if (!closed) { closed = true; core.close(); store.close(); } };
  t.after(close);
  return { dir, store, core, facade, accountId: account.account_id, device, session, workspaceId: workspace.relay_workspace_id, close };
}

test('start requires a stable semantic identity before any device dispatch', async (t) => {
  const h = await setup(t);
  let sent = 0;
  h.core.dispatchForAccount = async () => { sent++; return result({ ok: true, status: 'safe_to_start', terminalIdentityChecked: true }); };
  await assert.rejects(h.facade.codexStart(h.accountId, {
    workspaceId: h.workspaceId, prompt: 'change code', accessMode: 'workspace_write',
    operationKey: 'delivery-key-001',
  }), (e) => e?.code === 'CODEX_BINDING_REQUIRED');
  assert.equal(sent, 0);
});

test('lost start acknowledgement and a new key cannot replay a terminal logical task', async (t) => {
  const h = await setup(t);
  const jobs = new JobMap({ dataRoot: h.dir });
  let starts = 0;
  h.core.dispatchForAccount = async ({ payload }) => {
    const { name, arguments: args } = payload.params;
    if (name === 'codex_recovery_preflight') {
      return result(jobs.recoveryPreflight({ workspaceId: args.workspaceId, identity: args.identity, rejectTerminalIdentity: args.rejectTerminalIdentity }));
    }
    assert.equal(name, 'codex_start');
    starts++;
    jobs.save('job-' + starts, {
      jobId: 'job-' + starts, workspaceId: args.workspaceId, identity: args.identity,
      state: 'completed',
    });
    if (starts === 1) return result({ error: { code: 'LOST_ACK_AFTER_COMPLETION' } }, true);
    return result({ jobId: 'job-' + starts, state: 'completed' });
  };
  const args = {
    workspaceId: h.workspaceId, prompt: 'same requested work', accessMode: 'workspace_write',
    identity: 'logical-task-1', operationKey: 'delivery-key-001',
  };
  await assert.rejects(h.facade.codexStart(h.accountId, args), (e) => e?.code === 'CODEX_LOCAL_REJECTED');
  assert.equal(jobs.recoveryPreflight({ workspaceId: 'local-workspace', identity: 'logical-task-1' }).status, 'safe_to_start');
  await assert.rejects(
    h.facade.codexStart(h.accountId, { ...args, operationKey: 'delivery-key-002' }),
    (e) => e?.code === 'CODEX_RECOVERY_REQUIRED',
  );
  assert.equal(starts, 1, 'terminal history ignored by preflight must not authorize replay');
  const distinct = await h.facade.codexStart(h.accountId, {
    ...args, identity: 'logical-task-2', operationKey: 'delivery-key-003',
  });
  assert.equal(body(distinct).state, 'completed');
  assert.equal(starts, 2, 'an explicitly distinct logical task remains possible');
});

test('a new workspace handle cannot defeat an ambiguous logical start', async (t) => {
  const h = await setup(t);
  const another = h.store.createWorkspaceAffinity({
    accountId: h.accountId, deviceId: h.device.deviceId, runtimeId: 'runtime-1',
    localWorkspaceId: 'local-workspace', now: h.core.now(),
  }).relay_workspace_id;
  let starts = 0;
  h.core.dispatchForAccount = async ({ payload }) => {
    if (payload.params.name === 'codex_recovery_preflight') return result({ ok: true, status: 'safe_to_start', terminalIdentityChecked: true });
    starts++;
    return result({ error: { code: 'LOST_ACK' } }, true);
  };
  const args = { workspaceId: h.workspaceId, prompt: 'task', accessMode: 'workspace_write',
    identity: 'logical-start', operationKey: 'delivery-key-001' };
  await assert.rejects(h.facade.codexStart(h.accountId, args), (e) => e?.code === 'CODEX_LOCAL_REJECTED');
  await assert.rejects(h.facade.codexStart(h.accountId, {
    ...args, workspaceId: another, operationKey: 'delivery-key-002',
  }), (e) => e?.code === 'CODEX_RECOVERY_REQUIRED');
  assert.equal(starts, 1);
});

test('lost completed continue acknowledgement cannot be replayed with a new key', async (t) => {
  const h = await setup(t);
  const job = h.store.createCodexJobAffinity({
    accountId: h.accountId, deviceId: h.device.deviceId, runtimeId: 'runtime-1',
    relayWorkspaceId: h.workspaceId, localJobId: 'local-job', now: h.core.now(),
  });
  let turns = 0;
  h.core.dispatchForAccount = async ({ payload }) => {
    assert.equal(payload.params.name, 'codex_continue');
    turns++;
    if (turns === 1) return result({ error: { code: 'LOST_ACK_AFTER_TERMINAL_TURN' } }, true);
    return result({ state: 'completed' });
  };
  const args = { workspaceId: h.workspaceId, jobId: job.relay_job_id,
    operationKey: 'continue-key-001', stepId: 'semantic-step-1', instruction: 'same step' };
  await assert.rejects(h.facade.codexJobTool(h.accountId, 'codex_continue', args), (e) => e?.code === 'CODEX_LOCAL_REJECTED');
  await assert.rejects(h.facade.codexJobTool(h.accountId, 'codex_continue', {
    ...args, operationKey: 'continue-key-002',
  }), (e) => e?.code === 'CODEX_RECOVERY_REQUIRED');
  assert.equal(turns, 1);
  const next = await h.facade.codexJobTool(h.accountId, 'codex_continue', {
    ...args, stepId: 'semantic-step-2', operationKey: 'continue-key-003',
  });
  assert.equal(body(next).state, 'completed');
  assert.equal(turns, 2, 'an explicitly distinct step remains possible');
});

test('runtime rollover between preflight and start sends no mutation to the new runtime', async (t) => {
  const h = await setup(t);
  const promise = h.facade.codexStart(h.accountId, {
    workspaceId: h.workspaceId, prompt: 'task', accessMode: 'workspace_write',
    identity: 'runtime-race-task', operationKey: 'runtime-race-001',
  });
  promise.catch(() => {});
  const preflight = await h.core.pollAgent({
    deviceId: h.device.deviceId, credential: h.device.credential, runtimeId: 'runtime-1',
    connectionEpoch: h.session.connectionEpoch, executorReady: true, protocolVersion: '1', holdMs: 1000,
  });
  assert.equal(preflight.payload.params.name, 'codex_recovery_preflight');
  h.core.respondAgent({
    deviceId: h.device.deviceId, credential: h.device.credential, runtimeId: 'runtime-1',
    connectionEpoch: h.session.connectionEpoch, requestId: preflight.requestId,
    response: result({ ok: true, status: 'safe_to_start', terminalIdentityChecked: true }),
  });
  const next = h.core.connectAgent({
    deviceId: h.device.deviceId, credential: h.device.credential,
    runtimeId: 'runtime-2', executorReady: true, protocolVersion: '1',
  });
  // The relay intentionally unrefs its poll timer; keep this test alive until it settles.
  const keepAlive = setTimeout(() => {}, 1000);
  const envelope = await h.core.pollAgent({
    deviceId: h.device.deviceId, credential: h.device.credential, runtimeId: 'runtime-2',
    connectionEpoch: next.connectionEpoch, executorReady: true, protocolVersion: '1', holdMs: 50,
  }).finally(() => clearTimeout(keepAlive));
  if (envelope) h.core.respondAgent({
    deviceId: h.device.deviceId, credential: h.device.credential, runtimeId: 'runtime-2',
    connectionEpoch: next.connectionEpoch, requestId: envelope.requestId,
    response: result({ jobId: 'should-not-start', state: 'running' }),
  });
  await assert.rejects(promise, (e) => ['STALE_WORKSPACE_HANDLE', 'DEVICE_RUNTIME_CHANGED'].includes(e?.code));
  assert.equal(envelope, null, 'the new runtime must receive zero mutating starts');
});

test('continue requires a stable logical step before any device dispatch', async (t) => {
  const h = await setup(t);
  const job = h.store.createCodexJobAffinity({
    accountId: h.accountId, deviceId: h.device.deviceId, runtimeId: 'runtime-1',
    relayWorkspaceId: h.workspaceId, localJobId: 'local-job', now: h.core.now(),
  });
  let sent = 0;
  h.core.dispatchForAccount = async () => { sent++; return result({ state: 'running' }); };
  await assert.rejects(h.facade.codexJobTool(h.accountId, 'codex_continue', {
    workspaceId: h.workspaceId, jobId: job.relay_job_id,
    operationKey: 'continue-key-001', instruction: 'continue',
  }), (e) => e?.code === 'CODEX_BINDING_REQUIRED');
  assert.equal(sent, 0);
});

test('ambiguous logical start remains fenced after reopening the relay store', async (t) => {
  const h = await setup(t);
  let firstStarts = 0;
  h.core.dispatchForAccount = async ({ payload }) => {
    if (payload.params.name === 'codex_recovery_preflight') return result({ ok: true, status: 'safe_to_start', terminalIdentityChecked: true });
    firstStarts++;
    return result({ error: { code: 'LOST_ACK' } }, true);
  };
  const args = { workspaceId: h.workspaceId, prompt: 'task', accessMode: 'workspace_write',
    identity: 'persisted-task', operationKey: 'delivery-key-001' };
  await assert.rejects(h.facade.codexStart(h.accountId, args), (e) => e?.code === 'CODEX_LOCAL_REJECTED');
  assert.equal(firstStarts, 1);
  h.close();

  const store = new RelayStore(path.join(h.dir, 'relay.sqlite'));
  const core = new RelayCore({
    store, verifyBearer: async () => ({ issuer: 'https://issuer.example/', subject: 'user-a' }),
    presenceWindowMs: 60000,
  });
  t.after(() => { core.close(); store.close(); });
  core.connectAgent({ deviceId: h.device.deviceId, credential: h.device.credential,
    runtimeId: 'runtime-1', executorReady: true, protocolVersion: '1' });
  const facade = new RelayMcpFacade({ core });
  let redispatches = 0;
  core.dispatchForAccount = async () => { redispatches++; return result({ ok: true, status: 'safe_to_start', terminalIdentityChecked: true }); };
  await assert.rejects(facade.codexStart(h.accountId, {
    ...args, operationKey: 'delivery-key-002',
  }), (e) => e?.code === 'CODEX_RECOVERY_REQUIRED');
  assert.equal(redispatches, 0);
});

test('an older unbound delivery intent cannot authorize a new logical start', async (t) => {
  const h = await setup(t);
  h.store.db.prepare('INSERT INTO codex_intents (account_id, relay_workspace_id, kind, operation_key, payload_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(h.accountId, h.workspaceId, 'start', 'legacy-key-001', 'a'.repeat(64), h.core.now());
  let sent = 0;
  h.core.dispatchForAccount = async () => { sent++; return result({ ok: true, status: 'safe_to_start', terminalIdentityChecked: true }); };
  await assert.rejects(h.facade.codexStart(h.accountId, {
    workspaceId: h.workspaceId, prompt: 'task', accessMode: 'workspace_write',
    identity: 'new-logical-task', operationKey: 'delivery-key-001',
  }), (e) => e?.code === 'CODEX_RECOVERY_REQUIRED');
  assert.equal(sent, 0);
});

test('simultaneous deliveries of one logical start dispatch only once', async (t) => {
  const h = await setup(t);
  let starts = 0;
  let releaseFirst;
  let signalFirst;
  const firstEntered = new Promise((resolve) => { signalFirst = resolve; });
  h.core.dispatchForAccount = async ({ payload }) => {
    if (payload.params.name === 'codex_recovery_preflight') return result({ ok: true, status: 'safe_to_start', terminalIdentityChecked: true });
    starts++;
    if (starts === 1) {
      signalFirst();
      return await new Promise((resolve) => { releaseFirst = resolve; });
    }
    return result({ jobId: 'duplicate-job', state: 'running' });
  };
  const args = { workspaceId: h.workspaceId, prompt: 'task', accessMode: 'workspace_write',
    identity: 'concurrent-task', operationKey: 'delivery-key-001' };
  const first = h.facade.codexStart(h.accountId, args);
  first.catch(() => {});
  await firstEntered;
  try {
    await assert.rejects(h.facade.codexStart(h.accountId, {
      ...args, operationKey: 'delivery-key-002',
    }), (e) => e?.code === 'CODEX_RECOVERY_REQUIRED');
    assert.equal(starts, 1);
  } finally {
    releaseFirst(result({ jobId: 'first-job', state: 'running' }));
    await first;
  }
});

test('a terminal device-local identity blocks start even without relay history', async (t) => {
  const h = await setup(t);
  const jobs = new JobMap({ dataRoot: h.dir });
  jobs.save('previous-job', {
    jobId: 'previous-job', workspaceId: 'local-workspace',
    identity: 'already-completed', state: 'completed',
  });
  let starts = 0;
  h.core.dispatchForAccount = async ({ payload }) => {
    const { name, arguments: args } = payload.params;
    if (name === 'codex_recovery_preflight') {
      return result(jobs.recoveryPreflight({ workspaceId: args.workspaceId, identity: args.identity,
        rejectTerminalIdentity: args.rejectTerminalIdentity }));
    }
    starts++;
    return result({ jobId: 'duplicate', state: 'running' });
  };
  await assert.rejects(h.facade.codexStart(h.accountId, {
    workspaceId: h.workspaceId, prompt: 'task', accessMode: 'workspace_write',
    identity: 'already-completed', operationKey: 'new-relay-001',
  }), (e) => e?.code === 'CODEX_RECOVERY_REQUIRED');
  assert.equal(starts, 0);
});

test('a device that does not attest terminal identity checking cannot start', async (t) => {
  const h = await setup(t);
  let starts = 0;
  h.core.dispatchForAccount = async ({ payload }) => {
    if (payload.params.name === 'codex_recovery_preflight') return result({ ok: true, status: 'safe_to_start' });
    starts++;
    return result({ jobId: 'should-not-start', state: 'running' });
  };
  await assert.rejects(h.facade.codexStart(h.accountId, {
    workspaceId: h.workspaceId, prompt: 'task', accessMode: 'workspace_write',
    identity: 'legacy-device-task', operationKey: 'legacy-device-001',
  }), (e) => e?.code === 'CODEX_RECOVERY_REQUIRED');
  assert.equal(starts, 0);
});

test('continuation cannot silently rebind the recovered job identity', async (t) => {
  const h = await setup(t);
  const job = h.store.createCodexJobAffinity({
    accountId: h.accountId, deviceId: h.device.deviceId, runtimeId: 'runtime-1',
    relayWorkspaceId: h.workspaceId, localJobId: 'local-job', now: h.core.now(),
  });
  let sent = 0;
  h.core.dispatchForAccount = async () => { sent++; return result({ state: 'running' }); };
  await assert.rejects(h.facade.codexJobTool(h.accountId, 'codex_continue', {
    workspaceId: h.workspaceId, jobId: job.relay_job_id, instruction: 'task',
    operationKey: 'continue-key-001', stepId: 'step-1', identity: 'different-job-identity',
  }), (e) => e?.code === 'CODEX_BINDING_IMMUTABLE');
  assert.equal(sent, 0);
});
