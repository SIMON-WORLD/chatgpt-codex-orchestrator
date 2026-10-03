import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FIXED_RELAY_HOST, planFixedRelayHostBootstrap } from '../../src/operability/windows-relay-host-bootstrap.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOOTSTRAP = fs.readFileSync(path.join(ROOT, 'scripts', 'windows-relay-host-bootstrap.ps1'), 'utf8');

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

  const actions = planFixedRelayHostBootstrap(baseEvidence());
  assert.deepEqual(actions.map((row) => row.kind), [
    'reuse-relay-runner',
    'reuse-secure-tunnel',
    'recover-stable-runtime',
    'private-relay-doctor',
  ]);
  assert.deepEqual(actions[2].args, [
    FIXED_RELAY_HOST.bootstrapRepoRoot + '\\host\\stable-runtime-recover.mjs',
    '--config', FIXED_RELAY_HOST.stableConfig,
    '--repo', FIXED_RELAY_HOST.bootstrapRepoRoot,
    '--sha', FIXED_RELAY_HOST.stableSha,
  ]);
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
