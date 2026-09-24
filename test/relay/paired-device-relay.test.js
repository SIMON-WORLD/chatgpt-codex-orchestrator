import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayCore, RelayError, RelayStore } from '../../src/relay/core.js';
import { DeviceRelayAgent, HttpAgentTransport } from '../../src/relay/agent.js';
import { startRelayHttpServer } from '../../src/relay/http-server.js';

const identities = {
  'acct-a': { issuer: 'https://issuer.example/', subject: 'user-a' },
  'acct-b': { issuer: 'https://issuer.example/', subject: 'user-b' },
};

async function verifyBearer(token) {
  const identity = identities[token];
  if (!identity) throw new RelayError('INVALID_BEARER', 'invalid bearer', 401);
  return identity;
}

function harness(t, { logger = () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-181-relay-'));
  const dbPath = path.join(dir, 'relay.sqlite');
  const clock = { now: 1_800_000_000_000 };
  const store = new RelayStore(dbPath);
  const core = new RelayCore({ store, verifyBearer, now: () => clock.now, logger });
  t.after(() => {
    core.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, clock, store, core };
}

async function pair(core, bearerToken, displayName = 'Device') {
  const started = core.beginPairing({ displayName });
  await core.approvePairing({ bearerToken, userCode: started.userCode });
  const paired = core.completePairing({ deviceCode: started.deviceCode });
  return { ...started, ...paired };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

function directTransport(core, paired, options = {}) {
  return {
    dropResponses: options.dropResponses || 0,
    lastEnvelope: null,
    connect(args) {
      return core.connectAgent({ ...args, deviceId: paired.deviceId, credential: paired.credential });
    },
    async poll(args) {
      const envelope = await core.pollAgent({ ...args, deviceId: paired.deviceId, credential: paired.credential });
      this.lastEnvelope = envelope;
      return envelope;
    },
    respond(args) {
      if (this.dropResponses > 0) {
        this.dropResponses -= 1;
        throw new Error('simulated response drop');
      }
      return core.respondAgent({ ...args, deviceId: paired.deviceId, credential: paired.credential });
    },
  };
}

function readinessFetch(readyRef) {
  return async () => ({
    ok: true,
    async json() {
      return {
        status: readyRef.value ? 'ready' : 'not_ready',
        activationPreflight: false,
        processLive: true,
        localMcpListening: true,
        executorRequired: true,
        executorReady: readyRef.value,
      };
    },
  });
}

test('SQLite WAL pairing and account isolation preserve stable device identity and per-device credentials', async (t) => {
  const { store, core } = harness(t);
  assert.equal(store.journalMode, 'wal');

  const a1 = await pair(core, 'acct-a', 'Same name');
  const a2 = await pair(core, 'acct-a', 'Same name');
  const b1 = await pair(core, 'acct-b', 'Other device');

  assert.notEqual(a1.deviceId, a2.deviceId);
  assert.notEqual(a1.credential, a2.credential);
  assert.notEqual(a1.deviceId, b1.deviceId);

  const listA = await core.listDevices({ bearerToken: 'acct-a' });
  const listB = await core.listDevices({ bearerToken: 'acct-b' });
  assert.equal(listA.length, 2);
  assert.equal(listB.length, 1);
  assert.deepEqual(listA.map((device) => device.displayName), ['Same name', 'Same name']);
  assert.deepEqual(new Set(listA.map((device) => device.deviceId)).size, 2);

  await rejectsCode(core.getDevice({ bearerToken: 'acct-b', deviceId: a1.deviceId }), 'DEVICE_NOT_FOUND');
  await rejectsCode(core.renameDevice({ bearerToken: 'acct-b', deviceId: a1.deviceId, displayName: 'stolen' }), 'DEVICE_NOT_FOUND');
  await rejectsCode(core.revokeDevice({ bearerToken: 'acct-b', deviceId: a1.deviceId }), 'DEVICE_NOT_FOUND');

  assert.throws(
    () => core.connectAgent({ deviceId: a2.deviceId, credential: a1.credential, runtimeId: 'r-wrong', executorReady: true }),
    (error) => error?.code === 'INVALID_DEVICE_CREDENTIAL'
  );

  const rawSecret = a1.credential.split('.')[1];
  const credentialRow = store.db.prepare('SELECT * FROM device_credentials WHERE device_id = ?').get(a1.deviceId);
  assert.notEqual(credentialRow.secret_sha256, rawSecret);
  assert.equal(JSON.stringify(credentialRow).includes(rawSecret), false);
  const pairingRow = store.db.prepare('SELECT * FROM pairing_approvals WHERE pairing_id = ?').get(a1.pairingId);
  assert.equal(JSON.stringify(pairingRow).includes(a1.deviceCode), false);
  assert.equal(JSON.stringify(pairingRow).includes(a1.userCode), false);

  assert.throws(() => core.completePairing({ deviceCode: a1.deviceCode }), (error) => error?.code === 'PAIRING_ALREADY_CONSUMED');

  await core.revokeDevice({ bearerToken: 'acct-a', deviceId: a1.deviceId });
  const afterSingle = await core.listDevices({ bearerToken: 'acct-a' });
  assert.equal(afterSingle.find((device) => device.deviceId === a1.deviceId).revoked, true);
  assert.equal(afterSingle.find((device) => device.deviceId === a2.deviceId).revoked, false);

  const all = await core.revokeAll({ bearerToken: 'acct-a' });
  assert.equal(all.revokedCount, 1);
  assert.equal((await core.listDevices({ bearerToken: 'acct-a' })).every((device) => device.revoked), true);
  assert.equal((await core.listDevices({ bearerToken: 'acct-b' }))[0].revoked, false);
});

test('presence readiness and connectionEpoch fencing distinguish offline, not-ready, ready and revoked', async (t) => {
  const { core, clock } = harness(t);
  const paired = await pair(core, 'acct-a', 'Desktop');

  const first = core.connectAgent({
    deviceId: paired.deviceId,
    credential: paired.credential,
    runtimeId: 'runtime-1',
    executorReady: false,
    protocolVersion: '1',
  });
  assert.equal(first.connectionEpoch, 1);
  let state = await core.getDevice({ bearerToken: 'acct-a', deviceId: paired.deviceId });
  assert.equal(state.online, true);
  assert.equal(state.executorReady, false);
  assert.equal(state.ready, false);

  await core.pollAgent({
    deviceId: paired.deviceId,
    credential: paired.credential,
    runtimeId: 'runtime-1',
    connectionEpoch: first.connectionEpoch,
    executorReady: true,
    protocolVersion: '1',
    holdMs: 0,
  });
  state = await core.getDevice({ bearerToken: 'acct-a', deviceId: paired.deviceId });
  assert.equal(state.ready, true);

  clock.now += 61_000;
  state = await core.getDevice({ bearerToken: 'acct-a', deviceId: paired.deviceId });
  assert.equal(state.online, false);
  assert.equal(state.ready, false);

  const second = core.connectAgent({
    deviceId: paired.deviceId,
    credential: paired.credential,
    runtimeId: 'runtime-1',
    executorReady: true,
    protocolVersion: '1',
  });
  const third = core.connectAgent({
    deviceId: paired.deviceId,
    credential: paired.credential,
    runtimeId: 'runtime-1',
    executorReady: true,
    protocolVersion: '1',
  });
  assert.equal(second.connectionEpoch, 2);
  assert.equal(third.connectionEpoch, 3);
  await rejectsCode(core.pollAgent({
    deviceId: paired.deviceId,
    credential: paired.credential,
    runtimeId: 'runtime-1',
    connectionEpoch: second.connectionEpoch,
    executorReady: true,
    holdMs: 0,
  }), 'STALE_CONNECTION_EPOCH');

  const incompatible = core.connectAgent({
    deviceId: paired.deviceId,
    credential: paired.credential,
    runtimeId: 'runtime-1',
    executorReady: true,
    protocolVersion: '999',
  });
  assert.equal(incompatible.state.online, true);
  assert.equal(incompatible.state.executorReady, true);
  assert.equal(incompatible.state.ready, false);

  await core.revokeDevice({ bearerToken: 'acct-a', deviceId: paired.deviceId });
  assert.throws(
    () => core.connectAgent({ deviceId: paired.deviceId, credential: paired.credential, runtimeId: 'runtime-1', executorReady: true }),
    (error) => error?.code === 'DEVICE_REVOKED'
  );
  await rejectsCode(core.pollAgent({
    deviceId: paired.deviceId,
    credential: paired.credential,
    runtimeId: 'runtime-1',
    connectionEpoch: incompatible.connectionEpoch,
    executorReady: true,
    holdMs: 0,
  }), 'DEVICE_REVOKED');
  await rejectsCode(core.dispatch({ bearerToken: 'acct-a', deviceId: paired.deviceId, payload: { harmless: true } }), 'DEVICE_REVOKED');
});

test('agent consumes #177 readiness and same-runtime requestId redelivery is deduped', async (t) => {
  const logs = [];
  const { core } = harness(t, { logger: (entry) => logs.push(entry) });
  const paired = await pair(core, 'acct-a', 'Laptop');
  const ready = { value: false };
  const transport = directTransport(core, paired, { dropResponses: 1 });
  let executions = 0;
  const agent = new DeviceRelayAgent({
    deviceId: paired.deviceId,
    credential: paired.credential,
    readyzUrl: 'http://127.0.0.1:8745/readyz',
    transport,
    runtimeId: 'stable-runtime-a',
    fetchFn: readinessFetch(ready),
    execute: async (payload) => {
      executions += 1;
      if (payload.sentinel === 'local-error') {
        throw Object.assign(new Error('local sentinel failed'), { code: 'LOCAL_SENTINEL_FAILED' });
      }
      return { echoed: payload.sentinel };
    },
    logger: (entry) => logs.push(entry),
  });

  await agent.connect();
  assert.equal((await core.getDevice({ bearerToken: 'acct-a', deviceId: paired.deviceId })).ready, false);
  await rejectsCode(core.dispatch({
    bearerToken: 'acct-a',
    deviceId: paired.deviceId,
    payload: { sentinel: 'must-not-run' },
  }), 'DEVICE_NOT_READY');

  ready.value = true;
  assert.equal(await agent.pollOnce({ holdMs: 0 }), null);
  assert.equal((await core.getDevice({ bearerToken: 'acct-a', deviceId: paired.deviceId })).ready, true);

  const dispatchPromise = core.dispatch({
    bearerToken: 'acct-a',
    deviceId: paired.deviceId,
    payload: { sentinel: 'opaque-payload-secret' },
    deadlineMs: 5_000,
  });
  await assert.rejects(agent.pollOnce({ holdMs: 0 }), /simulated response drop/u);
  const firstRequestId = transport.lastEnvelope.requestId;
  assert.equal(executions, 1);

  const reconnect = await agent.connect();
  assert.ok(reconnect.connectionEpoch > 1);
  const second = await agent.pollOnce({ holdMs: 0 });
  assert.equal(second.envelope.requestId, firstRequestId);
  assert.equal(executions, 1);
  assert.deepEqual(await dispatchPromise, { echoed: 'opaque-payload-secret' });

  const failedDispatch = core.dispatch({
    bearerToken: 'acct-a',
    deviceId: paired.deviceId,
    payload: { sentinel: 'local-error' },
    deadlineMs: 5_000,
  });
  const failed = rejectsCode(failedDispatch, 'LOCAL_SENTINEL_FAILED');
  await agent.pollOnce({ holdMs: 0 });
  await failed;

  const text = JSON.stringify(logs);
  assert.equal(text.includes('opaque-payload-secret'), false);
  assert.equal(text.includes(paired.credential), false);
  assert.equal(text.includes('acct-a'), false);
});

test('runtime changes fail in-flight work closed and relay restart never persists tool payloads', async (t) => {
  const { store, core } = harness(t);
  const paired = await pair(core, 'acct-a', 'Workstation');
  const first = core.connectAgent({
    deviceId: paired.deviceId,
    credential: paired.credential,
    runtimeId: 'runtime-old',
    executorReady: true,
    protocolVersion: '1',
  });

  const pending = core.dispatch({
    bearerToken: 'acct-a',
    deviceId: paired.deviceId,
    payload: { sentinel: 'never-replay-across-runtime' },
    deadlineMs: 5_000,
  });
  const rejected = rejectsCode(pending, 'DEVICE_RUNTIME_CHANGED');
  const envelope = await core.pollAgent({
    deviceId: paired.deviceId,
    credential: paired.credential,
    runtimeId: 'runtime-old',
    connectionEpoch: first.connectionEpoch,
    executorReady: true,
    holdMs: 1_000,
  });
  const next = core.connectAgent({
    deviceId: paired.deviceId,
    credential: paired.credential,
    runtimeId: 'runtime-new',
    executorReady: true,
    protocolVersion: '1',
  });
  await rejected;
  assert.ok(next.connectionEpoch > first.connectionEpoch);
  assert.throws(
    () => core.respondAgent({
      deviceId: paired.deviceId,
      credential: paired.credential,
      runtimeId: 'runtime-old',
      connectionEpoch: first.connectionEpoch,
      requestId: envelope.requestId,
      response: { ok: true },
    }),
    (error) => error?.code === 'DEVICE_RUNTIME_CHANGED'
  );

  const pendingRestart = core.dispatch({
    bearerToken: 'acct-a',
    deviceId: paired.deviceId,
    payload: { sentinel: 'memory-only-inflight' },
    deadlineMs: 5_000,
  });
  const restarted = rejectsCode(pendingRestart, 'RELAY_RESTARTED');
  const delivered = await core.pollAgent({
    deviceId: paired.deviceId,
    credential: paired.credential,
    runtimeId: 'runtime-new',
    connectionEpoch: next.connectionEpoch,
    executorReady: true,
    holdMs: 1_000,
  });
  assert.equal(delivered.payload.sentinel, 'memory-only-inflight');
  core.close();
  await restarted;

  const replacement = new RelayCore({ store, verifyBearer, now: core.now });
  t.after(() => replacement.close());
  const replacementSession = replacement.connectAgent({
    deviceId: paired.deviceId,
    credential: paired.credential,
    runtimeId: 'runtime-new',
    executorReady: true,
    protocolVersion: '1',
  });
  const afterRestart = await replacement.pollAgent({
    deviceId: paired.deviceId,
    credential: paired.credential,
    runtimeId: 'runtime-new',
    connectionEpoch: replacementSession.connectionEpoch,
    executorReady: true,
    holdMs: 0,
  });
  assert.equal(afterRestart, null);
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM devices WHERE device_id = ?').get(paired.deviceId)).includes('memory-only-inflight'), false);
});

test('HTTP long-poll control plane preserves account/device auth boundaries and exposes no filesystem-scope mutation', async (t) => {
  const logs = [];
  const { core } = harness(t, { logger: (entry) => logs.push(entry) });
  const relay = await startRelayHttpServer({ core, host: '127.0.0.1', port: 0 });
  t.after(() => relay.close());

  const post = async (pathname, body, authorization = null) => {
    const headers = { 'content-type': 'application/json' };
    if (authorization) headers.authorization = authorization;
    const response = await fetch(relay.url + pathname, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    return { response, body: await response.json() };
  };

  const start = await post('/pairing/start', { displayName: 'HTTP device' });
  assert.equal(start.response.status, 200);
  const approve = await post('/pairing/approve', { userCode: start.body.userCode }, 'Bearer acct-a');
  assert.equal(approve.response.status, 200);
  const complete = await post('/pairing/complete', { deviceCode: start.body.deviceCode });
  assert.equal(complete.response.status, 200);

  const paired = complete.body;
  const ready = { value: true };
  const transport = new HttpAgentTransport({
    relayBaseUrl: relay.url,
    deviceId: paired.deviceId,
    credential: paired.credential,
  });
  const agent = new DeviceRelayAgent({
    deviceId: paired.deviceId,
    credential: paired.credential,
    readyzUrl: 'http://127.0.0.1:8745/readyz',
    transport,
    runtimeId: 'runtime-http',
    fetchFn: readinessFetch(ready),
    execute: async (payload) => ({ local: payload.action }),
  });
  await agent.connect();

  const listedResponse = await fetch(relay.url + '/devices', { headers: { authorization: 'Bearer acct-a' } });
  const listed = await listedResponse.json();
  assert.equal(listed.devices.length, 1);
  assert.equal(listed.devices[0].ready, true);

  const dispatchFetch = fetch(relay.url + '/internal/dispatch/' + encodeURIComponent(paired.deviceId), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer acct-a' },
    body: JSON.stringify({ payload: { action: 'relay-secret-action' }, deadlineMs: 5_000 }),
  });
  await agent.pollOnce({ holdMs: 1_000 });
  const dispatchResponse = await dispatchFetch;
  assert.equal(dispatchResponse.status, 200);
  assert.deepEqual(await dispatchResponse.json(), { ok: true, value: { local: 'relay-secret-action' } });

  const wrongAccount = await fetch(relay.url + '/devices/' + encodeURIComponent(paired.deviceId), { headers: { authorization: 'Bearer acct-b' } });
  assert.equal(wrongAccount.status, 404);

  const deviceCannotManage = await fetch(relay.url + '/devices', { headers: { authorization: 'Device ' + paired.credential } });
  assert.equal(deviceCannotManage.status, 401);

  const scopeAttempt = await post('/filesystem-scope', { mode: 'anything' }, 'Bearer acct-a');
  assert.equal(scopeAttempt.response.status, 404);

  const relaySource = fs.readFileSync(new URL('../../src/relay/core.js', import.meta.url), 'utf8');
  assert.equal(/selected_roots|os_user_scope/iu.test(relaySource), false);

  const logText = JSON.stringify(logs);
  assert.equal(logText.includes('relay-secret-action'), false);
  assert.equal(logText.includes(paired.credential), false);
  assert.equal(logText.includes('acct-a'), false);
});
