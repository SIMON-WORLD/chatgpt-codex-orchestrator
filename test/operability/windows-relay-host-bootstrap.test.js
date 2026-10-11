import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
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
    '--sha', FIXED_RELAY_HOST.runtimeSha,
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
  assert.match(BOOTSTRAP, /& \$NodeExe \$Recovery '--config' \$StableConfig '--repo' \$RelayRepo '--sha' \$RuntimeSha/u);
  assert.match(BOOTSTRAP, /& \$NodeExe \$Doctor '--config' \$StableConfig '--sha' \$RuntimeSha/u);
  assert.match(BOOTSTRAP, /\$head -ne \$RelayRepoSha/u);
  assert.doesNotMatch(BOOTSTRAP, /\$head -ne \$RuntimeSha/u);
  assert.equal(FIXED_RELAY_HOST.relayRepoSha, '5c36a7aaebe0f51e012f8a27ab160c2bf9eebde9');
  assert.equal(FIXED_RELAY_HOST.runtimeSha, '628a2df906db9afcd8e80b7466f1667777e8cd69');
  assert.notEqual(FIXED_RELAY_HOST.relayRepoSha, FIXED_RELAY_HOST.runtimeSha);
  assert.equal(FIXED_RELAY_HOST.stableSha, FIXED_RELAY_HOST.runtimeSha);
  assert.match(BOOTSTRAP, /\$RelayRepoSha = '5c36a7aaebe0f51e012f8a27ab160c2bf9eebde9'/u);
  assert.match(BOOTSTRAP, /\$RuntimeSha = '628a2df906db9afcd8e80b7466f1667777e8cd69'/u);
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
    '--sha', FIXED_RELAY_HOST.runtimeSha,
  ]);
  assert.equal(FIXED_RELAY_HOST.stablePort, 18749);
  assert.equal(FIXED_RELAY_HOST.stableConfigSha256, '8092b6443dcd6c3b4409ae078cf3c483dc99ac1232d7aae25f1e53634deea148');
  assert.equal(FIXED_RELAY_HOST.relayRunnerSha256, 'ff64a79bc20bb7104a2536e5c205451f96b219d0b08e197211a720dfcb9e84e1');
  assert.equal(FIXED_RELAY_HOST.tunnelProfileSha256, '303370e08438977baa25f0cd9e16c8cc4c75fddd5297de40f56c94d3b80cfaa3');
});

