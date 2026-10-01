import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import {
  WINDOWS_LOGIN_TASK_MARKER,
  applyWindowsLoginTask,
  buildLauncherAction,
  buildWindowsLoginTaskSpec,
  canonicalTaskFingerprint,
  inspectWindowsLoginTaskXml,
  launchRelayHost,
  launchStableRuntime,
  quoteWindowsArg,
  reconcileTaskInstall,
  reconcileTaskUninstall,
  renderWindowsLoginTaskXml,
  safeTaskStatus,
  validateRelayHostBootstrap,
  validateStableRuntimeAutostartBinding,
} from '../../src/operability/windows-login-autostart.js';

const SID = 'S-1-5-21-111-222-333-1001';
const REPO = 'E:\\Project\\chatgpt-codex-orchestrator';
const CONFIG = 'C:\\Users\\Simon\\AppData\\Local\\orchestrator\\stable.json';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';

function fakeFs(files = {}, realpaths = {}) {
  const readFileSync = (filename, encoding) => {
    const key = path.win32.normalize(filename);
    if (!Object.prototype.hasOwnProperty.call(files, key)) throw new Error('ENOENT');
    const value = files[key];
    if (encoding) return Buffer.isBuffer(value) ? value.toString(encoding) : String(value);
    return Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  };
  const realpathSync = (filename) => {
    const key = path.win32.normalize(filename);
    if (!Object.prototype.hasOwnProperty.call(realpaths, key)) throw new Error('ENOENT');
    return realpaths[key];
  };
  return { readFileSync, realpathSync };
}

function stableConfig(repo = REPO) {
  return {
    host: '127.0.0.1',
    port: 18749,
    worktree: { trustedRepos: [repo] },
    tunnel: {
      external: true,
      localMcpUrl: 'http://127.0.0.1:18749/mcp',
      healthUrl: 'http://127.0.0.1:18748/readyz',
    },
    relayAgent: {
      enabled: true,
      relayUrl: 'https://desktop-1.tail.example',
      deviceId: 'device-a2',
      credentialEnv: 'LOCAL_RELAY_DEVICE_SECRET',
    },
  };
}

function stableFs(config = stableConfig(), extraRealpaths = {}) {
  return fakeFs(
    { [CONFIG]: JSON.stringify(config) },
    { [REPO]: REPO, ...extraRealpaths },
  );
}

function stableTaskXml() {
  const action = buildLauncherAction({
    nodePath: NODE,
    repoRoot: REPO,
    launchArgs: ['launch-stable-runtime', '--config', CONFIG, '--repo', REPO],
  });
  return renderWindowsLoginTaskXml(buildWindowsLoginTaskSpec({
    kind: 'stable-runtime', userSid: SID, action,
  }));
}

function relayBootstrapBody() {
  return [
    '$ErrorActionPreference = "Stop"',
    '$env:MCP_EXTRA_HEADERS = [Environment]::GetEnvironmentVariable("MCP_EXTRA_HEADERS", "User")',
    '& node E:\\Project\\chatgpt-codex-orchestrator\\host\\stable-runtime-recover.mjs --config $env:STABLE_RUNTIME_CONFIG',
    '& node E:\\Project\\chatgpt-codex-orchestrator\\scripts\\private-relay-doctor.mjs --config $env:STABLE_RUNTIME_CONFIG',
  ].join('\n');
}

test('Windows argument quoting is deterministic', () => {
  assert.equal(quoteWindowsArg('plain'), 'plain');
  assert.equal(quoteWindowsArg('C:\\Program Files\\node.exe'), '"C:\\Program Files\\node.exe"');
  assert.equal(quoteWindowsArg('a"b'), '"a\\"b"');
  assert.equal(quoteWindowsArg('C:\\path with space\\'), '"C:\\path with space\\\\"');
});
test('task is current-user AtLogOn, least-privilege, IgnoreNew, bounded retry, and secret-free', () => {
  const parsed = inspectWindowsLoginTaskXml(stableTaskXml());
  assert.equal(parsed.owned, true);
  assert.equal(parsed.kind, 'stable-runtime');
  assert.equal(parsed.trigger, 'AtLogOn');
  assert.equal(parsed.userSid, SID);
  assert.equal(parsed.principalUserSid, SID);
  assert.equal(parsed.logonType, 'InteractiveToken');
  assert.equal(parsed.runLevel, 'LeastPrivilege');
  assert.equal(parsed.multipleInstances, 'IgnoreNew');
  assert.equal(parsed.networkRequired, true);
  assert.equal(parsed.restartInterval, 'PT1M');
  assert.equal(parsed.restartCount, 5);
  assert.match(parsed.action.arguments, /windows-login-autostart\.mjs/u);
  assert.match(parsed.action.arguments, /launch-stable-runtime/u);
  assert.equal(parsed.sensitiveMetadataDetected, false);
  assert.doesNotMatch(stableTaskXml(), /MCP_EXTRA_HEADERS|MCP_DISCOVERY_EXTRA_HEADERS|LOCAL_RELAY_DEVICE_SECRET/u);
});

