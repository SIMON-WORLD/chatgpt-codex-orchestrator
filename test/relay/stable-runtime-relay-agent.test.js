import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayCore, RelayError, RelayStore } from '../../src/relay/core.js';
import { LocalMcpToolExecutor, StableRuntimeRelayAgentMode } from '../../src/relay/runtime-mode.js';
import { BrainLocalRuntime } from '../../src/transport/brain-local.js';
import { loadV02Config } from '../../src/config.js';

async function verifyBearer(token) {
  if (token !== 'acct-a') throw new RelayError('INVALID_BEARER', 'invalid bearer', 401);
  return { issuer: 'https://issuer.example/', subject: 'user-a' };
}

async function pair(core) {
  const started = core.beginPairing({ displayName: 'Stable Runtime device' });
  await core.approvePairing({ bearerToken: 'acct-a', userCode: started.userCode });
  return core.completePairing({ deviceCode: started.deviceCode });
}

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('condition not reached before timeout');
}

function readinessFetch(ref) {
  return async () => ({
    ok: ref.value,
    async json() {
      return {
        status: ref.value ? 'ready' : 'not_ready',
        activationPreflight: false,
        processLive: true,
        localMcpListening: true,
        executorRequired: true,
        executorReady: ref.value,
      };
    },
  });
}

test('relay-agent config is default-off, secret-reference-only, and has no filesystem-scope authority', () => {
  const defaults = loadV02Config();
  assert.equal(defaults.relayAgent.enabled, false);
  assert.equal(defaults.relayAgent.relayUrl, null);
  assert.equal(defaults.relayAgent.deviceId, null);
  assert.equal(defaults.relayAgent.credentialEnv, null);
  assert.equal('credential' in defaults.relayAgent, false);
  assert.equal('filesystemScope' in defaults.relayAgent, false);
  assert.equal('workspaceRoots' in defaults.relayAgent, false);

  assert.throws(
    () => loadV02Config({ relayAgent: { credential: 'must-never-be-configured' } }),
    /raw relayAgent\.credential is forbidden/u,
  );

  const enabled = loadV02Config({
    relayAgent: {
      enabled: true,
      relayUrl: 'https://relay.example/',
      deviceId: 'device-123',
      credentialEnv: 'LOCAL_RELAY_DEVICE_SECRET',
      pollHoldMs: 1000,
      reconnectInitialMs: 25,
      reconnectMaxMs: 250,
    },
  });
  assert.deepEqual(enabled.relayAgent, {
    enabled: true,
    relayUrl: 'https://relay.example',
    deviceId: 'device-123',
    credentialEnv: 'LOCAL_RELAY_DEVICE_SECRET',
    pollHoldMs: 1000,
    reconnectInitialMs: 25,
    reconnectMaxMs: 250,
  });
});

test('internal relay execution seam accepts only private tools/call and delegates to local MCP client', async () => {
  const calls = [];
  let closed = 0;
  const executor = new LocalMcpToolExecutor({
    mcpUrl: 'http://127.0.0.1:8745/mcp',
    clientFactory: async (mcpUrl) => {
      assert.equal(mcpUrl, 'http://127.0.0.1:8745/mcp');
      return {
        async callTool(request) {
          calls.push(request);
          return { content: [{ type: 'text', text: 'local-result' }] };
        },
        async close() { closed += 1; },
      };
    },
  });

  const result = await executor.execute({
    method: 'tools/call',
    params: { name: 'read', arguments: { workspaceId: 'ws-1', path: 'a.txt' } },
  });
  assert.equal(result.content[0].text, 'local-result');
  assert.deepEqual(calls, [{ name: 'read', arguments: { workspaceId: 'ws-1', path: 'a.txt' } }]);
  await assert.rejects(
    () => executor.execute({ method: 'workspace/open', params: {} }),
    (error) => error?.code === 'INVALID_LOCAL_RELAY_REQUEST',
  );
  await executor.close();
  assert.equal(closed, 1);
});

