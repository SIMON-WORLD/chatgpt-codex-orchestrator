import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FIXED_RELAY_HOST, planFixedRelayHostBootstrap } from '../../src/operability/windows-relay-host-bootstrap.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOOTSTRAP = fs.readFileSync(path.join(ROOT, 'scripts', 'windows-relay-host-bootstrap.ps1'), 'utf8');
const RECOVERY_CLI = fs.readFileSync(path.join(ROOT, 'host', 'stable-runtime-recover.mjs'));

function baseEvidence() {
  return {
    hashes: {
      relayRunner: FIXED_RELAY_HOST.relayRunnerSha256,
      tunnelProfile: FIXED_RELAY_HOST.tunnelProfileSha256,
      stableConfig: FIXED_RELAY_HOST.stableConfigSha256,
    },
    secretRefs: {
      ISSUE185_RELAY_AUTHORIZATION: true,
      LOCAL_RELAY_DEVICE_SECRET: true,
      CONTROL_PLANE_API_KEY: true,
    },
    listeners: {
      18745: [7128],
      18746: [7128],
      18747: [7128],
      18748: [9128],
      18749: [20160],
    },
    processes: {
      7128: {
        executablePath: FIXED_RELAY_HOST.nodeExe,
        commandLine: '"' + FIXED_RELAY_HOST.nodeExe + '" ' + FIXED_RELAY_HOST.relayRunner + ' ',
      },
      9128: {
        executablePath: FIXED_RELAY_HOST.tunnelExe,
        commandLine: '"' + FIXED_RELAY_HOST.tunnelExe + '" run --profile ' + FIXED_RELAY_HOST.tunnelProfile + ' --profile-dir ' + FIXED_RELAY_HOST.tunnelProfileDir + ' ',
      },
    },
    relayAuthorizationProbeReady: true,
    tunnelReady: true,
  };
}

test('fixed bootstrap pins exact current Relay/Tunnel/Device-A topology and canonical commands', () => {
  assert.match(BOOTSTRAP, /18745, 18746, 18747/u);
  assert.match(BOOTSTRAP, /\$TunnelPort = 18748/u);
  assert.match(BOOTSTRAP, /stablePort = 18749/u);
  assert.match(BOOTSTRAP, /tunnel-client-v0\.0\.14-windows-amd64\\tunnel-client\.exe/u);
  assert.match(BOOTSTRAP, /\$TunnelProfile = 'issue-185-relay'/u);
  assert.match(BOOTSTRAP, /host\\stable-runtime-recover\.mjs/u);
  assert.match(BOOTSTRAP, /scripts\\private-relay-doctor\.mjs/u);
  assert.match(BOOTSTRAP, /5c36a7aaebe0f51e012f8a27ab160c2bf9eebde9/u);
  assert.match(BOOTSTRAP, /issue-185-runtime\\windows-login-autostart\\windows-relay-host-bootstrap\.ps1/u);
  assert.match(BOOTSTRAP, /9ed8978d4075e782cb7c573bdb97fe426e11865a80250b10c183919317d08536/u);
  assert.match(BOOTSTRAP, /2ad32ee6e91d9a9728452a3fb8ee1156c8a24d0f3d29eade58a117df69676f65/u);
  assert.match(BOOTSTRAP, /Write-Output 'WINDOWS_RELAY_HOST_BOOTSTRAP PASS'\r?\nexit 0/u);
  assert.doesNotMatch(BOOTSTRAP, /issue-212-(?:revise|persistence-revise|autostart)/u);

  const actions = planFixedRelayHostBootstrap(baseEvidence());
  assert.deepEqual(actions.map((row) => row.kind), [
    'reuse-relay-runner',
    'reuse-secure-tunnel',
    'recover-stable-runtime',
    'private-relay-doctor',
  ]);
  assert.deepEqual(actions[2].args, [
    FIXED_RELAY_HOST.recoveryRepoRoot + '\\host\\stable-runtime-recover.mjs',
    '--config', FIXED_RELAY_HOST.stableConfig,
    '--repo', FIXED_RELAY_HOST.stableRepoRoot,
    '--sha', FIXED_RELAY_HOST.stableSha,
  ]);
});