test('Stable Runtime binding preserves exact topology, repo, deviceId, and env credential reference', () => {
  const binding = validateStableRuntimeAutostartBinding({
    configPath: CONFIG,
    repoPath: REPO,
    launcherRepoRoot: REPO,
    fsImpl: stableFs(),
  });
  assert.equal(binding.port, 18749);
  assert.equal(binding.repoPath, REPO);
  assert.equal(binding.deviceId, 'device-a2');
  assert.equal(binding.credentialEnv, 'LOCAL_RELAY_DEVICE_SECRET');
  assert.equal(binding.tunnelHealthUrl, 'http://127.0.0.1:18748/readyz');
});

test('Stable Runtime binding fails closed on profile/port/repo/device credential drift', () => {
  const mutators = [
    (c) => { c.host = '0.0.0.0'; },
    (c) => { c.port = null; },
    (c) => { c.tunnel.external = false; },
    (c) => { c.tunnel.localMcpUrl = 'http://127.0.0.1:19999/mcp'; },
    (c) => { c.relayAgent.enabled = false; },
    (c) => { c.relayAgent.deviceId = ''; },
    (c) => { c.relayAgent.credential = 'raw-secret'; },
  ];
  for (const mutate of mutators) {
    const config = stableConfig();
    mutate(config);
    assert.throws(() => validateStableRuntimeAutostartBinding({
      configPath: CONFIG, repoPath: REPO, launcherRepoRoot: REPO, fsImpl: stableFs(config),
    }));
  }

  const other = 'E:\\Other\\repo';
  assert.throws(() => validateStableRuntimeAutostartBinding({
    configPath: CONFIG,
    repoPath: other,
    launcherRepoRoot: other,
    fsImpl: stableFs(stableConfig(), { [other]: other }),
  }), /trustedRepos/u);
  assert.throws(() => validateStableRuntimeAutostartBinding({
    configPath: CONFIG,
    repoPath: REPO,
    launcherRepoRoot: other,
    fsImpl: stableFs(stableConfig(), { [other]: other }),
  }), /same exact trusted canonical repo/u);
});

test('Relay-host bootstrap is exact-hash pinned, secret-free, env-reference compatible, recovery+doctor delegated', () => {
  const bootstrap = 'C:\\Users\\Simon\\orchestrator-host\\recover-private-relay.ps1';
  const body = relayBootstrapBody();
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  const binding = validateRelayHostBootstrap({
    bootstrapPath: bootstrap,
    bootstrapSha256: hash,
    fsImpl: fakeFs({ [bootstrap]: body }),
  });
  assert.equal(binding.bootstrapSha256, hash);
});