test('Stable Runtime relay-agent mode wires readiness, poll/respond, bounded reconnect, epoch fencing and revoke refusal', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-181-runtime-agent-'));
  const store = new RelayStore(path.join(dir, 'relay.sqlite'));
  const core = new RelayCore({ store, verifyBearer, presenceWindowMs: 5000 });
  t.after(() => {
    core.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const paired = await pair(core);
  const ready = { value: false };
  let executions = 0;
  let connectCount = 0;
  let failNextPoll = false;

  const transportFactory = () => ({
    connect(args) {
      connectCount += 1;
      return core.connectAgent({
        ...args,
        deviceId: paired.deviceId,
        credential: paired.credential,
      });
    },
    async poll(args) {
      if (failNextPoll) {
        failNextPoll = false;
        const error = new Error('simulated network loss');
        error.code = 'NETWORK_LOST';
        throw error;
      }
      return core.pollAgent({
        ...args,
        deviceId: paired.deviceId,
        credential: paired.credential,
      });
    },
    respond(args) {
      return core.respondAgent({
        ...args,
        deviceId: paired.deviceId,
        credential: paired.credential,
      });
    },
  });

  const mode = new StableRuntimeRelayAgentMode({
    config: {
      enabled: true,
      relayUrl: 'https://relay.example',
      deviceId: paired.deviceId,
      credentialEnv: 'TEST_RELAY_SECRET',
      pollHoldMs: 20,
      reconnectInitialMs: 10,
      reconnectMaxMs: 40,
    },
    readyzUrl: 'http://127.0.0.1:8745/readyz',
    execute: async (payload) => {
      executions += 1;
      return { echoed: payload.value };
    },
    env: { TEST_RELAY_SECRET: paired.credential },
    fetchFn: readinessFetch(ready),
    transportFactory,
  });
  const firstRuntimeId = mode.runtimeId;
  mode.start();

  const onlineNotReady = await waitFor(async () => {
    const state = await core.getDevice({ bearerToken: 'acct-a', deviceId: paired.deviceId });
    return state.online && !state.ready ? state : null;
  });
  assert.equal(onlineNotReady.executorReady, false);
  assert.equal(onlineNotReady.runtimeId, firstRuntimeId);

  ready.value = true;
  const readyState = await waitFor(async () => {
    const state = await core.getDevice({ bearerToken: 'acct-a', deviceId: paired.deviceId });
    return state.ready ? state : null;
  });
  assert.equal(readyState.executorReady, true);

  const dispatched = core.dispatch({
    bearerToken: 'acct-a',
    deviceId: paired.deviceId,
    payload: { value: 'sentinel' },
    deadlineMs: 2000,
  });
  assert.deepEqual(await dispatched, { ok: true, value: { echoed: 'sentinel' } });
  assert.equal(executions, 1);

  const epochBeforeReconnect = (await core.getDevice({ bearerToken: 'acct-a', deviceId: paired.deviceId })).connectionEpoch;
  failNextPoll = true;
  const reconnected = await waitFor(async () => {
    const state = await core.getDevice({ bearerToken: 'acct-a', deviceId: paired.deviceId });
    return state.connectionEpoch > epochBeforeReconnect ? state : null;
  });
  assert.ok(reconnected.connectionEpoch > epochBeforeReconnect);
  assert.ok(connectCount >= 2);
  assert.equal(mode.runtimeId, firstRuntimeId);

  await core.revokeDevice({ bearerToken: 'acct-a', deviceId: paired.deviceId });
  await waitFor(() => mode.status().state === 'revoked');
  const connectsAtRevoke = connectCount;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(connectCount, connectsAtRevoke);
  assert.equal(mode.status().lastErrorCode, 'DEVICE_REVOKED');

  await mode.stop();
  assert.equal(mode.status().state, 'stopped');

  const replacementMode = new StableRuntimeRelayAgentMode({
    config: {
      enabled: true,
      relayUrl: 'https://relay.example',
      deviceId: paired.deviceId,
      credentialEnv: 'TEST_RELAY_SECRET',
    },
    readyzUrl: 'http://127.0.0.1:8745/readyz',
    execute: async () => null,
    env: { TEST_RELAY_SECRET: paired.credential },
    fetchFn: readinessFetch(ready),
    transportFactory,
  });
  assert.notEqual(replacementMode.runtimeId, firstRuntimeId);
});

test('relay-agent graceful shutdown aborts an outstanding outbound poll', async () => {
  let pollStarted = false;
  let pollAborted = false;
  const transportFactory = () => ({
    async connect(args) {
      return { deviceId: 'device-1', runtimeId: args.runtimeId, connectionEpoch: 1 };
    },
    poll(_args, { signal } = {}) {
      pollStarted = true;
      return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => {
          pollAborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    },
    async respond() {
      throw new Error('unexpected respond');
    },
  });

  const mode = new StableRuntimeRelayAgentMode({
    config: {
      enabled: true,
      relayUrl: 'https://relay.example',
      deviceId: 'device-1',
      credentialEnv: 'TEST_RELAY_SECRET',
      pollHoldMs: 25000,
      reconnectInitialMs: 10,
      reconnectMaxMs: 20,
    },
    readyzUrl: 'http://127.0.0.1:8745/readyz',
    execute: async () => null,
    env: { TEST_RELAY_SECRET: 'credential-id.secret' },
    fetchFn: readinessFetch({ value: true }),
    transportFactory,
  });
  mode.start();
  await waitFor(() => pollStarted);
  await mode.stop();
  assert.equal(pollAborted, true);
  assert.equal(mode.status().state, 'stopped');
});

test('BrainLocalRuntime starts relay mode only when explicitly enabled and stops it before local shutdown', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-181-runtime-root-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-181-runtime-data-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  const defaultConfig = loadV02Config({ dataRoot, workspaceRoot: root, port: 0 });
  let defaultFactoryCalls = 0;
  const defaultRuntime = new BrainLocalRuntime({
    config: defaultConfig,
    relayAgentModeFactory: () => {
      defaultFactoryCalls += 1;
      throw new Error('default-off relay factory must not be invoked');
    },
  });
  await defaultRuntime.start();
  assert.equal(defaultFactoryCalls, 0);
  assert.equal(defaultRuntime.relayAgentMode, null);
  await defaultRuntime.close();

  const enabledConfig = loadV02Config({
    dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'issue-181-runtime-data-enabled-')),
    workspaceRoot: root,
    port: 0,
    relayAgent: {
      enabled: true,
      relayUrl: 'https://relay.example',
      deviceId: 'device-configured-locally',
      credentialEnv: 'LOCAL_RELAY_DEVICE_SECRET',
      pollHoldMs: 100,
      reconnectInitialMs: 10,
      reconnectMaxMs: 20,
    },
  });
  t.after(() => fs.rmSync(enabledConfig.dataRoot, { recursive: true, force: true }));

  let started = 0;
  let stopped = 0;
  let captured = null;
  const enabledRuntime = new BrainLocalRuntime({
    config: enabledConfig,
    relayEnv: { LOCAL_RELAY_DEVICE_SECRET: 'credential-id.secret' },
    relayExecute: async () => ({ ok: true }),
    relayAgentModeFactory: (options) => {
      captured = options;
      return {
        start() { started += 1; },
        async stop() { stopped += 1; },
        status() { return { enabled: true, state: 'connected', runtimeId: 'runtime-test', connectionEpoch: 1, lastErrorCode: null }; },
      };
    },
  });
  await enabledRuntime.start();
  assert.equal(started, 1);
  assert.equal(captured.config.deviceId, 'device-configured-locally');
  assert.equal(captured.config.credentialEnv, 'LOCAL_RELAY_DEVICE_SECRET');
  assert.match(captured.readyzUrl, /^http:\/\/127\.0\.0\.1:\d+\/readyz$/u);
  assert.equal('credential' in captured.config, false);
  await enabledRuntime.close();
  assert.equal(stopped, 1);
});
