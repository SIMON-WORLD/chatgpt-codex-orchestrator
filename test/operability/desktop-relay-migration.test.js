import assert from 'node:assert/strict';
import test from 'node:test';
import { planDesktopRelayMigration } from '../../src/operability/desktop-relay-migration.js';

const H = 'a'.repeat(64);
const REQUIRED_REFS = ['ISSUE185_RELAY_AUTHORIZATION', 'CONTROL_PLANE_API_KEY', 'ISSUE185_DEVICE_B_SECRET'];

function snapshot() {
  return {
    deviceB: {
      deviceId: '039923d2-be2d-4345-bfd8-fdf385abf715',
      credentialEnv: 'ISSUE185_DEVICE_B_SECRET',
      servingSha: 'b'.repeat(40),
      configSha256: H,
      repo: 'E:\\Project\\repo',
      config: 'E:\\Project\\runtime-b\\config.json',
      dataRoot: 'E:\\Project\\runtime-b\\data',
    },
    relay: { dataRoot: 'E:\\Project\\issue-222-relay-runtime' },
    task: {
      owned: true,
      kind: 'stable-runtime',
      trigger: 'AtLogOn',
      existingDeviceId: '039923d2-be2d-4345-bfd8-fdf385abf715',
      existingConfigSha256: H,
    },
    tunnel: { profileSha256: H, clientSha256: H },
    source: {
      relayDbFiles: ['relay.sqlite', 'relay.sqlite-wal', 'relay.sqlite-shm'],
      relayRunning: true,
      tunnelState: 'verified-stopped',
      competingTunnelQueueClient: false,
    },
    target: {
      listenerPorts: [18749],
      relayRunning: false,
      tunnelRunning: false,
      userSecretReferences: {},
      tunnelClientInstalled: false,
      desktopRelayBootstrapReviewed: false,
    },
  };
}

test('real incident shape accepts independently verified stopped source Tunnel and reports staging blockers', () => {
  const s = snapshot();
  const before = structuredClone(s);
  const p = planDesktopRelayMigration(s);
  assert.equal(p.status, 'STAGING_BLOCKED');
  assert.equal(p.sourceTunnelState, 'verified-stopped');
  assert.equal(p.cutoverAuthorized, false);
  assert.equal(p.cutoverAuthorization, 'EXTERNAL_PARENT_HUMAN_ONLY');
  assert.ok(p.blockers.some((x) => x.includes('ISSUE185_RELAY_AUTHORIZATION')));
  assert.equal(p.blockers.some((x) => x.includes('LOCAL_RELAY_DEVICE_SECRET')), false);
  assert.deepEqual(s, before);
});

test('running source Tunnel requires exact owner evidence; unknown or competing queue ownership fails closed', () => {
  const running = snapshot();
  running.source.tunnelState = 'running';
  delete running.source.competingTunnelQueueClient;
  assert.throws(() => planDesktopRelayMigration(running), /owner\/profile/u);
  running.source.tunnelOwnerVerified = true;
  assert.equal(planDesktopRelayMigration(running).sourceTunnelState, 'running');

  const unknown = snapshot();
  unknown.source.tunnelState = 'unknown';
  assert.throws(() => planDesktopRelayMigration(unknown), /independently verified/u);

  const duplicate = snapshot();
  duplicate.source.competingTunnelQueueClient = true;
  assert.throws(() => planDesktopRelayMigration(duplicate), /no competing queue client/u);
});

test('preflight rejects exact Device B identity/config drift and data-root/listener collisions', () => {
  const identity = snapshot();
  identity.task.existingDeviceId = 'different';
  assert.throws(() => planDesktopRelayMigration(identity), /identity|binding/u);

  const config = snapshot();
  config.task.existingConfigSha256 = 'c'.repeat(64);
  assert.throws(() => planDesktopRelayMigration(config), /config hash drift/u);

  const roots = snapshot();
  roots.relay.dataRoot = roots.deviceB.dataRoot;
  assert.throws(() => planDesktopRelayMigration(roots), /disjoint/u);

  const listener = snapshot();
  listener.target.listenerPorts.push(18745);
  assert.throws(() => planDesktopRelayMigration(listener), /listener topology/u);
});

test('snapshot booleans can satisfy staging facts but can never self-authorize cutover', () => {
  const s = snapshot();
  s.target.userSecretReferences = Object.fromEntries(REQUIRED_REFS.map((name) => [name, true]));
  s.target.tunnelClientInstalled = true;
  s.target.desktopRelayBootstrapReviewed = true;
  s.target.parentCutoverApproved = true;
  s.target.relaySnapshotReady = true;
  s.target.tailscaleServeReady = true;
  const p = planDesktopRelayMigration(s);
  assert.equal(p.status, 'STAGING_PREFLIGHT_READY');
  assert.deepEqual(p.blockers, []);
  assert.equal(p.cutoverAuthorized, false);
  assert.equal(p.cutoverAuthorization, 'EXTERNAL_PARENT_HUMAN_ONLY');
  assert.ok(p.externalCutoverGates.some((x) => x.includes('not representable by this snapshot')));
});
