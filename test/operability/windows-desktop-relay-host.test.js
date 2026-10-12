import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  DESKTOP_RELAY_BOOTSTRAP_MARKER,
  DESKTOP_RELAY_DURABLE_BOOTSTRAP_PATH,
  DESKTOP_RELAY_TASK_MARKER,
  DESKTOP_RELAY_TASK_NAME,
  applyDesktopRelayTask,
  buildDesktopRelayTaskSpec,
  desktopRelayTaskFingerprint,
  inspectDesktopRelayTaskXml,
  reconcileDesktopRelayTaskInstall,
  reconcileDesktopRelayTaskUninstall,
  removeDesktopRelayTask,
  renderDesktopRelayTaskXml,
  safeDesktopRelayTaskStatus,
  validateDesktopRelayBootstrap,
} from '../../src/operability/windows-desktop-relay-host.js';

const SID = 'S-1-5-21-111-222-333-1001';
const BOOTSTRAP = 'E:\\staging\\desktop-relay-host-bootstrap.ps1';
const ACTUAL_BOOTSTRAP = fs.readFileSync(
  new URL('../../scripts/windows-desktop-relay-host-bootstrap.ps1', import.meta.url),
  'utf8',
);

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function reviewedBootstrapBody() {
  return [
    '# ' + DESKTOP_RELAY_BOOTSTRAP_MARKER,
    '$RelayPorts = @(18745, 18746, 18747)',
    '$TunnelPort = 18748',
    "$TunnelProfile = 'issue-185-relay'",
    'function Wait-ExactRelayStartup([int]$ExpectedPid) { return $ExpectedPid }',
    'function Wait-ExactTunnelStartup([int]$ExpectedPid) { return $ExpectedPid }',
  ].join('\n');
}

function readOnlyFs(files) {
  return {
    readFileSync(filename, encoding) {
      const key = path.win32.normalize(filename);
      if (!Object.prototype.hasOwnProperty.call(files, key)) throw new Error('ENOENT');
      const value = Buffer.isBuffer(files[key]) ? files[key] : Buffer.from(String(files[key]));
      return encoding ? value.toString(encoding) : value;
    },
  };
}

function desiredXml(sha = 'a'.repeat(64)) {
  return renderDesktopRelayTaskXml(buildDesktopRelayTaskSpec({
    userSid: SID,
    bootstrapSha256: sha,
  }));
}

test('desktop Relay Task is distinct from Device B Task and is exact AtLogOn least-privilege secret-free metadata', () => {
  assert.equal(DESKTOP_RELAY_TASK_NAME, 'ChatGPT Codex Orchestrator - Desktop Relay Host');
  assert.notEqual(DESKTOP_RELAY_TASK_NAME, 'ChatGPT Codex Orchestrator - Local Connector Login Recovery');
  const xml = desiredXml();
  const parsed = inspectDesktopRelayTaskXml(xml);
  assert.equal(parsed.owned, true);
  assert.equal(parsed.trigger, 'AtLogOn');
  assert.equal(parsed.userSid, SID);
  assert.equal(parsed.principalUserSid, SID);
  assert.equal(parsed.logonType, 'InteractiveToken');
  assert.equal(parsed.runLevel, 'LeastPrivilege');
  assert.equal(parsed.multipleInstances, 'IgnoreNew');
  assert.equal(parsed.networkRequired, true);
  assert.equal(parsed.restartInterval, 'PT1M');
  assert.equal(parsed.restartCount, 5);
  assert.match(parsed.action.arguments, /desktop-relay-host-bootstrap\.ps1/u);
  assert.match(parsed.action.arguments, /Get-FileHash/u);
  assert.equal(parsed.action.workingDirectory, path.win32.dirname(DESKTOP_RELAY_DURABLE_BOOTSTRAP_PATH));
  assert.equal(parsed.sensitiveMetadataDetected, false);
  assert.doesNotMatch(xml, /ISSUE185_RELAY_AUTHORIZATION|LOCAL_RELAY_DEVICE_SECRET|CONTROL_PLANE_API_KEY|Bearer\s/u);
});

