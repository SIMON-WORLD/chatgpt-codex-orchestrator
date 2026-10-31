import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { RelayCore, RelayError, RelayStore } from '../../src/relay/core.js';
import { RelayMcpFacade } from '../../src/relay/mcp-facade.js';
import { startRelayMcpServer } from '../../src/relay/mcp-server.js';

async function verifyBearer(token) {
  if (token === 'acct-a') return { issuer: 'https://issuer.example/', subject: 'user-a' };
  if (token === 'acct-b') return { issuer: 'https://issuer.example/', subject: 'user-b' };
  throw new RelayError('INVALID_BEARER', 'invalid bearer', 401);
}

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-183-relay-'));
  const store = new RelayStore(path.join(dir, 'relay.sqlite'));
  const logs = [];
  let clock = Date.now();
  const core = new RelayCore({
    store,
    verifyBearer,
    now: () => clock,
    presenceWindowMs: 60_000,
    logger: (entry) => logs.push(entry),
  });
  const facade = new RelayMcpFacade({ core });
  t.after(() => {
    core.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, core, facade, logs, advance: (ms) => { clock += ms; } };
}

async function pair(core, bearerToken, displayName, runtimeId, executorReady = true) {
  const started = core.beginPairing({ displayName });
  await core.approvePairing({ bearerToken, userCode: started.userCode });
  const paired = core.completePairing({ deviceCode: started.deviceCode });
  const session = core.connectAgent({
    deviceId: paired.deviceId,
    credential: paired.credential,
    runtimeId,
    executorReady,
    protocolVersion: '1',
  });
  return { ...paired, session, runtimeId };
}

function mcpResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function textJson(result) {
  const item = result?.content?.find?.((entry) => entry?.type === 'text');
  return item ? JSON.parse(item.text) : null;
}

async function answerNext(core, device, responseFactory, pending, holdMs = 1000) {
  const envelope = await core.pollAgent({
    deviceId: device.deviceId,
    credential: device.credential,
    runtimeId: device.runtimeId,
    connectionEpoch: device.session.connectionEpoch,
    executorReady: true,
    protocolVersion: '1',
    holdMs,
  });
  assert.ok(envelope, 'expected a dispatched relay request');
  const response = await responseFactory(envelope.payload);
  core.respondAgent({
    deviceId: device.deviceId,
    credential: device.credential,
    runtimeId: device.runtimeId,
    connectionEpoch: device.session.connectionEpoch,
    requestId: envelope.requestId,
    response,
  });
  return pending;
}

test('device selection is account-isolated, display-name independent, and list_devices leaks no relay/device secrets', async (t) => {
  const { core, facade } = harness(t);
  const accountA = await core.accountForBearer('acct-a');
  await assert.rejects(
    () => facade.workspaceOpen(accountA.account_id, { path: '/tmp/no-device' }),
    (error) => error?.code === 'NO_READY_DEVICE',
  );

  const a1 = await pair(core, 'acct-a', 'Same Name', 'runtime-a1');
  const listedA = facade.listDevices(accountA.account_id);
  assert.equal(listedA.length, 1);
  assert.equal(listedA[0].deviceId, a1.deviceId);
  assert.equal(listedA[0].displayName, 'Same Name');
  assert.equal(listedA[0].online, true);
  assert.equal(listedA[0].executorReady, true);
  assert.equal(listedA[0].ready, true);
  assert.ok(Number.isInteger(listedA[0].lastSeenAt));
  const publicText = JSON.stringify(facade.listDevices(accountA.account_id));
  assert.equal(publicText.includes(a1.credential), false);
  assert.equal(publicText.includes('runtime-a1'), false);
  assert.equal(publicText.includes('selected_roots'), false);
  assert.equal(publicText.includes('os_user_scope'), false);

  const autoPending = facade.workspaceOpen(accountA.account_id, { path: '/tmp/work-a' });
  const auto = await answerNext(core, a1, async (payload) => {
    assert.equal(payload.params.name, 'workspace_open');
    assert.deepEqual(payload.params.arguments, { path: '/tmp/work-a' });
    return mcpResult({ workspaceId: 'local-ws-a', root: '/tmp/work-a' });
  }, autoPending);
  const autoResult = await auto;
  const autoBody = textJson(autoResult);
  assert.match(autoBody.workspaceId, /^ws_/u);
  assert.notEqual(autoBody.workspaceId, 'local-ws-a');

  const a2 = await pair(core, 'acct-a', 'Same Name', 'runtime-a2');
  await assert.rejects(
    () => facade.workspaceOpen(accountA.account_id, { path: '/tmp/ambiguous' }),
    (error) => error?.code === 'DEVICE_SELECTION_REQUIRED',
  );

  const explicitPending = facade.workspaceOpen(accountA.account_id, { path: '/tmp/work-b', deviceId: a2.deviceId });
  const explicit = await answerNext(core, a2, async (payload) => {
    assert.equal(payload.params.arguments.deviceId, undefined);
    return mcpResult({ workspaceId: 'local-ws-b', root: '/tmp/work-b' });
  }, explicitPending);
  assert.match(textJson(await explicit).workspaceId, /^ws_/u);

  const b1 = await pair(core, 'acct-b', 'Same Name', 'runtime-b1');
  await assert.rejects(
    () => facade.workspaceOpen(accountA.account_id, { path: '/tmp/foreign', deviceId: b1.deviceId }),
    (error) => error?.code === 'DEVICE_NOT_FOUND',
  );

  const accountB = await core.accountForBearer('acct-b');
  assert.deepEqual(facade.listDevices(accountB.account_id).map((d) => d.deviceId), [b1.deviceId]);
});

