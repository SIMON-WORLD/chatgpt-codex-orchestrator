import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const WINDOWS_LOGIN_TASK_NAME = 'ChatGPT Codex Orchestrator - Local Connector Login Recovery';
export const WINDOWS_LOGIN_TASK_MARKER = 'chatgpt-codex-orchestrator#212/windows-login-autostart/v1';

const KINDS = new Set(['stable-runtime', 'relay-host']);
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const SENSITIVE_KEY_RE = /(?:api[_-]?key|authorization|headers?|cookie|credential|password|secret|token|bearer)/iu;
const BEARER_LITERAL_RE = /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/iu;

function xmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function xmlUnescape(value) {
  return String(value ?? '')
    .replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<').replaceAll('&amp;', '&');
}

function textTag(xml, tag, occurrence = 0) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'giu');
  let match;
  let index = 0;
  while ((match = re.exec(xml))) {
    if (index++ === occurrence) return xmlUnescape(match[1].trim());
  }
  return null;
}

function normalizeWindowsPath(value) {
  return path.win32.normalize(String(value || '').trim());
}

function absoluteWindowsPath(value, label) {
  const normalized = normalizeWindowsPath(value);
  if (!normalized || !path.win32.isAbsolute(normalized)) throw new Error(label + ' must be an absolute Windows path');
  return normalized;
}

function canonicalRealpath(fsImpl, value, label) {
  const absolute = absoluteWindowsPath(value, label);
  let actual;
  try {
    actual = fsImpl.realpathSync.native ? fsImpl.realpathSync.native(absolute) : fsImpl.realpathSync(absolute);
  } catch {
    throw new Error(label + ' does not exist: ' + absolute);
  }
  return normalizeWindowsPath(actual).toLowerCase();
}

function sensitiveAssignment(text) {
  const re = /\b(api[_-]?key|authorization|headers?|cookie|credential|password|secret|token|bearer)[A-Za-z0-9_-]*\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;}]+)/giu;
  let match;
  while ((match = re.exec(String(text || '')))) {
    let rhs = String(match[2] || '').trim();
    if ((rhs.startsWith('"') && rhs.endsWith('"')) || (rhs.startsWith("'") && rhs.endsWith("'"))) rhs = rhs.slice(1, -1).trim();
    if (/^\$env:[A-Za-z_][A-Za-z0-9_]*$/u.test(rhs)) continue;
    if (/^env:[A-Za-z_][A-Za-z0-9_]*$/u.test(rhs)) continue;
    if (/GetEnvironmentVariable\s*\(/iu.test(rhs)) continue;
    return true;
  }
  return false;
}

function hasSensitiveLiteral(value) {
  const text = String(value || '');
  return BEARER_LITERAL_RE.test(text) || sensitiveAssignment(text);
}