test('Relay-host bootstrap rejects changed bytes, raw secrets, and missing canonical doctor', () => {
  const bootstrap = 'C:\\host\\recover.ps1';
  const good = relayBootstrapBody();
  assert.throws(() => validateRelayHostBootstrap({
    bootstrapPath: bootstrap,
    bootstrapSha256: '0'.repeat(64),
    fsImpl: fakeFs({ [bootstrap]: good }),
  }), /reviewed SHA-256/u);

  const sensitive = good + '\n$env:Authorization = "Bearer abcdefghijklmnop"\n';
  const sensitiveHash = crypto.createHash('sha256').update(sensitive).digest('hex');
  assert.throws(() => validateRelayHostBootstrap({
    bootstrapPath: bootstrap,
    bootstrapSha256: sensitiveHash,
    fsImpl: fakeFs({ [bootstrap]: sensitive }),
  }), /sensitive/u);

  const incomplete = 'node host/stable-runtime-recover.mjs\n';
  const incompleteHash = crypto.createHash('sha256').update(incomplete).digest('hex');
  assert.throws(() => validateRelayHostBootstrap({
    bootstrapPath: bootstrap,
    bootstrapSha256: incompleteHash,
    fsImpl: fakeFs({ [bootstrap]: incomplete }),
  }), /readiness diagnosis/u);
});
test('simulated device login delegates to the accepted Stable Runtime recovery command', () => {
  const calls = [];
  const result = launchStableRuntime({
    configPath: CONFIG,
    repoPath: REPO,
    launcherRepoRoot: REPO,
    nodePath: NODE,
    fsImpl: stableFs(),
    run(command, args) {
      calls.push({ command, args });
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.delegatedTo, 'stable-runtime-recover.mjs');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, NODE);
  assert.equal(calls[0].args[0], path.win32.join(REPO, 'host', 'stable-runtime-recover.mjs'));
  assert.deepEqual(calls[0].args.slice(1), ['--config', CONFIG, '--repo', REPO]);
});

test('simulated Relay-host login revalidates bootstrap bytes then delegates existing recovery+doctor bootstrap', () => {
  const bootstrap = 'C:\\host\\recover.ps1';
  const body = relayBootstrapBody();
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  const calls = [];
  const result = launchRelayHost({
    bootstrapPath: bootstrap,
    bootstrapSha256: hash,
    fsImpl: fakeFs({ [bootstrap]: body }),
    run(command, args) {
      calls.push({ command, args });
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.delegatedTo, 'reviewed-relay-host-bootstrap.ps1');
  assert.equal(calls.length, 1);
  assert.match(calls[0].command, /WindowsPowerShell\\v1\.0\\powershell\.exe$/u);
  assert.deepEqual(calls[0].args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', bootstrap]);
});

test('install/update reconciliation is deterministic, idempotent, and foreign collision fails closed', () => {
  const desired = stableTaskXml();
  assert.deepEqual(reconcileTaskInstall({ desiredXml: desired }), { action: 'create', reason: 'not_installed' });
  assert.deepEqual(reconcileTaskInstall({ existingXml: desired, desiredXml: desired }), { action: 'unchanged', reason: 'exact_match' });
  const drift = desired.replace('PT1M', 'PT2M');
  assert.deepEqual(reconcileTaskInstall({ existingXml: drift, desiredXml: desired }), { action: 'update', reason: 'owned_task_drift' });
  assert.notEqual(canonicalTaskFingerprint(drift), canonicalTaskFingerprint(desired));
  const foreign = desired.replace(WINDOWS_LOGIN_TASK_MARKER, 'foreign-owner');
  assert.throws(() => reconcileTaskInstall({ existingXml: foreign, desiredXml: desired }), /not owned/u);
});

test('apply emits one exact schtasks create/update and leaves exact-match task unchanged', () => {
  const desired = stableTaskXml();
  const calls = [];
  const fsImpl = {
    mkdtempSync() { return 'C:\\Temp\\issue212'; },
    writeFileSync(filename, content, options) {
      assert.match(filename, /task\.xml$/u);
      assert.equal(options.encoding, 'utf16le');
      assert.equal(content.charCodeAt(0), 0xfeff);
    },
    rmSync() {},
  };
  const run = (command, args) => {
    calls.push({ command, args });
    return { code: 0, stdout: '', stderr: '' };
  };
  assert.equal(applyWindowsLoginTask({ desiredXml: desired, existingXml: null, run, fsImpl }).status, 'CREATED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'schtasks.exe');
  assert.deepEqual(calls[0].args.slice(0, 3), ['/Create', '/TN', 'ChatGPT Codex Orchestrator - Local Connector Login Recovery']);
  calls.length = 0;
  assert.equal(applyWindowsLoginTask({ desiredXml: desired, existingXml: desired, run, fsImpl }).status, 'UNCHANGED');
  assert.equal(calls.length, 0);
});
test('status redacts action arguments and uninstall is exact-owner bounded', () => {
  const xml = stableTaskXml();
  assert.deepEqual(reconcileTaskUninstall({ existingXml: null }), { action: 'absent' });
  assert.deepEqual(reconcileTaskUninstall({ existingXml: xml }), { action: 'delete' });
  const status = safeTaskStatus(xml);
  assert.equal(status.status, 'INSTALLED');
  assert.equal(status.actionCommand, 'node.exe');
  assert.match(status.actionArgumentsSha256, /^[0-9a-f]{64}$/u);
  assert.equal(Object.prototype.hasOwnProperty.call(status, 'arguments'), false);
  const foreign = xml.replace(WINDOWS_LOGIN_TASK_MARKER, 'foreign-owner');
  assert.throws(() => reconcileTaskUninstall({ existingXml: foreign }), /not owned/u);
});

test('tampered owned task with raw secret-looking metadata is untrusted and cannot be updated or removed', () => {
  const desired = stableTaskXml();
  const tampered = desired.replace('</Arguments>', ' --token=super-secret-value</Arguments>');
  assert.equal(inspectWindowsLoginTaskXml(tampered).sensitiveMetadataDetected, true);
  assert.equal(safeTaskStatus(tampered).status, 'UNTRUSTED');
  assert.throws(() => reconcileTaskInstall({ existingXml: tampered, desiredXml: desired }), /sensitive-looking/u);
  assert.throws(() => reconcileTaskUninstall({ existingXml: tampered }), /sensitive-looking/u);
});