test('relay workspace/process handles preserve exact device+runtime affinity and fail closed on restart, revoke, readiness loss and forgery', async (t) => {
  const { core, facade, logs, advance } = harness(t);
  let a = await pair(core, 'acct-a', 'Device A', 'runtime-a');
  const b = await pair(core, 'acct-a', 'Device B', 'runtime-b');
  const account = await core.accountForBearer('acct-a');

  const openPending = facade.workspaceOpen(account.account_id, { path: '/workspace/a', deviceId: a.deviceId });
  const opened = await answerNext(core, a, async () => mcpResult({ workspaceId: 'local-workspace-secret', root: '/workspace/a' }), openPending);
  const relayWorkspaceId = textJson(await opened).workspaceId;
  assert.notEqual(relayWorkspaceId, 'local-workspace-secret');

  const readPending = facade.workspaceTool(account.account_id, 'read', { workspaceId: relayWorkspaceId, path: 'a.txt' });
  const read = await answerNext(core, a, async (payload) => {
    assert.equal(payload.params.name, 'read');
    assert.equal(payload.params.arguments.workspaceId, 'local-workspace-secret');
    return mcpResult({ workspaceId: 'local-workspace-secret', content: 'from-a' });
  }, readPending);
  assert.deepEqual(textJson(await read), { workspaceId: relayWorkspaceId, content: 'from-a' });

  const bPoll = await core.pollAgent({
    deviceId: b.deviceId,
    credential: b.credential,
    runtimeId: b.runtimeId,
    connectionEpoch: b.session.connectionEpoch,
    executorReady: true,
    protocolVersion: '1',
    holdMs: 0,
  });
  assert.equal(bPoll, null, 'bound calls must not spill to another Ready device');

  const startPending = facade.workspaceTool(account.account_id, 'process_start', {
    workspaceId: relayWorkspaceId,
    command: 'echo relay-secret-command',
  });
  const started = await answerNext(core, a, async (payload) => {
    assert.equal(payload.params.arguments.workspaceId, 'local-workspace-secret');
    return mcpResult({ processHandle: 'local-process-secret', status: 'running', output: '' });
  }, startPending);
  const startBody = textJson(await started);
  assert.match(startBody.processHandle, /^proc_/u);
  assert.notEqual(startBody.processHandle, 'local-process-secret');
  const relayProcessHandle = startBody.processHandle;

  const outputPending = facade.workspaceTool(account.account_id, 'process_read_output', {
    workspaceId: relayWorkspaceId,
    processHandle: relayProcessHandle,
  });
  const output = await answerNext(core, a, async (payload) => {
    assert.equal(payload.params.arguments.processHandle, 'local-process-secret');
    assert.equal(payload.params.arguments.workspaceId, 'local-workspace-secret');
    return mcpResult({ processHandle: 'local-process-secret', status: 'running', output: 'ok' });
  }, outputPending);
  assert.deepEqual(textJson(await output), { processHandle: relayProcessHandle, status: 'running', output: 'ok' });

  const terminatePending = facade.workspaceTool(account.account_id, 'process_terminate', {
    workspaceId: relayWorkspaceId,
    processHandle: relayProcessHandle,
  });
  const terminated = await answerNext(core, a, async (payload) => {
    assert.equal(payload.params.name, 'process_terminate');
    assert.equal(payload.params.arguments.processHandle, 'local-process-secret');
    assert.equal(payload.params.arguments.workspaceId, 'local-workspace-secret');
    return mcpResult({ processHandle: 'local-process-secret', status: 'terminated' });
  }, terminatePending);
  assert.deepEqual(textJson(await terminated), { processHandle: relayProcessHandle, status: 'terminated' });

  a = {
    ...a,
    session: core.connectAgent({
      deviceId: a.deviceId,
      credential: a.credential,
      runtimeId: 'runtime-a',
      executorReady: true,
      protocolVersion: '1',
    }),
  };
  const reconnectPending = facade.workspaceTool(account.account_id, 'read', { workspaceId: relayWorkspaceId, path: 'after-reconnect.txt' });
  const reconnectRead = await answerNext(core, a, async () => mcpResult({ content: 'same-runtime-ok' }), reconnectPending);
  assert.equal(textJson(await reconnectRead).content, 'same-runtime-ok');

  a = {
    ...a,
    runtimeId: 'runtime-a-new',
    session: core.connectAgent({
      deviceId: a.deviceId,
      credential: a.credential,
      runtimeId: 'runtime-a-new',
      executorReady: true,
      protocolVersion: '1',
    }),
  };
  await assert.rejects(
    () => facade.workspaceTool(account.account_id, 'read', { workspaceId: relayWorkspaceId, path: 'stale.txt' }),
    (error) => error?.code === 'STALE_WORKSPACE_HANDLE',
  );
  await assert.rejects(
    () => facade.workspaceTool(account.account_id, 'process_read_output', { workspaceId: relayWorkspaceId, processHandle: relayProcessHandle }),
    (error) => error?.code === 'STALE_WORKSPACE_HANDLE',
  );

  a = {
    ...a,
    runtimeId: 'runtime-a',
    session: core.connectAgent({
      deviceId: a.deviceId,
      credential: a.credential,
      runtimeId: 'runtime-a',
      executorReady: true,
      protocolVersion: '1',
    }),
  };
  await assert.rejects(
    () => facade.workspaceTool(account.account_id, 'read', { workspaceId: relayWorkspaceId, path: 'must-not-revive.txt' }),
    (error) => error?.code === 'STALE_WORKSPACE_HANDLE',
  );

  a = {
    ...a,
    runtimeId: 'runtime-a-new',
    session: core.connectAgent({
      deviceId: a.deviceId,
      credential: a.credential,
      runtimeId: 'runtime-a-new',
      executorReady: true,
      protocolVersion: '1',
    }),
  };
  const openAgainPending = facade.workspaceOpen(account.account_id, { path: '/workspace/a2', deviceId: a.deviceId });
  const openedAgain = await answerNext(core, a, async () => mcpResult({ workspaceId: 'local-ws-a2' }), openAgainPending);
  const relayWorkspace2 = textJson(await openedAgain).workspaceId;

  a = {
    ...a,
    session: core.connectAgent({
      deviceId: a.deviceId,
      credential: a.credential,
      runtimeId: 'runtime-a-new',
      executorReady: false,
      protocolVersion: '1',
    }),
  };
  await assert.rejects(
    () => facade.workspaceTool(account.account_id, 'read', { workspaceId: relayWorkspace2, path: 'not-ready.txt' }),
    (error) => error?.code === 'DEVICE_NOT_READY',
  );
  await assert.rejects(
    () => facade.workspaceOpen(account.account_id, { path: '/must-not-failover', deviceId: a.deviceId }),
    (error) => error?.code === 'DEVICE_NOT_READY',
  );
  const bPollAfterNotReady = await core.pollAgent({
    deviceId: b.deviceId,
    credential: b.credential,
    runtimeId: b.runtimeId,
    connectionEpoch: b.session.connectionEpoch,
    executorReady: true,
    protocolVersion: '1',
    holdMs: 0,
  });
  assert.equal(bPollAfterNotReady, null, 'not-ready bound device must never fail over');

  a = {
    ...a,
    session: core.connectAgent({
      deviceId: a.deviceId,
      credential: a.credential,
      runtimeId: 'runtime-a-new',
      executorReady: true,
      protocolVersion: '1',
    }),
  };
  advance(60_001);
  await core.pollAgent({
    deviceId: b.deviceId,
    credential: b.credential,
    runtimeId: b.runtimeId,
    connectionEpoch: b.session.connectionEpoch,
    executorReady: true,
    protocolVersion: '1',
    holdMs: 0,
  });
  await assert.rejects(
    () => facade.workspaceOpen(account.account_id, { path: '/offline-must-not-failover', deviceId: a.deviceId }),
    (error) => error?.code === 'DEVICE_OFFLINE',
  );

  await assert.rejects(
    () => facade.workspaceTool(account.account_id, 'read', { workspaceId: 'ws_forged', path: 'x' }),
    (error) => error?.code === 'WORKSPACE_HANDLE_NOT_FOUND',
  );

  const accountB = await core.accountForBearer('acct-b');
  await assert.rejects(
    () => facade.workspaceTool(accountB.account_id, 'read', { workspaceId: relayWorkspace2, path: 'foreign.txt' }),
    (error) => error?.code === 'WORKSPACE_HANDLE_NOT_FOUND',
  );

  a = {
    ...a,
    session: core.connectAgent({
      deviceId: a.deviceId,
      credential: a.credential,
      runtimeId: 'runtime-a-new',
      executorReady: true,
      protocolVersion: '1',
    }),
  };
  const deniedPending = facade.workspaceTool(account.account_id, 'read', { workspaceId: relayWorkspace2, path: '/denied/by-local-policy' });
  const denied = await answerNext(core, a, async () => mcpResult({
    error: { code: 'WORKSPACE_OUTSIDE_ALLOWED_ROOT', message: 'path denied by device-local #176 policy' },
  }, true), deniedPending);
  const deniedResult = await denied;
  assert.equal(deniedResult.isError, true);
  assert.match(JSON.stringify(deniedResult), /device-local #176 policy/u);

  await core.revokeDevice({ bearerToken: 'acct-a', deviceId: a.deviceId });
  await assert.rejects(
    () => facade.workspaceTool(account.account_id, 'read', { workspaceId: relayWorkspace2, path: 'revoked.txt' }),
    (error) => error?.code === 'STALE_WORKSPACE_HANDLE',
  );
  await assert.rejects(
    () => facade.workspaceOpen(account.account_id, { path: '/revoked', deviceId: a.deviceId }),
    (error) => error?.code === 'DEVICE_NOT_FOUND',
  );

  const logText = JSON.stringify(logs);
  for (const secret of ['acct-a', a.credential, 'local-workspace-secret', 'local-process-secret', 'relay-secret-command', '/denied/by-local-policy']) {
    assert.equal(logText.includes(secret), false, 'relay logs must not leak ' + secret);
  }
});

test('public relay MCP is bearer-account scoped, stateless, strict, and exposes only route-safe local tools', async (t) => {
  const { core } = harness(t);
  const device = await pair(core, 'acct-a', 'HTTP Device', 'runtime-http');
  const srv = await startRelayMcpServer({ core, host: '127.0.0.1', port: 0 });
  t.after(() => srv.close());

  const health = await fetch(srv.url.replace('/mcp', '/healthz'));
  assert.equal(health.status, 200);

  const unauth = await fetch(srv.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauth.status, 401);

  const client = new Client({ name: 'issue-183-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(srv.url), {
    requestInit: { headers: { Authorization: 'Bearer acct-a' } },
  }));
  t.after(() => client.close());

  const listedTools = await client.listTools();
  const names = listedTools.tools.map((tool) => tool.name);
  for (const required of ['list_devices', 'workspace_open', 'read', 'search', 'git_status', 'read_excel', 'pdf_mutate_pages', 'process_start', 'process_read_output', 'process_terminate', 'codex_start', 'codex_get', 'codex_continue', 'codex_interrupt', 'codex_reconcile', 'codex_respond_approval', 'codex_recover']) {
    assert.ok(names.includes(required), 'missing public relay tool ' + required);
  }
  for (const forbidden of ['governance_plan', 'governance_task', 'governance_transition', 'governance_takeover', 'worktree_create']) {
    assert.equal(names.includes(forbidden), false, 'relay must not expose ' + forbidden);
  }

  const workspaceSchema = listedTools.tools.find((tool) => tool.name === 'workspace_open')?.inputSchema;
  assert.ok(workspaceSchema?.properties?.deviceId);
  assert.equal(workspaceSchema?.additionalProperties, false);
  const readSchema = listedTools.tools.find((tool) => tool.name === 'read')?.inputSchema;
  assert.equal('deviceId' in (readSchema?.properties || {}), false);
  assert.equal('authorityToken' in (readSchema?.properties || {}), false);
  assert.equal(readSchema?.additionalProperties, false);

  const devicesResult = await client.callTool({ name: 'list_devices', arguments: {} });
  const devices = textJson(devicesResult).devices;
  assert.equal(devices.length, 1);
  assert.equal(devices[0].deviceId, device.deviceId);
  assert.equal('runtimeId' in devices[0], false);
  assert.equal('connectionEpoch' in devices[0], false);
  assert.equal('revoked' in devices[0], false);

  const openPromise = client.callTool({ name: 'workspace_open', arguments: { path: '/http-workspace' } });
  const openResultPromise = answerNext(core, device, async (payload) => {
    assert.equal(payload.params.name, 'workspace_open');
    assert.equal('deviceId' in payload.params.arguments, false);
    return mcpResult({ workspaceId: 'http-local-workspace', root: '/http-workspace' });
  }, openPromise);
  const opened = await openResultPromise;
  const relayWorkspaceId = textJson(opened).workspaceId;
  assert.match(relayWorkspaceId, /^ws_/u);

  const strictFailure = await client.callTool({
    name: 'read',
    arguments: { workspaceId: relayWorkspaceId, path: 'a.txt', deviceId: device.deviceId },
  });
  assert.equal(strictFailure.isError, true);
});


