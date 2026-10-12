import path from 'node:path';

const HEX40 = /^[a-f0-9]{40}$/u;
const HEX64 = /^[a-f0-9]{64}$/u;
const PORTS = [18745, 18746, 18747, 18748, 18749];
const REQUIRED_REFS = ['ISSUE185_RELAY_AUTHORIZATION', 'CONTROL_PLANE_API_KEY', 'ISSUE185_DEVICE_B_SECRET'];
const SOURCE_TUNNEL_STATES = new Set(['running', 'verified-stopped']);

function absolute(value) {
  const p = String(value || '').trim();
  if (!path.win32.isAbsolute(p)) throw new Error('absolute Windows path required');
  return path.win32.normalize(p).toLowerCase();
}

function verifySourceTunnelEvidence(source) {
  const state = String(source.tunnelState || '').trim();
  if (!SOURCE_TUNNEL_STATES.has(state)) {
    throw new Error('source tunnel state must be independently verified as running or verified-stopped');
  }
  if (state === 'running' && source.tunnelOwnerVerified !== true) {
    throw new Error('running source tunnel exact owner/profile is not verified');
  }
  if (state === 'verified-stopped' && source.competingTunnelQueueClient !== false) {
    throw new Error('verified-stopped source tunnel requires proof that no competing queue client is active');
  }
  return state;
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
  if (source.relayRunning !== true) throw new Error('source Relay writer is not the independently verified active writer');
  const sourceTunnelState = verifySourceTunnelEvidence(source);
  if (target.relayRunning || target.tunnelRunning) throw new Error('destination Relay/Tunnel already active; reconcile ownership');
  const collisions = PORTS.filter((port) => (target.listenerPorts || []).includes(port) && port !== 18749);
  if (collisions.length || !(target.listenerPorts || []).includes(18749)) throw new Error('destination listener topology mismatch');

  const missingRefs = REQUIRED_REFS.filter((name) => target.userSecretReferences?.[name] !== true);
  const blockers = [
    ...(missingRefs.length ? ['missing destination User-scope references: ' + missingRefs.join(', ')] : []),
    ...(!target.tunnelClientInstalled ? ['exact tunnel-client binary and SHA-256 not staged/verified'] : []),
    ...(!target.desktopRelayBootstrapReviewed ? ['desktop Relay/Tunnel-only bootstrap exact hash not reviewed'] : []),
  ];
  return {
    status: blockers.length ? 'STAGING_BLOCKED' : 'STAGING_PREFLIGHT_READY',
    deviceB: { deviceId: deviceB.deviceId, configSha256: deviceB.configSha256, servingSha: deviceB.servingSha },
    retainedTask: { kind: task.kind, trigger: task.trigger },
    sourceTunnelState,
    isolatedDataRoots: true,
    cutoverAuthorization: 'EXTERNAL_PARENT_HUMAN_ONLY',
    cutoverAuthorized: false,
    proposedOrder: [
      'retain-existing-Device-B-task',
      'stage-separate-relay-root-and-reviewed-bootstrap',
      'Parent-authorized-source-quiescence-and-consistent-sqlite-backup',
      'verify-tunnel-profile-identity-and-single-client-queue',
      'Parent-authorized-single-writer-network-and-credential-cutover',
      'recover-Device-B-with-original-identity',
      'verify-exact-A-and-B-canaries',
      'test-laptop-off-B-and-cold-login',
    ],
    blockers,
    externalCutoverGates: [
      'Parent/Human narrow authorization is not representable by this snapshot',
      'consistent source SQLite snapshot and rollback after authorized quiescence',
      'single active Relay writer and one Secure MCP Tunnel queue client',
      'approved destination credential provisioning',
      'approved Tailscale Serve and exact A/B Relay URL changes',
      'approved distinct desktop Relay-host AtLogOn Task installation',
    ],
  };
}
