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
  const core = new RelayCore({ store, verifyBearer, presenceWindowMs: 60_000, logger: (entry) => logs.push(entry) });
  const facade = new RelayMcpFacade({ core });
  t.after(() => {
    core.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, core, facade, logs };
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
  const a1 = await pair(core, 'acct-a', 'Same Name', 'runtime-a1');
  const accountA = await core.accountForBearer('acct-a');

  assert.deepEqual(facade.listDevices(accountA.account_id), [{
    deviceId: a1.deviceId,
    displayName: 'Same Name',
    online: true,
    executorReady: true,
    ready: true,
    lastSeenAt: assert.anything(),
  }]);
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
  const { core, facade, logs } = harness(t);
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
  for (const required of ['list_devices', 'workspace_open', 'read', 'search', 'git_status', 'read_excel', 'pdf_mutate_pages', 'process_start', 'process_read_output', 'process_terminate']) {
    assert.ok(names.includes(required), 'missing public relay tool ' + required);
  }
  for (const forbidden of ['governance_plan', 'governance_task', 'governance_transition', 'governance_takeover', 'codex_start', 'worktree_create']) {
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