test('Codex relay exact-job affinity masks local IDs, binds approvals, and refuses ambiguous operation replay', async (t) => {
  const { store, core, facade } = harness(t);
  const a = await pair(core, 'acct-a', 'same display name', 'runtime-a');
  const b = await pair(core, 'acct-a', 'same display name', 'runtime-b');
  const acct = await core.accountForBearer('acct-a');
  const other = await core.accountForBearer('acct-b');

  const openedPending = facade.workspaceOpen(acct.account_id, { deviceId: a.deviceId, path: '/codex-a' });
  const opened = await answerNext(core, a, async (payload) => {
    assert.equal(payload.params.name, 'workspace_open');
    return mcpResult({ workspaceId: 'secret-local-workspace-a', root: '/codex-a' });
  }, openedPending);
  const workspaceId = textJson(opened).workspaceId;

  const otherPending = facade.workspaceOpen(acct.account_id, { deviceId: b.deviceId, path: '/codex-b' });
  const otherOpened = await answerNext(core, b, async () => mcpResult({ workspaceId: 'secret-local-workspace-b' }), otherPending);
  const otherWs = textJson(otherOpened).workspaceId;

  const startArgs = { workspaceId, prompt: 'bounded code fix', accessMode: 'workspace_write', operationKey: 'start-unique-001', identity: 'logical-task-001' };
  const startPending = facade.codexStart(acct.account_id, startArgs);
  await answerNext(core, a, async (payload) => {
    assert.equal(payload.params.name, 'codex_recovery_preflight');
    assert.equal(payload.params.arguments.workspaceId, 'secret-local-workspace-a');
    assert.equal(payload.params.arguments.identity, 'logical-task-001');
    return mcpResult({ ok: true, status: 'safe_to_start', dangerousCandidateCount: 0, terminalIdentityChecked: true });
  }, Promise.resolve());
  const started = await answerNext(core, a, async (payload) => {
    assert.equal(payload.params.name, 'codex_start');
    assert.equal(payload.params.arguments.accessMode, 'workspace_write');
    assert.equal(payload.params.arguments.identity, 'logical-task-001');
    assert.equal('authorityToken' in payload.params.arguments, false);
    return mcpResult({ jobId: 'secret-local-job-a', threadId: 'secret-thread', turnId: 'secret-turn', state: 'running' });
  }, startPending);
  const startResult = textJson(started);
  assert.match(startResult.jobId, /^job_[A-Za-z0-9_-]{32}$/u);
  assert.equal(startResult.state, 'running');
  for (const secret of ['secret-local-job-a', 'secret-thread', 'secret-turn', 'secret-local-workspace-a']) {
    assert.equal(JSON.stringify(startResult).includes(secret), false);
  }

  const cached = await facade.codexStart(acct.account_id, startArgs);
  assert.equal(textJson(cached).jobId, startResult.jobId, 'same request cannot create another turn');
  await assert.rejects(facade.codexStart(acct.account_id, { ...startArgs, prompt: 'different task' }),
    (error) => error?.code === 'CODEX_OPERATION_KEY_CONFLICT');
  await assert.rejects(facade.codexJobTool(other.account_id, 'codex_get', { workspaceId, jobId: startResult.jobId }),
    (error) => error?.code === 'WORKSPACE_HANDLE_NOT_FOUND');
  await assert.rejects(facade.codexJobTool(acct.account_id, 'codex_get', { workspaceId: otherWs, jobId: startResult.jobId }),
    (error) => error?.code === 'CODEX_JOB_SCOPE_MISMATCH');

  const getPending = facade.codexJobTool(acct.account_id, 'codex_get', { workspaceId, jobId: startResult.jobId });
  const got = await answerNext(core, a, async (payload) => {
    assert.equal(payload.params.name, 'codex_get');
    assert.equal(payload.params.arguments.jobId, 'secret-local-job-a');
    return mcpResult({
      jobId: 'secret-local-job-a', threadId: 'secret-thread', turnId: 'secret-turn',
      state: 'running', pendingApprovals: [
        { approvalId: 'secret-local-approval-a', method: 'item/commandExecution/requestApproval', kind: 'command', threadId: 'secret-thread' },
      ],
    });
  }, getPending);
  const getBody = textJson(got);
  assert.match(getBody.pendingApprovals[0].approvalId, /^approval_[A-Za-z0-9_-]{32}$/u);
  assert.equal(JSON.stringify(getBody).includes('secret-local-approval-a'), false);
  assert.equal(JSON.stringify(getBody).includes('secret-thread'), false);

  const approval = getBody.pendingApprovals[0].approvalId;
  const approvalPending = facade.codexJobTool(acct.account_id, 'codex_respond_approval', {
    workspaceId, jobId: startResult.jobId, approvalId: approval, decision: 'approve',
  });
  await answerNext(core, a, async (payload) => {
    assert.equal(payload.params.name, 'codex_respond_approval');
    assert.equal(payload.params.arguments.approvalId, 'secret-local-approval-a');
    assert.equal(payload.params.arguments.jobId, 'secret-local-job-a');
    return mcpResult({ jobId: 'secret-local-job-a', state: 'running' });
  }, approvalPending);
  await assert.rejects(facade.codexJobTool(acct.account_id, 'codex_respond_approval', {
    workspaceId, jobId: startResult.jobId, approvalId: approval, decision: 'approve',
  }), (error) => error?.code === 'CODEX_APPROVAL_NOT_FOUND');

  const contArgs = { workspaceId, jobId: startResult.jobId, instruction: 'finish tests', operationKey: 'continue-unique-001', stepId: 'continue-step-001' };
  const contPending = facade.codexJobTool(acct.account_id, 'codex_continue', contArgs);
  const continued = await answerNext(core, a, async (payload) => {
    assert.equal(payload.params.name, 'codex_continue');
    assert.equal(payload.params.arguments.jobId, 'secret-local-job-a');
    return mcpResult({ jobId: 'secret-local-job-a', turnId: 'secret-new-turn', state: 'running' });
  }, contPending);
  assert.equal(textJson(continued).state, 'running');
  assert.equal(textJson(await facade.codexJobTool(acct.account_id, 'codex_continue', contArgs)).state, 'submitted');
  await assert.rejects(facade.codexJobTool(acct.account_id, 'codex_continue', { ...contArgs, instruction: 'change to new goal' }),
    (error) => error?.code === 'CODEX_OPERATION_KEY_CONFLICT');

  core.connectAgent({ deviceId: a.deviceId, credential: a.credential, runtimeId: 'runtime-a-new', executorReady: true, protocolVersion: '1' });
  await assert.rejects(facade.codexJobTool(acct.account_id, 'codex_get', { workspaceId, jobId: startResult.jobId }),
    (error) => error?.code === 'STALE_WORKSPACE_HANDLE');

  // Identical display names are not device identities.
  assert.equal(a.deviceId === b.deviceId, false);
  assert.equal(store.codexJobAffinity(acct.account_id, startResult.jobId).invalidated_at != null, true);
});