test('real Computer1 Windows PowerShell -Plan reads split target with fixture-only secrets and no host changes', {
  skip: process.platform !== 'win32' || process.env.ISSUE212_REAL_WINDOWS_PLAN !== '1',
}, () => {
  // Opt-in on the reviewed Relay host only. This is a temporary test copy,
  // never the Parent-materialized durable bootstrap or an installed task.
  assert.equal(os.hostname().toUpperCase(), 'DESKTOP-29JHFM4');
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue212-cold-plan-'));
  const temporaryScript = path.join(temporaryDir, 'windows-relay-host-bootstrap.ps1');
  const pathBinding = "$ExpectedBootstrapPath = '" + FIXED_RELAY_HOST.durableBootstrapPath + "'";
  assert.equal(BOOTSTRAP.split(pathBinding).length, 2);
  try {
    const normalizedBootstrap = BOOTSTRAP.replace(/\r\n/gu, '\n');
    // Adapt only the test copy's self-path guard; real hash/revision,
    // reference-only credentials, listener queries and -Plan logic all run.
    // The ephemeral fixture is not at the durable production path. Bind its
    // self-path check to the real script path (also safe with Windows 8.3 aliases).
    const secretReader = [
      "function Get-UserSecret([string]$Name) {",
      "  $value = [Environment]::GetEnvironmentVariable($Name, 'User')",
      '  if ([string]::IsNullOrWhiteSpace($value)) { throw "missing User-scope secret reference: $Name" }',
      '  return $value',
      '}',
    ].join('\n');
    const fixtureSecrets = [
      'function Get-UserSecret([string]$Name) {',
      "  if ($Name -eq 'ISSUE185_RELAY_AUTHORIZATION') { return 'Bearer fixture-only' }",
      "  return 'fixture-only'",
      '}',
    ].join('\n');
    // Never read live User-scope credential values from an unreviewed temporary
    // script. Only the G05-approved durable bootstrap may access those values.
    assert.equal(normalizedBootstrap.split(secretReader).length, 2);
    const listeners = 'return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)';
    assert.equal(normalizedBootstrap.split(listeners).length, 2);
    // Force a cold all-absent listener fixture; do not probe or mutate existing
    // Computer1 Relay/Tunnel processes, and keep real hash/HEAD fences intact.
    const fixture = normalizedBootstrap
      .replace(pathBinding, '$ExpectedBootstrapPath = (Resolve-Path -LiteralPath $PSCommandPath).Path')
      .replace(secretReader, fixtureSecrets)
      .replace(listeners, 'return @()');
    assert.doesNotMatch(fixture, /GetEnvironmentVariable\(\$Name, 'User'\)/u);
    fs.writeFileSync(temporaryScript, fixture, 'utf8');
    const outcome = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-File', temporaryScript, '-Plan',
    ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.status, 0, outcome.stderr);
    const plan = JSON.parse(outcome.stdout);
    assert.equal(plan.status, 'PLAN');
    assert.deepEqual(plan.actions, [
      'start-relay-runner',
      'start-secure-tunnel',
      'recover-stable-runtime',
      'private-relay-doctor',
    ]);
    assert.deepEqual(plan.relayPorts, [18745, 18746, 18747]);
    assert.equal(plan.tunnelPort, 18748);
    assert.equal(plan.stablePort, 18749);
    assert.equal(plan.runtimeSha, FIXED_RELAY_HOST.runtimeSha);
    assert.equal(plan.relayRepoSha, FIXED_RELAY_HOST.relayRepoSha);
    assert.equal(plan.stableSha, FIXED_RELAY_HOST.runtimeSha);
    assert.notEqual(plan.relayRepoSha, plan.runtimeSha);
    assert.deepEqual(plan.referenceSources, [
      'User:ISSUE185_RELAY_AUTHORIZATION',
      'User:LOCAL_RELAY_DEVICE_SECRET',
      'User:CONTROL_PLANE_API_KEY',
    ]);
    assert.equal(plan.mcpAuthContract, FIXED_RELAY_HOST.mcpHeaderReference);
    assert.doesNotMatch(outcome.stdout, /Bearer\s+\S{12,}/u);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});

test('split repository HEAD and serving revision remain independently fail-closed and do not drift security references', () => {
  assert.equal(FIXED_RELAY_HOST.relayRepoSha, '5c36a7aaebe0f51e012f8a27ab160c2bf9eebde9');
  assert.equal(FIXED_RELAY_HOST.runtimeSha, '628a2df906db9afcd8e80b7466f1667777e8cd69');
  assert.match(BOOTSTRAP, /\$head -ne \$RelayRepoSha/u);
  assert.match(BOOTSTRAP, /Assert-RelayRepoRevision/u);
  assert.match(BOOTSTRAP, /Assert-RecoveryRepoRevision/u);
  assert.match(BOOTSTRAP, /\$RecoveryRepoSha = 'f87f4665fa225e904f4edf0408181f52074e267e'/u);
  assert.match(BOOTSTRAP, /\$StableConfigSha256 = '8092b6443dcd6c3b4409ae078cf3c483dc99ac1232d7aae25f1e53634deea148'/u);
  assert.match(BOOTSTRAP, /\$DoctorSha256 = '2ad32ee6e91d9a9728452a3fb8ee1156c8a24d0f3d29eade58a117df69676f65'/u);
  for (const name of ['ISSUE185_RELAY_AUTHORIZATION', 'LOCAL_RELAY_DEVICE_SECRET', 'CONTROL_PLANE_API_KEY']) {
    assert.match(BOOTSTRAP, new RegExp("Get-UserSecret '" + name + "'", 'u'));
  }
  assert.match(BOOTSTRAP, /\$McpRef = \('Author' \+ 'ization: env:ISSUE185_RELAY_AUTHORIZATION'\)/u);
  assert.doesNotMatch(BOOTSTRAP, /SetEnvironmentVariable\([^)]*'User'/u);
  assert.deepEqual(planFixedRelayHostBootstrap(baseEvidence()).slice(-2).map(a => a.args.includes(FIXED_RELAY_HOST.runtimeSha)), [true, true]);
});


