import path from 'node:path';

const HEX40 = /^[a-f0-9]{40}$/u;
const HEX64 = /^[a-f0-9]{64}$/u;
const PORTS = [18745, 18746, 18747, 18748, 18749];
const REQUIRED_REFS = ['ISSUE185_RELAY_AUTHORIZATION', 'LOCAL_RELAY_DEVICE_SECRET', 'CONTROL_PLANE_API_KEY', 'ISSUE185_DEVICE_B_SECRET'];

function absolute(value) {
  const p = String(value || '').trim();
  if (!path.win32.isAbsolute(p)) throw new Error('absolute Windows path required');
  return path.win32.normalize(p).toLowerCase();
}

export function planDesktopRelayMigration(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('explicit read-only host snapshot required');
  const { deviceB, relay, task, tunnel, source, target } = snapshot;
  if (!deviceB || !relay || !task || !tunnel || !source || !target) throw new Error('incomplete read-only preflight');
  if (!HEX40.test(String(deviceB.servingSha || ''))) throw new Error('Device B exact serving SHA required');
  if (!HEX64.test(String(deviceB.configSha256 || ''))) throw new Error('Device B config hash required');
  if (!deviceB.deviceId || !deviceB.credentialEnv) throw new Error('Device B identity/credential reference missing');
  if (!deviceB.repo || !deviceB.config || !deviceB.dataRoot || !relay.dataRoot) throw new Error('canonical roots required');
  if (absolute(deviceB.dataRoot) === absolute(relay.dataRoot)
      || absolute(deviceB.dataRoot).startsWith(absolute(relay.dataRoot) + '\\')
      || absolute(relay.dataRoot).startsWith(absolute(deviceB.dataRoot) + '\\')) {
    throw new Error('Relay and Device B data roots must be disjoint');
  }
  if (task.owned !== true || task.kind !== 'stable-runtime'
      || task.trigger !== 'AtLogOn' || task.existingDeviceId !== deviceB.deviceId) {
    throw new Error('existing Device B login Task ownership/binding mismatch');
  }
  if (task.existingConfigSha256 !== deviceB.configSha256) throw new Error('Device B config hash drift');
  if (!tunnel.profileSha256 || !HEX64.test(tunnel.profileSha256) || !tunnel.clientSha256 || !HEX64.test(tunnel.clientSha256)) {
    throw new Error('exact Secure MCP Tunnel artifact hashes required');
  }
  if (!Array.isArray(source.relayDbFiles) || !source.relayDbFiles.includes('relay.sqlite')) {
    throw new Error('source Relay SQLite inventory required');
  }
  if (source.relayRunning !== true || source.tunnelRunning !== true) throw new Error('expected source topology changed; reconcile first');
  if (target.relayRunning || target.tunnelRunning) throw new Error('destination Relay/Tunnel already active; reconcile ownership');
  const collisions = PORTS.filter((port) => (target.listenerPorts || []).includes(port) && port !== 18749);
  if (collisions.length || !(target.listenerPorts || []).includes(18749)) throw new Error('destination listener topology mismatch');
  const missingRefs = REQUIRED_REFS.filter((name) => target.userSecretReferences?.[name] !== true);
  const blockers = [
    ...(missingRefs.length ? ['missing destination User-scope references: ' + missingRefs.join(', ')] : []),
    ...(!target.tunnelClientInstalled ? ['exact tunnel-client binary and SHA-256 not installed/verified'] : []),
    ...(!target.tailscaleServeReady ? ['destination Tailscale Serve ingress not configured/verified'] : []),
    ...(!target.relaySnapshotReady ? ['quiesced, consistent SQLite snapshot + rollback not proven'] : []),
    ...(!target.parentCutoverApproved ? ['Parent-controlled network/Task/credential/DB cutover approval absent'] : []),
  ];
  return {
    status: blockers.length ? 'PARENT_GATES_REMAIN' : 'READY_FOR_SEPARATE_PARENT_CUTOVER',
    deviceB: { deviceId: deviceB.deviceId, configSha256: deviceB.configSha256, servingSha: deviceB.servingSha },
    retainedTask: { kind: task.kind, trigger: task.trigger },
    isolatedDataRoots: true,
    proposedOrder: ['retain-existing-Device-B-task', 'stage-separate-relay-root-and-reviewed-bootstrap',
      'validate-source-sqlite-consistent-backup-after-authorized-quiescence',
      'verify-tunnel-profile-identity-and-single-client-queue',
      'Parent-authorized-single-writer-cutover', 'recover-Device-B-with-original-identity',
      'verify-exact-A-and-B-canaries', 'test-cold-login-and-reversible-rollback'],
    blockers,
  };
}