test('Codex dispatch unknown result remains non-replayable and forces durable semantic recovery', async (t) => {
  const { core, facade } = harness(t);
  const a = await pair(core, 'acct-a', 'Device A', 'runtime-1');
  const account = await core.accountForBearer('acct-a');
  const pending = facade.workspaceOpen(account.account_id, { deviceId: a.deviceId, path: '/one' });
  const opened = await answerNext(core, a, async () => mcpResult({ workspaceId: 'local-one' }), pending);
  const workspaceId = textJson(opened).workspaceId;
  const args = { workspaceId, prompt: 'a task', accessMode: 'workspace_write', operationKey: 'lost-response-001', identity: 'logical-lost-001' };
  const first = facade.codexStart(account.account_id, args);
  await answerNext(core, a, async () => mcpResult({ ok: true, status: 'safe_to_start', terminalIdentityChecked: true }), Promise.resolve());
  await answerNext(core, a, async (payload) => {
    assert.equal(payload.params.name, 'codex_start');
    return mcpResult({ error: { code: 'LOCAL_UNAVAILABLE' } }, true);
  }, Promise.resolve());
  await assert.rejects(first, (error) => error?.code === 'CODEX_LOCAL_REJECTED');
  await assert.rejects(facade.codexStart(account.account_id, args), (error) => error?.code === 'CODEX_RECOVERY_REQUIRED');
});