function extractBootstrapFunction(name) {
  const marker = 'function ' + name + '(';
  const start = BOOTSTRAP.indexOf(marker);
  assert.notEqual(start, -1, 'missing PowerShell function ' + name);
  const open = BOOTSTRAP.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < BOOTSTRAP.length; i += 1) {
    if (BOOTSTRAP[i] === '{') depth += 1;
    else if (BOOTSTRAP[i] === '}') {
      depth -= 1;
      if (depth === 0) return BOOTSTRAP.slice(start, i + 1);
    }
  }
  throw new Error('unterminated PowerShell function ' + name);
}

test('cold-logon stages retain bounded startup waits, exact process ownership, and sanitized status only', () => {
  for (const [name, token] of [
    ['Wait-ExactRelayStartup', 'Assert-RelayTopology'],
    ['Wait-ExactTunnelStartup', 'Assert-TunnelTopology'],
    ['Write-SafeCheckpoint', 'ConvertTo-Json'],
  ]) assert.match(extractBootstrapFunction(name), new RegExp(token, 'u'));
  assert.match(BOOTSTRAP, /Wait-ExactRelayStartup \$relayProcess\.Id/u);
  assert.match(BOOTSTRAP, /Wait-ExactTunnelStartup \$tunnelProcess\.Id/u);
  assert.doesNotMatch(BOOTSTRAP, /Start-Sleep -Milliseconds (?:750|1000)/u);
  assert.match(BOOTSTRAP, /if \(\$script:CheckpointArmed -and -not \$Plan\)/u);
  assert.match(BOOTSTRAP, /Write-SafeCheckpoint 'FAIL' \$script:FailurePhase/u);
  assert.match(BOOTSTRAP, /Write-SafeCheckpoint 'PASS' 'complete'/u);
  for (const phase of ['preflight', 'relay_start', 'relay_ready', 'tunnel_start', 'tunnel_ready', 'runtime_recovery', 'doctor', 'complete']) {
    assert.match(BOOTSTRAP, new RegExp("'" + phase + "'", 'u'));
  }
  assert.match(BOOTSTRAP, /last-result\.json/u);
  assert.doesNotMatch(extractBootstrapFunction('Write-SafeCheckpoint'), /relayRefValue|deviceRefValue|controlRefValue|Get-UserSecret|GetEnvironmentVariable|CommandLine|Exception|ErrorRecord/u);
});

