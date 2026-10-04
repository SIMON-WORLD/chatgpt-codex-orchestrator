export const FIXED_RELAY_HOST = Object.freeze({
  nodeExe: 'D:\\Software\\nvm\\nodejs\\node.exe',
  durableBootstrapPath: 'E:\\Project\\chatgpt-codex-orchestrator\\issue-185-runtime\\windows-login-autostart\\windows-relay-host-bootstrap.ps1',
  stableRepoRoot: 'E:\\Project\\chatgpt-codex-orchestrator\\chatgpt-codex-orchestrator-issue-185',
  recoverySha256: 'f6f7d17fb4e6908eb6e34cbee60811eee3f436ae9a4aae6269a18f74976a2694',
  doctorSha256: '2ad32ee6e91d9a9728452a3fb8ee1156c8a24d0f3d29eade58a117df69676f65',
  relayRepo: 'E:\\Project\\chatgpt-codex-orchestrator\\chatgpt-codex-orchestrator-issue-185',
  runtimeRoot: 'E:\\Project\\chatgpt-codex-orchestrator\\issue-185-runtime',
  relayRunner: 'E:\\Project\\chatgpt-codex-orchestrator\\issue-185-runtime\\relay-runner.mjs',
  relayRunnerSha256: 'ff64a79bc20bb7104a2536e5c205451f96b219d0b08e197211a720dfcb9e84e1',
  tunnelExe: 'D:\\Software\\tunnel-client\\tunnel-client-v0.0.14-windows-amd64\\tunnel-client.exe',
  tunnelProfile: 'issue-185-relay',
  tunnelProfileDir: 'E:\\Project\\chatgpt-codex-orchestrator\\issue-185-runtime\\tunnel-profiles',
  tunnelProfilePath: 'E:\\Project\\chatgpt-codex-orchestrator\\issue-185-runtime\\tunnel-profiles\\issue-185-relay.yaml',
  tunnelProfileSha256: '303370e08438977baa25f0cd9e16c8cc4c75fddd5297de40f56c94d3b80cfaa3',
  stableConfig: 'E:\\Project\\chatgpt-codex-orchestrator\\issue-185-runtime\\device-a-config.json',
  stableConfigSha256: '8092b6443dcd6c3b4409ae078cf3c483dc99ac1232d7aae25f1e53634deea148',
  stableSha: '5c36a7aaebe0f51e012f8a27ab160c2bf9eebde9',
  relayPorts: Object.freeze([18745, 18746, 18747]),
  tunnelPort: 18748,
  stablePort: 18749,
  relayAuthorizationEnv: 'ISSUE185_RELAY_AUTHORIZATION',
  deviceSecretEnv: 'LOCAL_RELAY_DEVICE_SECRET',
  controlPlaneApiKeyEnv: 'CONTROL_PLANE_API_KEY',
  mcpHeaderReference: 'Authorization: env:ISSUE185_RELAY_AUTHORIZATION',
});

function normalizePath(value) {
  return String(value || '').replace(/\//gu, '\\').toLowerCase();
}

function normalizeCommandLine(value) {
  return String(value || '').replace(/"/gu, '').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function exactCommand(process, exe, args) {
  if (!process) return false;
  if (normalizePath(process.executablePath) !== normalizePath(exe)) return false;
  return normalizeCommandLine(process.commandLine) === normalizeCommandLine([exe, ...args].join(' '));
}

function listenerPids(listeners, port) {
  return Array.isArray(listeners?.[port]) ? listeners[port] : [];
}

function requireExactHashes(hashes) {
  const expected = {
    relayRunner: FIXED_RELAY_HOST.relayRunnerSha256,
    tunnelProfile: FIXED_RELAY_HOST.tunnelProfileSha256,
    stableConfig: FIXED_RELAY_HOST.stableConfigSha256,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (String(hashes?.[key] || '').toLowerCase() !== value) throw new Error(key + ' hash drift');
  }
}

function requireSecrets(secretRefs) {
  for (const name of [
    FIXED_RELAY_HOST.relayAuthorizationEnv,
    FIXED_RELAY_HOST.deviceSecretEnv,
    FIXED_RELAY_HOST.controlPlaneApiKeyEnv,
  ]) {
    if (secretRefs?.[name] !== true) throw new Error('missing User-scope secret reference: ' + name);
  }
}

export function planFixedRelayHostBootstrap({
  listeners = {},
  processes = {},
  hashes = {},
  secretRefs = {},
  relayAuthorizationProbeReady = false,
  tunnelReady = false,
} = {}) {
  requireExactHashes(hashes);
  requireSecrets(secretRefs);
  const actions = [];

  const relaySets = FIXED_RELAY_HOST.relayPorts.map((port) => listenerPids(listeners, port));
  if (relaySets.every((rows) => rows.length === 0)) {
    actions.push({ kind: 'start-relay-runner' });
  } else {
    if (!relaySets.every((rows) => rows.length === 1)) throw new Error('relay listener topology drift');
    const pid = relaySets[0][0];
    if (!relaySets.every((rows) => rows[0] === pid)) throw new Error('relay ports are not owned by one exact process');
    if (!exactCommand(processes[pid], FIXED_RELAY_HOST.nodeExe, [FIXED_RELAY_HOST.relayRunner])) {
      throw new Error('relay process identity/path drift');
    }
    if (!relayAuthorizationProbeReady) throw new Error('relay authorization readiness probe failed');
    actions.push({ kind: 'reuse-relay-runner', pid });
  }

  const tunnelPids = listenerPids(listeners, FIXED_RELAY_HOST.tunnelPort);
  if (tunnelPids.length === 0) {
    actions.push({ kind: 'start-secure-tunnel' });
  } else {
    if (tunnelPids.length !== 1) throw new Error('tunnel listener topology drift');
    const pid = tunnelPids[0];
    if (!exactCommand(processes[pid], FIXED_RELAY_HOST.tunnelExe, [
      'run', '--profile', FIXED_RELAY_HOST.tunnelProfile, '--profile-dir', FIXED_RELAY_HOST.tunnelProfileDir,
    ])) throw new Error('tunnel process/profile/path drift');
    if (!tunnelReady) throw new Error('tunnel readiness failed');
    actions.push({ kind: 'reuse-secure-tunnel', pid });
  }

  actions.push({
    kind: 'recover-stable-runtime',
    command: FIXED_RELAY_HOST.nodeExe,
    args: [
      FIXED_RELAY_HOST.stableRepoRoot + '\\host\\stable-runtime-recover.mjs',
      '--config', FIXED_RELAY_HOST.stableConfig,
      '--repo', FIXED_RELAY_HOST.stableRepoRoot,
      '--sha', FIXED_RELAY_HOST.stableSha,
    ],
  });
  actions.push({
    kind: 'private-relay-doctor',
    command: FIXED_RELAY_HOST.nodeExe,
    args: [
      FIXED_RELAY_HOST.stableRepoRoot + '\\scripts\\private-relay-doctor.mjs',
      '--config', FIXED_RELAY_HOST.stableConfig,
      '--sha', FIXED_RELAY_HOST.stableSha,
      '--account-bearer-env', 'PRIVATE_RELAY_ACCOUNT_BEARER',
    ],
  });
  return actions;
}