test('Codex recovery is single-device and does not mint a second live handle for the same job', async (t) => {
  const { core, store, facade } = harness(t);
  const device = await pair(core, 'acct-a', 'Device A', 'runtime-a');
  const account = await core.accountForBearer('acct-a');
  const pending = facade.workspaceOpen(account.account_id, { deviceId: device.deviceId, path: '/codex' });
  const opened = await answerNext(core, device, async () => mcpResult({ workspaceId: 'local-ws-codex' }), pending);
  const workspaceId = textJson(opened).workspaceId;
  const existing = store.createCodexJobAffinity({
    accountId: account.account_id, deviceId: device.deviceId, runtimeId: 'runtime-a',
    relayWorkspaceId: workspaceId, localJobId: 'local-known-job', now: core.now(),
  });
  const recoverPending = facade.codexRecover(account.account_id, { workspaceId, identity: 'my-task' });
  const recovered = await answerNext(core, device, async (payload) => {
    assert.equal(payload.params.name, 'codex_recover');
    assert.equal(payload.params.arguments.workspaceId, 'local-ws-codex');
    assert.equal(payload.params.arguments.identity, 'my-task');
    return mcpResult({ jobId: 'local-known-job', threadId: 'secret-thread', state: 'completed', result: 'tests passed' });
  }, recoverPending);
  assert.equal(textJson(recovered).jobId, existing.relay_job_id);
  assert.equal(JSON.stringify(textJson(recovered)).includes('secret-thread'), false);

  await core.revokeDevice({ bearerToken: 'acct-a', deviceId: device.deviceId });
  await assert.rejects(facade.codexRecover(account.account_id, { workspaceId, identity: 'my-task' }),
    (err) => err?.code === 'STALE_WORKSPACE_HANDLE');
  await assert.rejects(facade.codexJobTool(account.account_id, 'codex_get', { workspaceId, jobId: existing.relay_job_id }),
    (err) => err?.code === 'STALE_WORKSPACE_HANDLE');
});

