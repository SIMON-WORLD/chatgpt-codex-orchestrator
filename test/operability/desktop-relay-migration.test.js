import assert from 'node:assert/strict';
import test from 'node:test';
import { planDesktopRelayMigration } from '../../src/operability/desktop-relay-migration.js';

const H = 'a'.repeat(64);
function snapshot() {
  return {
    deviceB: { deviceId: 'existing-b', credentialEnv: 'ISSUE185_DEVICE_B_SECRET', servingSha: 'b'.repeat(40),
      configSha256: H, repo: 'E:\\Project\\repo', config: 'E:\\Project\\runtime-b\\config.json', dataRoot: 'E:\\Project\\runtime-b\\data' },
    relay: { dataRoot: 'E:\\Project\\relay-runtime' },
    task: { owned: true, kind: 'stable-runtime', trigger: 'AtLogOn', existingDeviceId: 'existing-b', existingConfigSha256: H },
    tunnel: { profileSha256: H, clientSha256: H },
    source: { relayDbFiles: ['relay.sqlite', 'relay.sqlite-wal', 'relay.sqlite-shm'], relayRunning: true, tunnelRunning: true },
    target: { listenerPorts: [18749], relayRunning: false, tunnelRunning: false, userSecretReferences: {},
      tunnelClientInstalled: false, tailscaleServeReady: false, relaySnapshotReady: false, parentCutoverApproved: false },
  };
}
test('preflight is read-only and reports missing desktop cutover gates', () => {
  const s = snapshot();
  const before = structuredClone(s);
  const p = planDesktopRelayMigration(s);
  assert.equal(p.status, 'PARENT_GATES_REMAIN');
  assert.ok(p.blockers.some(x => x.includes('ISSUE185_RELAY_AUTHORIZATION')));
  assert.deepEqual(s, before);
});
test('preflight rejects exact Device B identity or config drift', () => {
  const s = snapshot(); s.task.existingDeviceId = 'different';
  assert.throws(() => planDesktopRelayMigration(s), /identity|binding/u);
  s.task.existingDeviceId = 'existing-b'; s.task.existingConfigSha256 = 'c'.repeat(64);
  assert.throws(() => planDesktopRelayMigration(s), /config hash drift/u);
});
test('preflight rejects data-root overlap and foreign listener ownership', () => {
  const s = snapshot(); s.relay.dataRoot = s.deviceB.dataRoot;
  assert.throws(() => planDesktopRelayMigration(s), /disjoint/u);
  s.relay.dataRoot = 'E:\\Project\\relay-runtime'; s.target.listenerPorts.push(18745);
  assert.throws(() => planDesktopRelayMigration(s), /listener topology/u);
});
test('preflight never grants approval; all externally verified flags remain explicit', () => {
  const s = snapshot();
  s.target.userSecretReferences = Object.fromEntries(['ISSUE185_RELAY_AUTHORIZATION', 'LOCAL_RELAY_DEVICE_SECRET', 'CONTROL_PLANE_API_KEY', 'ISSUE185_DEVICE_B_SECRET'].map(x=>[x,true]));
  Object.assign(s.target, { tunnelClientInstalled: true, tailscaleServeReady: true, relaySnapshotReady: true, parentCutoverApproved: true });
  const p = planDesktopRelayMigration(s);
  assert.equal(p.status, 'READY_FOR_SEPARATE_PARENT_CUTOVER');
  assert.deepEqual(p.blockers, []);
});