test('fixed recovery executable uses #216 deterministic CLI exit from the durable f87 recovery checkout', () => {
  assert.equal(FIXED_RELAY_HOST.recoveryRepoSha, 'f87f4665fa225e904f4edf0408181f52074e267e');
  // GitHub/Linux checks out LF, while the approved Windows deployment uses CRLF.
  // Check the exact on-disk Windows bytes that the host bootstrap hashes.
  const windowsBytes = RECOVERY_CLI.toString('utf8').replace(/\r?\n/gu, '\r\n');
  assert.equal(crypto.createHash('sha256').update(windowsBytes).digest('hex'), FIXED_RELAY_HOST.recoverySha256);
  assert.match(RECOVERY_CLI.toString('utf8'), /process\.exit\(await main\(\)\)/u);
  assert.match(RECOVERY_CLI.toString('utf8'), /fs\.writeSync\(stream\.fd/u);
  assert.match(BOOTSTRAP, /\$RecoveryRepo = 'E:\\Project\\chatgpt-codex-orchestrator\\windows-login-runtime'/u);
  assert.match(BOOTSTRAP, /\$Recovery = Join-Path \$RecoveryRepo 'host\\stable-runtime-recover\.mjs'/u);
  assert.match(BOOTSTRAP, /Assert-ExactFileHash \$Recovery \$RecoverySha256/u);
  assert.match(BOOTSTRAP, /Assert-RecoveryRepoRevision/u);
  assert.match(BOOTSTRAP, /\$RecoveryRepoSha = 'f87f4665fa225e904f4edf0408181f52074e267e'/u);
  assert.doesNotMatch(BOOTSTRAP, /\$Recovery = Join-Path \$RelayRepo/u);
  assert.doesNotMatch(BOOTSTRAP, /f6f7d17fb4e6908eb6e34cbee60811eee3f436ae9a4aae6269a18f74976a2694/u);
  assert.match(BOOTSTRAP, /& \$NodeExe \$Recovery '--config' \$StableConfig '--repo' \$RelayRepo '--sha' \$StableSha/u);
  assert.equal(FIXED_RELAY_HOST.stableSha, '5c36a7aaebe0f51e012f8a27ab160c2bf9eebde9');
  assert.equal(FIXED_RELAY_HOST.stableRepoRoot, FIXED_RELAY_HOST.relayRepo);
  assert.match(BOOTSTRAP, /\$Doctor = Join-Path \$RelayRepo 'scripts\\private-relay-doctor\.mjs'/u);
});

test('Computer1 cold-start plan keeps existing Relay/Tunnel/Device A bindings with no listeners', () => {
  const evidence = baseEvidence();
  for (const port of [18745, 18746, 18747, 18748, 18749]) evidence.listeners[port] = [];
  evidence.relayAuthorizationProbeReady = false;
  evidence.tunnelReady = false;
  const actions = planFixedRelayHostBootstrap(evidence);
  assert.deepEqual(actions.map((action) => action.kind), [
    'start-relay-runner', 'start-secure-tunnel', 'recover-stable-runtime', 'private-relay-doctor',
  ]);
  assert.deepEqual(actions[2].args, [
    FIXED_RELAY_HOST.recoveryRepoRoot + '\\host\\stable-runtime-recover.mjs',
    '--config', FIXED_RELAY_HOST.stableConfig,
    '--repo', FIXED_RELAY_HOST.stableRepoRoot,
    '--sha', FIXED_RELAY_HOST.stableSha,
  ]);
  assert.equal(FIXED_RELAY_HOST.stablePort, 18749);
  assert.equal(FIXED_RELAY_HOST.stableConfigSha256, '8092b6443dcd6c3b4409ae078cf3c483dc99ac1232d7aae25f1e53634deea148');
  assert.equal(FIXED_RELAY_HOST.relayRunnerSha256, 'ff64a79bc20bb7104a2536e5c205451f96b219d0b08e197211a720dfcb9e84e1');
  assert.equal(FIXED_RELAY_HOST.tunnelProfileSha256, '303370e08438977baa25f0cd9e16c8cc4c75fddd5297de40f56c94d3b80cfaa3');
});

test('bootstrap obtains all secrets only from User scope and keeps MCP authorization as an in-process env reference', () => {
  for (const name of ['ISSUE185_RELAY_AUTHORIZATION', 'LOCAL_RELAY_DEVICE_SECRET', 'CONTROL_PLANE_API_KEY']) {
    assert.match(BOOTSTRAP, new RegExp("Get-UserSecret '" + name + "'", 'u'));
  }
  assert.match(BOOTSTRAP, /GetEnvironmentVariable\(\$Name, 'User'\)/u);
  assert.match(BOOTSTRAP, /\('Author' \+ 'ization: env:ISSUE185_RELAY_AUTHORIZATION'\)/u);
  assert.match(BOOTSTRAP, /MCP_EXTRA_HEADERS/u);
  assert.match(BOOTSTRAP, /MCP_DISCOVERY_EXTRA_HEADERS/u);
  assert.doesNotMatch(BOOTSTRAP, /Bearer [A-Za-z0-9._~+/=-]{12,}/u);
  assert.doesNotMatch(BOOTSTRAP, /SetEnvironmentVariable\([^)]*'User'/u);
  assert.doesNotMatch(BOOTSTRAP, /schtasks|Register-ScheduledTask|New-Service|sc\.exe/iu);
});

test('missing User-scope secret reference fails closed deterministically', () => {
  const evidence = baseEvidence();
  evidence.secretRefs.CONTROL_PLANE_API_KEY = false;
  assert.throws(() => planFixedRelayHostBootstrap(evidence), /missing User-scope secret reference: CONTROL_PLANE_API_KEY/u);
});

test('wrong relay listener identity/path fails closed and absent relay plans exactly one start', () => {
  const drift = baseEvidence();
  drift.processes[7128].commandLine = '"' + FIXED_RELAY_HOST.nodeExe + '" E:\\wrong\\relay-runner.mjs';
  assert.throws(() => planFixedRelayHostBootstrap(drift), /relay process identity\/path drift/u);

  const absent = baseEvidence();
  absent.listeners[18745] = [];
  absent.listeners[18746] = [];
  absent.listeners[18747] = [];
  const actions = planFixedRelayHostBootstrap(absent);
  assert.equal(actions.filter((row) => row.kind === 'start-relay-runner').length, 1);
  assert.equal(actions.some((row) => row.kind === 'reuse-relay-runner'), false);
});

test('wrong tunnel profile/path or readiness fails closed and absent tunnel plans exactly one start', () => {
  const profileDrift = baseEvidence();
  profileDrift.processes[9128].commandLine = '"' + FIXED_RELAY_HOST.tunnelExe + '" run --profile wrong --profile-dir ' + FIXED_RELAY_HOST.tunnelProfileDir;
  assert.throws(() => planFixedRelayHostBootstrap(profileDrift), /tunnel process\/profile\/path drift/u);

  const notReady = baseEvidence();
  notReady.tunnelReady = false;
  assert.throws(() => planFixedRelayHostBootstrap(notReady), /tunnel readiness failed/u);

  const absent = baseEvidence();
  absent.listeners[18748] = [];
  const actions = planFixedRelayHostBootstrap(absent);
  assert.equal(actions.filter((row) => row.kind === 'start-secure-tunnel').length, 1);
  assert.equal(actions.some((row) => row.kind === 'reuse-secure-tunnel'), false);
});

test('hash drift fails closed before lifecycle composition', () => {
  const evidence = baseEvidence();
  evidence.hashes.stableConfig = '0'.repeat(64);
  assert.throws(() => planFixedRelayHostBootstrap(evidence), /stableConfig hash drift/u);
});

test('idempotent second invocation reuses exact live Relay and Tunnel without duplicate starts', () => {
  const evidence = baseEvidence();
  const first = planFixedRelayHostBootstrap(evidence);
  const second = planFixedRelayHostBootstrap(evidence);
  for (const actions of [first, second]) {
    assert.equal(actions.some((row) => row.kind.startsWith('start-')), false);
    assert.deepEqual(actions.map((row) => row.kind), [
      'reuse-relay-runner',
      'reuse-secure-tunnel',
      'recover-stable-runtime',
      'private-relay-doctor',
    ]);
  }
});