test('Codex preflight recover-existing never starts a second turn and errors leave the intent fenced', async (t) => {
  const { core, facade } = harness(t);
  const device = await pair(core, 'acct-a', 'Device A', 'runtime-a');
  const account = await core.accountForBearer('acct-a');
  const pending = facade.workspaceOpen(account.account_id, { deviceId: device.deviceId, path: '/codex' });
  const opened = await answerNext(core, device, async () => mcpResult({ workspaceId: 'local-ws-a' }), pending);
  const workspaceId = textJson(opened).workspaceId;
  const args = { workspaceId, prompt: 'same task', accessMode: 'workspace_write', operationKey: 'existing-job-001', identity: 'logical-existing-001' };
  const attempted = facade.codexStart(account.account_id, args);
  await answerNext(core, device, async (payload) => {
    assert.equal(payload.params.name, 'codex_recovery_preflight');
    return mcpResult({ ok: true, status: 'recover_existing', nextAction: 'codex_recover' });
  }, Promise.resolve());
  await assert.rejects(attempted, (error) => error?.code === 'CODEX_RECOVERY_REQUIRED');
  await assert.rejects(facade.codexStart(account.account_id, args), (error) => error?.code === 'CODEX_RECOVERY_REQUIRED');
  const envelope = await core.pollAgent({
    deviceId: device.deviceId, credential: device.credential,
    runtimeId: device.runtimeId, connectionEpoch: device.session.connectionEpoch,
    executorReady: true, protocolVersion: '1', holdMs: 0,
  });
  assert.equal(envelope, null, 'preflight says recover, not new turn/start');
});