test('install/update/uninstall ownership fencing fails closed on same-name foreign Task', () => {
  const exact = desiredXml();
  assert.deepEqual(reconcileDesktopRelayTaskInstall({ existingXml: null, desiredXml: exact }), {
    action: 'create', reason: 'not_installed',
  });
  assert.deepEqual(reconcileDesktopRelayTaskInstall({ existingXml: exact, desiredXml: exact }), {
    action: 'unchanged', reason: 'exact_match',
  });

  const changed = desiredXml('b'.repeat(64));
  assert.deepEqual(reconcileDesktopRelayTaskInstall({ existingXml: exact, desiredXml: changed }), {
    action: 'update', reason: 'owned_task_drift',
  });

  const foreign = exact.replace(DESKTOP_RELAY_TASK_MARKER, 'foreign-owner');
  assert.throws(
    () => reconcileDesktopRelayTaskInstall({ existingXml: foreign, desiredXml: exact }),
    /foreign desktop Relay Scheduled Task/u,
  );
  assert.throws(
    () => reconcileDesktopRelayTaskUninstall({ existingXml: foreign }),
    /foreign desktop Relay Scheduled Task/u,
  );
  assert.deepEqual(reconcileDesktopRelayTaskUninstall({ existingXml: exact }), { action: 'delete' });
  assert.deepEqual(reconcileDesktopRelayTaskUninstall({ existingXml: null }), { action: 'absent' });
});

test('apply/remove invoke only the exact distinct Task name and status hashes arguments instead of echoing them', () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    return { code: 0, stdout: '', stderr: '', error: null };
  };
  const xml = desiredXml();
  const applied = applyDesktopRelayTask({ desiredXml: xml, existingXml: null, run });
  assert.equal(applied.status, 'CREATED');
  assert.equal(applied.taskName, DESKTOP_RELAY_TASK_NAME);
  assert.deepEqual(calls[0][1].slice(0, 3), ['/Create', '/TN', DESKTOP_RELAY_TASK_NAME]);

  const status = safeDesktopRelayTaskStatus(xml);
  assert.equal(status.status, 'INSTALLED');
  assert.match(status.actionArgumentsSha256, /^[a-f0-9]{64}$/u);
  assert.equal(Object.prototype.hasOwnProperty.call(status, 'actionArguments'), false);

  const removed = removeDesktopRelayTask({ existingXml: xml, run });
  assert.equal(removed.status, 'DELETED');
  assert.deepEqual(calls[1][1], ['/Delete', '/TN', DESKTOP_RELAY_TASK_NAME, '/F']);
});

test('task fingerprint is deterministic and changes when reviewed bootstrap hash changes', () => {
  const a = desiredXml('a'.repeat(64));
  const b = desiredXml('b'.repeat(64));
  assert.equal(desktopRelayTaskFingerprint(a), desktopRelayTaskFingerprint(a));
  assert.notEqual(desktopRelayTaskFingerprint(a), desktopRelayTaskFingerprint(b));
});

