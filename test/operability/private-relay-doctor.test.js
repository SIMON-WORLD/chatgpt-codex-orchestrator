import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { composePrivateRelayDoctor } from '../../src/operability/private-relay-doctor.js';

function fixtureConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-200-doctor-'));
  const file = path.join(dir, 'runtime.json');
  fs.writeFileSync(file, JSON.stringify({
    host: '127.0.0.1',
    port: 8745,
    tunnel: {
      external: true,
      localMcpUrl: 'http://127.0.0.1:8745/mcp',
      healthUrl: 'http://127.0.0.1:8081/readyz',
    },
    relayAgent: {
      enabled: true,
      relayUrl: 'https://relay.example',
      deviceId: 'device-a',
      credentialEnv: 'DEVICE_SECRET',
    },
  }));
  return file;
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test('composed doctor reports exact runtime, tunnel and Ready device without exposing bearer', async () => {
  const sha = 'a'.repeat(40);
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    seen.push({ url, authorization: options.headers?.authorization });
    if (url.endsWith('/healthz')) return response(200, { revision: sha });
    if (url.includes(':8745/readyz')) return response(200, { revision: sha });
    if (url.includes(':8081/readyz')) return response(200, { ready: true });
    if (url.endsWith('/devices')) return response(200, { devices: [{
      deviceId: 'device-a', displayName: 'Laptop', online: true,
      executorReady: true, ready: true, runtimeId: 'runtime-a', lastSeenAt: 123,
    }] });
    throw new Error('unexpected url');
  };

  const out = await composePrivateRelayDoctor({
    configPath: fixtureConfig(), expectedSha: sha,
    accountBearer: 'super-secret-bearer', fetchImpl,
  });
  assert.equal(out.status, 'READY');
  assert.equal(out.stableRuntime.revision, sha);
  assert.equal(out.configuration.profileMatches, true);
  assert.equal(out.configuration.relayDeviceMatches, true);
  assert.equal(out.configuration.configuredRelayDeviceReady, true);
  assert.equal(out.secureTunnel.ready, true);
  assert.equal(out.devices[0].ready, true);
  assert.equal(out.devices[0].runtimeId, 'runtime-a');
  assert.equal(JSON.stringify(out).includes('super-secret-bearer'), false);
  assert.equal(seen.find((x) => x.url.endsWith('/devices')).authorization, 'Bearer super-secret-bearer');
});

test('configured device readiness cannot be satisfied by another Ready account device', async () => {
  const sha = 'c'.repeat(40);
  const configPath = fixtureConfig();
  const exactNotReady = async (url) => {
    if (url.endsWith('/devices')) return response(200, { devices: [
      { deviceId: 'device-a', online: true, executorReady: false, ready: false, runtimeId: 'runtime-a' },
      { deviceId: 'device-b', online: true, executorReady: true, ready: true, runtimeId: 'runtime-b' },
    ] });
    return response(200, { revision: sha });
  };
  const missingExact = async (url) => {
    if (url.endsWith('/devices')) return response(200, { devices: [
      { deviceId: 'device-b', online: true, executorReady: true, ready: true, runtimeId: 'runtime-b' },
    ] });
    return response(200, { revision: sha });
  };

  const notReady = await composePrivateRelayDoctor({ configPath, expectedSha: sha, accountBearer: 'token', fetchImpl: exactNotReady });
  assert.equal(notReady.status, 'NOT_READY');
  assert.equal(notReady.stopBoundary, 'device_readiness');
  assert.equal(notReady.configuration.relayDeviceMatches, true);
  assert.equal(notReady.configuration.configuredRelayDeviceReady, false);
  assert.equal(notReady.devices.find((device) => device.deviceId === 'device-b').ready, true);

  const missing = await composePrivateRelayDoctor({ configPath, expectedSha: sha, accountBearer: 'token', fetchImpl: missingExact });
  assert.equal(missing.status, 'NOT_READY');
  assert.equal(missing.stopBoundary, 'device_readiness');
  assert.equal(missing.configuration.relayDeviceMatches, false);
  assert.equal(missing.configuration.configuredRelayDeviceReady, false);
  assert.equal(missing.devices[0].ready, true);
});

test('composed doctor distinguishes runtime, tunnel, relay and device-readiness boundaries', async () => {
  const sha = 'b'.repeat(40);
  const configPath = fixtureConfig();
  const scenarios = [
    ['stable_runtime', async (url) => url.endsWith('/healthz') ? response(503, {}) : response(200, { revision: sha, devices: [] })],
    ['secure_tunnel', async (url) => url.includes(':8081/readyz') ? response(503, {}) : url.endsWith('/devices') ? response(200, { devices: [] }) : response(200, { revision: sha })],
    ['relay', async (url) => url.endsWith('/devices') ? response(503, {}) : response(200, { revision: sha })],
    ['device_readiness', async (url) => url.endsWith('/devices') ? response(200, { devices: [{ deviceId: 'd', online: true, executorReady: false, ready: false }] }) : response(200, { revision: sha })],
  ];
  for (const [expectedBoundary, fetchImpl] of scenarios) {
    const out = await composePrivateRelayDoctor({ configPath, expectedSha: sha, accountBearer: 'token', fetchImpl });
    assert.equal(out.stopBoundary, expectedBoundary);
    assert.equal(out.status, 'NOT_READY');
  }
});