test('Codex continue lost response and approval cross-job spoof fail closed without second dispatch', async (t) => {
  const { core, store, facade } = harness(t);
  const device = await pair(core, 'acct-a', 'Device A', 'runtime-a');
  const account = await core.accountForBearer('acct-a');
  const pending = facade.workspaceOpen(account.account_id, { deviceId: device.deviceId, path: '/codex' });
  const opened = await answerNext(core, device, async () => mcpResult({ workspaceId: 'local-ws-a' }), pending);
  const workspaceId = textJson(opened).workspaceId;
  const mkJob = (localJobId) => store.createCodexJobAffinity({
    accountId: account.account_id, deviceId: device.deviceId, runtimeId: 'runtime-a',
    relayWorkspaceId: workspaceId, localJobId, now: core.now(),
  });
  const first = mkJob('local-job-1');
  const second = mkJob('local-job-2');
  const alias = store.createCodexApprovalAffinity(first.relay_job_id, 'local-approval-1', core.now()).relay_approval_id;
  await assert.rejects(facade.codexJobTool(account.account_id, 'codex_respond_approval', {
    workspaceId, jobId: second.relay_job_id, approvalId: alias, decision: 'approve',
  }), (error) => error?.code === 'CODEX_APPROVAL_NOT_FOUND');
  const args = { workspaceId, jobId: first.relay_job_id, operationKey: 'continue-lost-001', stepId: 'continue-lost-step', instruction: 'one next turn only' };
  const attempted = facade.codexJobTool(account.account_id, 'codex_continue', args);
  await answerNext(core, device, async (payload) => {
    assert.equal(payload.params.name, 'codex_continue');
    assert.equal(payload.params.arguments.jobId, 'local-job-1');
    return mcpResult({ error: { code: 'DEVICE_RESPONSE_LOST' } }, true);
  }, Promise.resolve());
  await assert.rejects(attempted, (error) => error?.code === 'CODEX_LOCAL_REJECTED');
  await assert.rejects(facade.codexJobTool(account.account_id, 'codex_continue', args),
    (error) => error?.code === 'CODEX_RECOVERY_REQUIRED');
});