test('real Windows isolated stage probes cover delayed owners, foreign owners, bounded timeout and sanitized failure checkpoint', {
  skip: process.platform !== 'win32' || process.env.ISSUE212_REAL_WINDOWS_PLAN !== '1',
}, () => {
  assert.equal(os.hostname().toUpperCase(), 'DESKTOP-29JHFM4');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'issue212-stages-'));
  const harness = path.join(folder, 'probe.ps1');
  const source = [
    'param([string]$Scenario)',
    "$ErrorActionPreference = 'Stop'",
    'Set-StrictMode -Version Latest',
    '$RelayPorts = @(18745,18746,18747)',
    '$TunnelPort = 18748',
    "$RuntimeSha = '628a2df906db9afcd8e80b7466f1667777e8cd69'",
    "$CheckpointPath = Join-Path (Split-Path -Parent $PSCommandPath) 'last-result.json'",
    "$relayRefValue = 'Bearer fixture-only'",
    '$script:Cycles = 0',
    '$script:Checks = 0',
    "function Get-Process { param([int]$Id,[string]$ErrorAction) if ($Scenario -eq 'relay_dead') { return $null }; return [pscustomobject]@{ Id = $Id } }",
    'function Get-ExactListenerPids([int]$Port) {',
    "  if ($Port -eq 18745 -or $Port -eq 18748) { $script:Cycles += 1 }",
    "  if ($Scenario -match 'foreign') { return @(9999) }",
    "  if ($Scenario -match 'timeout') { return @() }",
    "  if ($script:Cycles -eq 1) { return @() }",
    "  if ($Scenario -eq 'relay_delayed' -and $script:Cycles -eq 2 -and $Port -eq 18747) { return @() }",
    '  return @(4242)',
    '}',
    'function Assert-RelayTopology { return 4242 }',
    'function Assert-TunnelTopology { return 4242 }',
    'function Assert-RelayAccessReady([string]$Value) { $script:Checks += 1; if ($script:Checks -eq 1) { throw "not yet listening" } }',
    'function Assert-TunnelReady { $script:Checks += 1; if ($script:Checks -eq 1) { throw "not yet ready" } }',
    extractBootstrapFunction('Wait-ExactRelayStartup'),
    extractBootstrapFunction('Wait-ExactTunnelStartup'),
    extractBootstrapFunction('Write-SafeCheckpoint'),
    'if ($Scenario -eq "checkpoint") {',
    '  Write-SafeCheckpoint "FAIL" "tunnel_ready"',
    '  Get-Content -LiteralPath $CheckpointPath -Raw',
    '  exit 0',
    '}',
    'try {',
    '  if ($Scenario -match "^relay_") { $result = Wait-ExactRelayStartup 4242 620 }',
    '  else { $result = Wait-ExactTunnelStartup 4242 620 }',
    '  Write-Output ("RESULT=" + $result)',
    '  exit 0',
    '} catch {',
    '  Write-Output ("FAIL_CLOSED:" + $_.Exception.Message)',
    '  exit 5',
    '}',
  ].join('\n');
  fs.writeFileSync(harness, source, 'utf8');
  try {
    const run = (scenario) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', harness, scenario], {
      encoding: 'utf8', windowsHide: true, timeout: 20_000,
    });
    for (const scenario of ['relay_delayed', 'tunnel_delayed']) {
      const result = run(scenario);
      assert.equal(result.status, 0, scenario + ': ' + result.stderr + ' stdout=' + result.stdout);
      assert.match(result.stdout, /RESULT=4242/u);
    }
    for (const scenario of ['relay_foreign', 'tunnel_foreign', 'relay_timeout', 'tunnel_timeout', 'relay_dead']) {
      const result = run(scenario);
      assert.equal(result.status, 5, scenario + ': ' + result.stderr);
      assert.match(result.stdout, /FAIL_CLOSED/u);
      assert.doesNotMatch(result.stdout, /Bearer/u);
    }
    const record = run('checkpoint');
    assert.equal(record.status, 0, record.stderr);
    const json = JSON.parse(fs.readFileSync(path.join(folder, 'last-result.json'), 'utf8'));
    assert.equal(json.status, 'FAIL');
    assert.equal(json.phase, 'tunnel_ready');
    assert.equal(json.runtimeSha, FIXED_RELAY_HOST.runtimeSha);
    assert.deepEqual(Object.keys(json).sort(), ['at', 'phase', 'runtimeSha', 'schema', 'status']);
    assert.doesNotMatch(record.stdout, /Bearer|Authorization|CONTROL_PLANE|LOCAL_RELAY_DEVICE_SECRET/u);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
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