function rawConfigSecret(value, parents = []) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = rawConfigSecret(value[i], [...parents, String(i)]);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key) && !/(?:Env|Environment)$/u.test(key)) {
      if (entry !== null && entry !== undefined && String(entry).length > 0) return [...parents, key].join('.');
    }
    const found = rawConfigSecret(entry, [...parents, key]);
    if (found) return found;
  }
  return null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function quoteWindowsArg(value) {
  const input = String(value);
  if (input && !/[\s"]/u.test(input)) return input;
  let output = '"';
  let slashes = 0;
  for (const char of input) {
    if (char === '\\') { slashes += 1; continue; }
    if (char === '"') {
      output += '\\'.repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    output += '\\'.repeat(slashes) + char;
    slashes = 0;
  }
  output += '\\'.repeat(slashes * 2) + '"';
  return output;
}

function argsString(values) {
  return values.map(quoteWindowsArg).join(' ');
}
export function validateStableRuntimeAutostartBinding({
  configPath, repoPath = null, launcherRepoRoot = null, fsImpl = fs,
} = {}) {
  const config = absoluteWindowsPath(configPath, 'configPath');
  let raw;
  try { raw = JSON.parse(fsImpl.readFileSync(config, 'utf8')); }
  catch { throw new Error('stable runtime config must exist and contain valid JSON'); }

  const secretPath = rawConfigSecret(raw);
  if (secretPath) throw new Error('stable runtime config contains forbidden raw sensitive field: ' + secretPath);

  const host = String(raw.host || '').trim().toLowerCase();
  const port = Number(raw.port);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('stable runtime host must remain loopback-bound');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('stable runtime port must remain explicit');
  if (raw.tunnel?.external !== true) throw new Error('autostart requires the accepted externally managed Secure Tunnel lifecycle');
  const mcpHost = host === '::1' ? '[::1]' : host;
  const expectedMcp = 'http://' + mcpHost + ':' + port + '/mcp';
  if (String(raw.tunnel?.localMcpUrl || '').replace(/\/+$/u, '') !== expectedMcp) {
    throw new Error('tunnel.localMcpUrl does not match the configured loopback Stable Runtime');
  }
  if (!String(raw.tunnel?.healthUrl || '').trim()) throw new Error('external tunnel healthUrl is required');

  if (raw.relayAgent?.enabled !== true) throw new Error('paired-device runtime must keep relayAgent enabled');
  if (!String(raw.relayAgent?.deviceId || '').trim()) throw new Error('relayAgent.deviceId is required');
  const credentialEnv = String(raw.relayAgent?.credentialEnv || '').trim();
  if (!ENV_NAME_RE.test(credentialEnv)) throw new Error('relayAgent.credentialEnv must remain an environment-variable reference');
  if (Object.prototype.hasOwnProperty.call(raw.relayAgent || {}, 'credential')) throw new Error('raw relayAgent credential is forbidden');

  const trusted = Array.isArray(raw.worktree?.trustedRepos) ? raw.worktree.trustedRepos.filter(Boolean) : [];
  let selected = repoPath ? absoluteWindowsPath(repoPath, 'repoPath') : null;
  if (!selected) {
    if (trusted.length !== 1) throw new Error('repoPath is required unless worktree.trustedRepos has exactly one entry');
    selected = absoluteWindowsPath(trusted[0], 'trusted repo');
  }
  const selectedCanonical = canonicalRealpath(fsImpl, selected, 'repoPath');
  const trustedCanonical = trusted.map((entry) => canonicalRealpath(fsImpl, entry, 'trusted repo'));
  if (!trustedCanonical.includes(selectedCanonical)) throw new Error('repoPath must resolve to an existing worktree.trustedRepos entry');
  if (launcherRepoRoot && canonicalRealpath(fsImpl, launcherRepoRoot, 'launcher repo') !== selectedCanonical) {
    throw new Error('autostart launcher repository must be the same exact trusted canonical repo');
  }

  return {
    configPath: config,
    repoPath: selected,
    port,
    deviceId: String(raw.relayAgent.deviceId).trim(),
    credentialEnv,
    tunnelHealthUrl: String(raw.tunnel.healthUrl),
  };
}

export function validateRelayHostBootstrap({ bootstrapPath, bootstrapSha256, fsImpl = fs } = {}) {
  const bootstrap = absoluteWindowsPath(bootstrapPath, 'bootstrapPath');
  if (path.win32.extname(bootstrap).toLowerCase() !== '.ps1') throw new Error('relay-host bootstrap must be one reviewed PowerShell .ps1 entrypoint');
  const expected = String(bootstrapSha256 || '').trim().toLowerCase();
  if (!SHA256_RE.test(expected)) throw new Error('bootstrapSha256 must be an exact 64-hex SHA-256');
  let bytes;
  try { bytes = fsImpl.readFileSync(bootstrap); }
  catch { throw new Error('relay-host bootstrap file does not exist'); }
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error('relay-host bootstrap bytes do not match the reviewed SHA-256');

  const text = bytes.toString('utf8');
  if (hasSensitiveLiteral(text)) throw new Error('relay-host bootstrap contains a raw sensitive value');
  if (!/(?:stable-runtime-recover\.mjs|recover:private-relay)/u.test(text)) {
    throw new Error('relay-host bootstrap must delegate Stable Runtime recovery to the accepted entrypoint');
  }
  if (!/(?:private-relay-doctor\.mjs|doctor:private-relay)/u.test(text)) {
    throw new Error('relay-host bootstrap must delegate final readiness diagnosis to the accepted doctor');
  }
  return { bootstrapPath: bootstrap, bootstrapSha256: actual };
}

export function buildLauncherAction({ nodePath, repoRoot, launchArgs }) {
  const node = absoluteWindowsPath(nodePath, 'nodePath');
  const root = absoluteWindowsPath(repoRoot, 'repoRoot');
  const launcher = path.win32.join(root, 'scripts', 'windows-login-autostart.mjs');
  return {
    command: node,
    arguments: argsString([launcher, ...launchArgs]),
    workingDirectory: root,
  };
}

export function buildWindowsLoginTaskSpec({ kind, userSid, action }) {
  if (!KINDS.has(kind)) throw new Error('unsupported autostart kind: ' + kind);
  const sid = String(userSid || '').trim();
  if (!/^S-1-(?:\d+-){1,14}\d+$/u.test(sid)) throw new Error('userSid must be one exact Windows user SID');
  const spec = {
    taskName: WINDOWS_LOGIN_TASK_NAME,
    description: WINDOWS_LOGIN_TASK_MARKER + ';kind=' + kind,
    kind,
    userSid: sid,
    trigger: 'AtLogOn',
    logonType: 'InteractiveToken',
    runLevel: 'LeastPrivilege',
    multipleInstances: 'IgnoreNew',
    networkRequired: true,
    restartOnFailure: { interval: 'PT1M', count: 5 },
    action,
  };
  const metadata = [spec.description, action.command, action.arguments, action.workingDirectory].join('\n');
  if (hasSensitiveLiteral(metadata)) throw new Error('Scheduled Task metadata must not contain raw credential/header/token/secret values');
  return spec;
}
export function renderWindowsLoginTaskXml(spec) {
  return '<?xml version="1.0" encoding="UTF-16"?>\n'
    + '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n'
    + '  <RegistrationInfo><Description>' + xmlEscape(spec.description) + '</Description></RegistrationInfo>\n'
    + '  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>' + xmlEscape(spec.userSid) + '</UserId></LogonTrigger></Triggers>\n'
    + '  <Principals><Principal id="Author"><UserId>' + xmlEscape(spec.userSid) + '</UserId><LogonType>'
    + xmlEscape(spec.logonType) + '</LogonType><RunLevel>' + xmlEscape(spec.runLevel) + '</RunLevel></Principal></Principals>\n'
    + '  <Settings><MultipleInstancesPolicy>' + xmlEscape(spec.multipleInstances) + '</MultipleInstancesPolicy>'
    + '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>'
    + '<StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>' + (spec.networkRequired ? 'true' : 'false')
    + '</RunOnlyIfNetworkAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><WakeToRun>false</WakeToRun>'
    + '<ExecutionTimeLimit>PT15M</ExecutionTimeLimit><RestartOnFailure><Interval>' + xmlEscape(spec.restartOnFailure.interval)
    + '</Interval><Count>' + spec.restartOnFailure.count + '</Count></RestartOnFailure></Settings>\n'
    + '  <Actions Context="Author"><Exec><Command>' + xmlEscape(spec.action.command) + '</Command><Arguments>'
    + xmlEscape(spec.action.arguments) + '</Arguments><WorkingDirectory>' + xmlEscape(spec.action.workingDirectory)
    + '</WorkingDirectory></Exec></Actions>\n</Task>\n';
}

export function inspectWindowsLoginTaskXml(xml) {
  const description = textTag(xml, 'Description') || '';
  const kind = /(?:^|;)kind=(stable-runtime|relay-host)(?:;|$)/u.exec(description)?.[1] || null;
  return {
    owned: description.startsWith(WINDOWS_LOGIN_TASK_MARKER),
    kind,
    trigger: /<LogonTrigger(?:\s[^>]*)?>/iu.test(xml) ? 'AtLogOn' : null,
    description,
    userSid: textTag(xml, 'UserId', 0),
    principalUserSid: textTag(xml, 'UserId', 1),
    logonType: textTag(xml, 'LogonType'),
    runLevel: textTag(xml, 'RunLevel'),
    multipleInstances: textTag(xml, 'MultipleInstancesPolicy'),
    networkRequired: textTag(xml, 'RunOnlyIfNetworkAvailable') === 'true',
    restartInterval: textTag(xml, 'Interval'),
    restartCount: Number(textTag(xml, 'Count')),
    action: {
      command: textTag(xml, 'Command') || '',
      arguments: textTag(xml, 'Arguments') || '',
      workingDirectory: textTag(xml, 'WorkingDirectory') || '',
    },
    sensitiveMetadataDetected: hasSensitiveLiteral([
      description, textTag(xml, 'Command'), textTag(xml, 'Arguments'), textTag(xml, 'WorkingDirectory'),
    ].join('\n')),
  };
}

export function canonicalTaskFingerprint(xml) {
  const task = inspectWindowsLoginTaskXml(xml);
  return sha256(Buffer.from(JSON.stringify({
    owned: task.owned, kind: task.kind, trigger: task.trigger,
    userSid: task.userSid, principalUserSid: task.principalUserSid,
    logonType: task.logonType, runLevel: task.runLevel,
    multipleInstances: task.multipleInstances, networkRequired: task.networkRequired,
    restartInterval: task.restartInterval, restartCount: task.restartCount,
    action: task.action,
  }), 'utf8'));
}

export function reconcileTaskInstall({ existingXml = null, desiredXml }) {
  if (!existingXml) return { action: 'create', reason: 'not_installed' };
  const existing = inspectWindowsLoginTaskXml(existingXml);
  if (!existing.owned) throw new Error('refusing to replace a same-name Scheduled Task not owned by Issue #212');
  if (existing.sensitiveMetadataDetected) throw new Error('existing project Scheduled Task contains sensitive-looking metadata; fail closed');
  if (canonicalTaskFingerprint(existingXml) === canonicalTaskFingerprint(desiredXml)) return { action: 'unchanged', reason: 'exact_match' };
  return { action: 'update', reason: 'owned_task_drift' };
}

export function reconcileTaskUninstall({ existingXml = null }) {
  if (!existingXml) return { action: 'absent' };
  const existing = inspectWindowsLoginTaskXml(existingXml);
  if (!existing.owned) throw new Error('refusing to remove a same-name Scheduled Task not owned by Issue #212');
  if (existing.sensitiveMetadataDetected) throw new Error('existing project Scheduled Task contains sensitive-looking metadata; fail closed');
  return { action: 'delete' };
}

export function safeTaskStatus(existingXml) {
  if (!existingXml) return { status: 'NOT_INSTALLED', taskName: WINDOWS_LOGIN_TASK_NAME };
  const task = inspectWindowsLoginTaskXml(existingXml);
  return {
    status: task.owned && !task.sensitiveMetadataDetected ? 'INSTALLED' : 'UNTRUSTED',
    taskName: WINDOWS_LOGIN_TASK_NAME,
    owned: task.owned,
    kind: task.kind,
    trigger: task.trigger,
    userSid: task.userSid,
    logonType: task.logonType,
    runLevel: task.runLevel,
    multipleInstances: task.multipleInstances,
    networkRequired: task.networkRequired,
    restartOnFailure: { interval: task.restartInterval, count: task.restartCount },
    actionCommand: path.win32.basename(task.action.command || ''),
    actionArgumentsSha256: sha256(Buffer.from(task.action.arguments || '', 'utf8')),
    sensitiveMetadataDetected: task.sensitiveMetadataDetected,
  };
}
export function defaultCommandRunner(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: options.inherit ? 'inherit' : 'pipe',
  });
  return {
    code: Number.isInteger(result.status) ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
}

export function currentWindowsUserSid({ run = defaultCommandRunner } = {}) {
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const result = run(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  ]);
  const sid = String(result.stdout || '').trim();
  if (result.code !== 0 || !/^S-1-(?:\d+-){1,14}\d+$/u.test(sid)) throw new Error('unable to resolve current Windows user SID');
  return sid;
}

export function queryWindowsLoginTask({ run = defaultCommandRunner } = {}) {
  const result = run('schtasks.exe', ['/Query', '/TN', WINDOWS_LOGIN_TASK_NAME, '/XML', 'ONE']);
  if (result.code === 0) return result.stdout;
  const combined = String(result.stdout || '') + '\n' + String(result.stderr || '');
  if (/cannot find|not exist|not found|系统找不到|找不到指定/iu.test(combined)) return null;
  throw new Error('unable to query the exact Windows login autostart task');
}

function temporaryTaskXml(xml, callback, fsImpl = fs) {
  const dir = fsImpl.mkdtempSync(path.join(os.tmpdir(), 'issue-212-task-'));
  const filename = path.join(dir, 'task.xml');
  try {
    fsImpl.writeFileSync(filename, '\ufeff' + xml, { encoding: 'utf16le', mode: 0o600 });
    return callback(filename);
  } finally {
    try { fsImpl.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

export function applyWindowsLoginTask({ desiredXml, existingXml, run = defaultCommandRunner, fsImpl = fs } = {}) {
  const decision = reconcileTaskInstall({ existingXml, desiredXml });
  if (decision.action === 'unchanged') return { status: 'UNCHANGED', taskName: WINDOWS_LOGIN_TASK_NAME };
  return temporaryTaskXml(desiredXml, (filename) => {
    const result = run('schtasks.exe', ['/Create', '/TN', WINDOWS_LOGIN_TASK_NAME, '/XML', filename, '/F']);
    if (result.code !== 0) throw new Error('Windows Scheduled Task create/update failed');
    return { status: decision.action === 'create' ? 'CREATED' : 'UPDATED', taskName: WINDOWS_LOGIN_TASK_NAME };
  }, fsImpl);
}

export function removeWindowsLoginTask({ existingXml, run = defaultCommandRunner } = {}) {
  const decision = reconcileTaskUninstall({ existingXml });
  if (decision.action === 'absent') return { status: 'ABSENT', taskName: WINDOWS_LOGIN_TASK_NAME };
  const result = run('schtasks.exe', ['/Delete', '/TN', WINDOWS_LOGIN_TASK_NAME, '/F']);
  if (result.code !== 0) throw new Error('Windows Scheduled Task delete failed');
  return { status: 'DELETED', taskName: WINDOWS_LOGIN_TASK_NAME };
}

export function launchStableRuntime({
  configPath, repoPath, launcherRepoRoot, nodePath = process.execPath, fsImpl = fs, run = defaultCommandRunner,
} = {}) {
  const binding = validateStableRuntimeAutostartBinding({ configPath, repoPath, launcherRepoRoot, fsImpl });
  const recovery = path.win32.join(absoluteWindowsPath(launcherRepoRoot, 'launcher repo'), 'host', 'stable-runtime-recover.mjs');
  const args = [recovery, '--config', binding.configPath, '--repo', binding.repoPath];
  const result = run(nodePath, args, { inherit: true });
  return { status: result.code === 0 ? 'PASS' : 'FAIL', code: result.code, delegatedTo: 'stable-runtime-recover.mjs' };
}

export function launchRelayHost({
  bootstrapPath, bootstrapSha256, fsImpl = fs, run = defaultCommandRunner,
} = {}) {
  const binding = validateRelayHostBootstrap({ bootstrapPath, bootstrapSha256, fsImpl });
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', binding.bootstrapPath];
  const result = run(powershell, args, { inherit: true });
  return { status: result.code === 0 ? 'PASS' : 'FAIL', code: result.code, delegatedTo: 'reviewed-relay-host-bootstrap.ps1' };
}
