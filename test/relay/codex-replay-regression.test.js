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
  t.after(() => { core.close(); store.close(); });
  return { dir, store, core, facade, accountId: account.account_id, device, session, workspaceId: workspace.relay_workspace_id };
}

test('start requires a stable semantic identity before any device dispatch', async (t) => {
  const h = await setup(t);
  let sent = 0;
  h.core.dispatchForAccount = async () => { sent++; return result({ ok: true, status: 'safe_to_start' }); };
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
      return result(jobs.recoveryPreflight({ workspaceId: args.workspaceId, identity: args.identity }));
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
    if (payload.params.name === 'codex_recovery_preflight') return result({ ok: true, status: 'safe_to_start' });
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
    response: result({ ok: true, status: 'safe_to_start' }),
  });
  const next = h.core.connectAgent({
    deviceId: h.device.deviceId, credential: h.device.credential,
    runtimeId: 'runtime-2', executorReady: true, protocolVersion: '1',
  });
  const envelope = await h.core.pollAgent({
    deviceId: h.device.deviceId, credential: h.device.credential, runtimeId: 'runtime-2',
    connectionEpoch: next.connectionEpoch, executorReady: true, protocolVersion: '1', holdMs: 50,
  });
  if (envelope) h.core.respondAgent({
    deviceId: h.device.deviceId, credential: h.device.credential, runtimeId: 'runtime-2',
    connectionEpoch: next.connectionEpoch, requestId: envelope.requestId,
    response: result({ jobId: 'should-not-start', state: 'running' }),
  });
  await assert.rejects(promise, (e) => ['STALE_WORKSPACE_HANDLE', 'DEVICE_RUNTIME_CHANGED'].includes(e?.code));
  assert.equal(envelope, null, 'the new runtime must receive zero mutating starts');
});