test('bootstrap validator requires exact reviewed bytes and rejects raw secrets or Stable Runtime lifecycle ownership', () => {
  const body = reviewedBootstrapBody();
  const fsImpl = readOnlyFs({ [path.win32.normalize(BOOTSTRAP)]: body });
  const good = validateDesktopRelayBootstrap({
    bootstrapPath: BOOTSTRAP,
    bootstrapSha256: hash(body),
    fsImpl,
  });
  assert.equal(good.bootstrapSha256, hash(body));

  assert.throws(() => validateDesktopRelayBootstrap({
    bootstrapPath: BOOTSTRAP,
    bootstrapSha256: '0'.repeat(64),
    fsImpl,
  }), /reviewed SHA-256/u);

  const raw = body + "\n$token = 'Bearer abcdefghijklmnopqrstuvwxyz'";
  assert.throws(() => validateDesktopRelayBootstrap({
    bootstrapPath: BOOTSTRAP,
    bootstrapSha256: hash(raw),
    fsImpl: readOnlyFs({ [path.win32.normalize(BOOTSTRAP)]: raw }),
  }), /raw sensitive/u);

  const runtimeOwner = body + '\nnode stable-runtime-recover.mjs';
  assert.throws(() => validateDesktopRelayBootstrap({
    bootstrapPath: BOOTSTRAP,
    bootstrapSha256: hash(runtimeOwner),
    fsImpl: readOnlyFs({ [path.win32.normalize(BOOTSTRAP)]: runtimeOwner }),
  }), /must not recover Device A\/B/u);
});

test('actual Computer2 bootstrap owns only Relay/Tunnel, hash-fences staged artifacts, and keeps dry-run credential-value-free', () => {
  assert.ok(ACTUAL_BOOTSTRAP.includes(DESKTOP_RELAY_BOOTSTRAP_MARKER));
  assert.match(ACTUAL_BOOTSTRAP, /\$RelayPorts = @\(18745, 18746, 18747\)/u);
  assert.match(ACTUAL_BOOTSTRAP, /\$TunnelPort = 18748/u);
  assert.match(ACTUAL_BOOTSTRAP, /excludedDeviceRuntimePort = 18749/u);
  assert.doesNotMatch(ACTUAL_BOOTSTRAP, /stable-runtime-recover\.mjs|private-relay-doctor\.mjs/u);
  assert.doesNotMatch(ACTUAL_BOOTSTRAP, /schtasks|Register-ScheduledTask|New-Service|sc\.exe/iu);
  assert.match(ACTUAL_BOOTSTRAP, /consistent Relay SQLite main database is not staged/u);
  assert.match(ACTUAL_BOOTSTRAP, /Wait-ExactRelayStartup/u);
  assert.match(ACTUAL_BOOTSTRAP, /Wait-ExactTunnelStartup/u);
  assert.match(ACTUAL_BOOTSTRAP, /15000/u);
  assert.match(ACTUAL_BOOTSTRAP, /ff64a79bc20bb7104a2536e5c205451f96b219d0b08e197211a720dfcb9e84e1/u);
  assert.match(ACTUAL_BOOTSTRAP, /fcc85a69ec0ad82518e4f8964f60c45e31787957782a0fc9c1b0c44e82d61b9b/u);
  assert.match(ACTUAL_BOOTSTRAP, /303370e08438977baa25f0cd9e16c8cc4c75fddd5297de40f56c94d3b80cfaa3/u);
  assert.match(ACTUAL_BOOTSTRAP, /GetEnvironmentVariable\(\$Name, 'User'\)/u);
  assert.doesNotMatch(ACTUAL_BOOTSTRAP, /SetEnvironmentVariable\([^)]*,\s*'User'\)/u);

  const planIndex = ACTUAL_BOOTSTRAP.indexOf('if ($Plan) {');
  const secretValueIndex = ACTUAL_BOOTSTRAP.indexOf("$relayRefValue = Get-UserRef");
  assert.ok(planIndex > 0 && secretValueIndex > planIndex, 'dry-run must exit before reading credential values');

  const writerStart = ACTUAL_BOOTSTRAP.indexOf('function Write-SafeCheckpoint');
  const writerEnd = ACTUAL_BOOTSTRAP.indexOf('\n}\n\ntrap', writerStart);
  const writer = ACTUAL_BOOTSTRAP.slice(writerStart, writerEnd);
  assert.doesNotMatch(writer, /relayRefValue|deviceRefValue|controlRefValue|Get-UserRef|GetEnvironmentVariable|Exception|CommandLine/u);
});
