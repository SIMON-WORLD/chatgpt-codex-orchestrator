import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  currentWindowsUserSid,
  defaultCommandRunner,
  quoteWindowsArg,
} from './windows-login-autostart.js';

export const DESKTOP_RELAY_TASK_NAME = 'ChatGPT Codex Orchestrator - Desktop Relay Host';
export const DESKTOP_RELAY_TASK_MARKER = 'chatgpt-codex-orchestrator#222/desktop-relay-host/v1';
export const DESKTOP_RELAY_BOOTSTRAP_MARKER = 'chatgpt-codex-orchestrator#222/desktop-relay-host-bootstrap/v1';
export const DESKTOP_RELAY_RUNTIME_ROOT = 'E:\\Project\\chatgpt-codex-orchestrator\\issue-222-relay-runtime';
export const DESKTOP_RELAY_DURABLE_BOOTSTRAP_PATH =
  DESKTOP_RELAY_RUNTIME_ROOT + '\\windows-login\\desktop-relay-host-bootstrap.ps1';

const SHA256_RE = /^[0-9a-f]{64}$/u;
const SID_RE = /^S-1-(?:\d+-){1,14}\d+$/u;
const BEARER_LITERAL_RE = /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/iu;
const SENSITIVE_ASSIGNMENT_RE =
  /\b(?:api[_-]?key|authorization|cookie|credential|password|secret|token|bearer)\w*\b\s*[:=]\s*(?!\$env:|env:|GetEnvironmentVariable)/iu;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

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

function absoluteWindowsPath(value, label) {
  const normalized = path.win32.normalize(String(value || '').trim());
  if (!normalized || !path.win32.isAbsolute(normalized)) throw new Error(label + ' must be an absolute Windows path');
  return normalized;
}

function containsSensitiveLiteral(value) {
  const text = String(value || '');
  return BEARER_LITERAL_RE.test(text) || SENSITIVE_ASSIGNMENT_RE.test(text);
}

function argsString(values) {
  return values.map(quoteWindowsArg).join(' ');
}

export function validateDesktopRelayBootstrap({
  bootstrapPath,
  bootstrapSha256,
  fsImpl = fs,
} = {}) {
  const bootstrap = absoluteWindowsPath(bootstrapPath, 'bootstrapPath');
  if (path.win32.extname(bootstrap).toLowerCase() !== '.ps1') {
    throw new Error('desktop Relay bootstrap must be one reviewed PowerShell .ps1 file');
  }
  const expected = String(bootstrapSha256 || '').trim().toLowerCase();
  if (!SHA256_RE.test(expected)) throw new Error('bootstrapSha256 must be an exact 64-hex SHA-256');

  let bytes;
  try { bytes = fsImpl.readFileSync(bootstrap); }
  catch { throw new Error('desktop Relay bootstrap file does not exist'); }

  const actual = sha256(bytes);
  if (actual !== expected) throw new Error('desktop Relay bootstrap bytes do not match reviewed SHA-256');
  const text = bytes.toString('utf8');
  if (!text.includes(DESKTOP_RELAY_BOOTSTRAP_MARKER)) throw new Error('desktop Relay bootstrap ownership marker missing');
  if (containsSensitiveLiteral(text)) throw new Error('desktop Relay bootstrap contains a raw sensitive value');
  if (!text.includes('$RelayPorts = @(18745, 18746, 18747)') || !text.includes('$TunnelPort = 18748')) {
    throw new Error('desktop Relay bootstrap must own only Relay/Tunnel ports 18745-18748');
  }
  if (!text.includes("issue-185-relay")) throw new Error('desktop Relay bootstrap tunnel profile binding missing');
  if (!text.includes("$TailscaleExe = 'C:\\Program Files\\Tailscale\\tailscale.exe'")
      || !text.includes("$TailscaleServeHost = 'desktop-2.tail4d2a66.ts.net:443'")
      || !text.includes("$TailscaleServeTarget = 'http://127.0.0.1:18747'")
      || !text.includes('Ensure-ExactTailscaleServe')
      || !text.includes('serve status --json')) {
    throw new Error('desktop Relay bootstrap exact Tailscale Serve recovery binding missing');
  }
  if (/tailscale(?:\.exe)?\s+(?:serve\s+)?(?:reset|clear)|tailscale(?:\.exe)?\s+funnel/iu.test(text)) {
    throw new Error('desktop Relay bootstrap must not reset, clear, or funnel Tailscale routing');
  }
  if (/(?:stable-runtime-recover\.mjs|private-relay-doctor\.mjs)/u.test(text)) {
    throw new Error('desktop Relay bootstrap must not recover Device A/B Stable Runtime');
  }
  if (/(?:schtasks(?:\.exe)?|Register-ScheduledTask|New-Service|sc\.exe)/iu.test(text)) {
    throw new Error('desktop Relay bootstrap must not own Task/service installation');
  }
  return { bootstrapPath: bootstrap, bootstrapSha256: actual };
}

export function buildDesktopRelayTaskAction({
  bootstrapPath = DESKTOP_RELAY_DURABLE_BOOTSTRAP_PATH,
  bootstrapSha256,
} = {}) {
  const bootstrap = absoluteWindowsPath(bootstrapPath, 'bootstrapPath');
  const expected = String(bootstrapSha256 || '').trim().toLowerCase();
  if (!SHA256_RE.test(expected)) throw new Error('bootstrapSha256 must be an exact 64-hex SHA-256');
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const command = [
    "$p='" + bootstrap.replaceAll("'", "''") + "'",
    '$h=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()',
    "if ($h -ne '" + expected + "') { throw 'desktop Relay bootstrap hash drift' }",
    '& $p',
  ].join('; ');
  return {
    command: powershell,
    arguments: argsString(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]),
    workingDirectory: path.win32.dirname(bootstrap),
  };
}

export function buildDesktopRelayTaskSpec({ userSid, bootstrapSha256 } = {}) {
  const sid = String(userSid || '').trim();
  if (!SID_RE.test(sid)) throw new Error('userSid must be one exact Windows user SID');
  const action = buildDesktopRelayTaskAction({ bootstrapSha256 });
  const spec = {
    taskName: DESKTOP_RELAY_TASK_NAME,
    description: DESKTOP_RELAY_TASK_MARKER,
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
  if (containsSensitiveLiteral(metadata)) throw new Error('Scheduled Task metadata contains a raw sensitive value');
  return spec;
}

export function renderDesktopRelayTaskXml(spec) {
  return '<?xml version="1.0" encoding="UTF-16"?>\n'
    + '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n'
    + '  <RegistrationInfo><Description>' + xmlEscape(spec.description) + '</Description></RegistrationInfo>\n'
    + '  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>' + xmlEscape(spec.userSid)
    + '</UserId></LogonTrigger></Triggers>\n'
    + '  <Principals><Principal id="Author"><UserId>' + xmlEscape(spec.userSid) + '</UserId><LogonType>'
    + xmlEscape(spec.logonType) + '</LogonType><RunLevel>' + xmlEscape(spec.runLevel)
    + '</RunLevel></Principal></Principals>\n'
    + '  <Settings><MultipleInstancesPolicy>' + xmlEscape(spec.multipleInstances)
    + '</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>'
    + '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable>'
    + '<RunOnlyIfNetworkAvailable>' + (spec.networkRequired ? 'true' : 'false')
    + '</RunOnlyIfNetworkAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled>'
    + '<WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT15M</ExecutionTimeLimit>'
    + '<RestartOnFailure><Interval>' + xmlEscape(spec.restartOnFailure.interval)
    + '</Interval><Count>' + spec.restartOnFailure.count + '</Count></RestartOnFailure></Settings>\n'
    + '  <Actions Context="Author"><Exec><Command>' + xmlEscape(spec.action.command)
    + '</Command><Arguments>' + xmlEscape(spec.action.arguments)
    + '</Arguments><WorkingDirectory>' + xmlEscape(spec.action.workingDirectory)
    + '</WorkingDirectory></Exec></Actions>\n</Task>\n';
}

export function inspectDesktopRelayTaskXml(xml) {
  const description = textTag(xml, 'Description') || '';
  const metadata = [
    description,
    textTag(xml, 'Command') || '',
    textTag(xml, 'Arguments') || '',
    textTag(xml, 'WorkingDirectory') || '',
  ].join('\n');
  return {
    owned: description === DESKTOP_RELAY_TASK_MARKER,
    trigger: /<LogonTrigger(?:\s[^>]*)?>/iu.test(xml) ? 'AtLogOn' : null,
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
    sensitiveMetadataDetected: containsSensitiveLiteral(metadata),
  };
}

export function desktopRelayTaskFingerprint(xml) {
  const task = inspectDesktopRelayTaskXml(xml);
  return sha256(Buffer.from(JSON.stringify({
    owned: task.owned,
    trigger: task.trigger,
    userSid: task.userSid,
    principalUserSid: task.principalUserSid,
    logonType: task.logonType,
    runLevel: task.runLevel,
    multipleInstances: task.multipleInstances,
    networkRequired: task.networkRequired,
    restartInterval: task.restartInterval,
    restartCount: task.restartCount,
    action: task.action,
  }), 'utf8'));
}

export function reconcileDesktopRelayTaskInstall({ existingXml = null, desiredXml }) {
  if (!existingXml) return { action: 'create', reason: 'not_installed' };
  const existing = inspectDesktopRelayTaskXml(existingXml);
  if (!existing.owned) throw new Error('refusing to replace same-name foreign desktop Relay Scheduled Task');
  if (existing.sensitiveMetadataDetected) throw new Error('existing desktop Relay Task contains sensitive-looking metadata');
  if (desktopRelayTaskFingerprint(existingXml) === desktopRelayTaskFingerprint(desiredXml)) {
    return { action: 'unchanged', reason: 'exact_match' };
  }
  return { action: 'update', reason: 'owned_task_drift' };
}

export function reconcileDesktopRelayTaskUninstall({ existingXml = null } = {}) {
  if (!existingXml) return { action: 'absent' };
  const existing = inspectDesktopRelayTaskXml(existingXml);
  if (!existing.owned) throw new Error('refusing to remove same-name foreign desktop Relay Scheduled Task');
  if (existing.sensitiveMetadataDetected) throw new Error('existing desktop Relay Task contains sensitive-looking metadata');
  return { action: 'delete' };
}

export function safeDesktopRelayTaskStatus(existingXml) {
  if (!existingXml) return { status: 'NOT_INSTALLED', taskName: DESKTOP_RELAY_TASK_NAME };
  const task = inspectDesktopRelayTaskXml(existingXml);
  return {
    status: task.owned && !task.sensitiveMetadataDetected ? 'INSTALLED' : 'UNTRUSTED',
    taskName: DESKTOP_RELAY_TASK_NAME,
    owned: task.owned,
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

export function materializeDesktopRelayBootstrap({
  sourcePath,
  sourceSha256,
  destinationPath = DESKTOP_RELAY_DURABLE_BOOTSTRAP_PATH,
  fsImpl = fs,
} = {}) {
  const source = validateDesktopRelayBootstrap({
    bootstrapPath: sourcePath,
    bootstrapSha256: sourceSha256,
    fsImpl,
  });
  const destination = absoluteWindowsPath(destinationPath, 'destinationPath');
  let existing = null;
  try { existing = fsImpl.readFileSync(destination); } catch {}
  if (existing) {
    const text = existing.toString('utf8');
    if (!text.includes(DESKTOP_RELAY_BOOTSTRAP_MARKER)) {
      throw new Error('refusing to replace foreign durable desktop Relay bootstrap');
    }
    if (sha256(existing) === source.bootstrapSha256) {
      return { status: 'UNCHANGED', bootstrapPath: destination, bootstrapSha256: source.bootstrapSha256 };
    }
  }
  fsImpl.mkdirSync(path.win32.dirname(destination), { recursive: true });
  const bytes = fsImpl.readFileSync(source.bootstrapPath);
  fsImpl.writeFileSync(destination, bytes);
  const actual = sha256(fsImpl.readFileSync(destination));
  if (actual !== source.bootstrapSha256) throw new Error('durable desktop Relay bootstrap hash verification failed');
  return {
    status: existing ? 'UPDATED' : 'CREATED',
    bootstrapPath: destination,
    bootstrapSha256: actual,
  };
}

export function queryDesktopRelayTask({ run = defaultCommandRunner } = {}) {
  const result = run('schtasks.exe', ['/Query', '/TN', DESKTOP_RELAY_TASK_NAME, '/XML', 'ONE'], {
    captureNativeStderr: true,
  });
  if (result.error) throw new Error('unable to query exact desktop Relay Scheduled Task');
  if (result.code === 0) return result.stdout;
  const combined = String(result.stdout || '') + '\n' + String(result.stderr || '');
  const native = Buffer.isBuffer(result.nativeStderr) ? new TextDecoder('gbk').decode(result.nativeStderr) : '';
  if (/cannot find|not exist|not found|系统找不到|找不到指定/iu.test(combined + '\n' + native)) return null;
  throw new Error('unable to query exact desktop Relay Scheduled Task');
}

function temporaryTaskXml(xml, callback, fsImpl = fs) {
  const dir = fsImpl.mkdtempSync(path.join(os.tmpdir(), 'issue-222-desktop-relay-task-'));
  const filename = path.join(dir, 'task.xml');
  try {
    fsImpl.writeFileSync(filename, '\ufeff' + xml, { encoding: 'utf16le', mode: 0o600 });
    return callback(filename);
  } finally {
    try { fsImpl.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

export function applyDesktopRelayTask({
  desiredXml,
  existingXml,
  run = defaultCommandRunner,
  fsImpl = fs,
} = {}) {
  const decision = reconcileDesktopRelayTaskInstall({ existingXml, desiredXml });
  if (decision.action === 'unchanged') return { status: 'UNCHANGED', taskName: DESKTOP_RELAY_TASK_NAME };
  return temporaryTaskXml(desiredXml, (filename) => {
    const result = run('schtasks.exe', ['/Create', '/TN', DESKTOP_RELAY_TASK_NAME, '/XML', filename, '/F']);
    if (result.code !== 0) throw new Error('desktop Relay Scheduled Task create/update failed');
    return {
      status: decision.action === 'create' ? 'CREATED' : 'UPDATED',
      taskName: DESKTOP_RELAY_TASK_NAME,
    };
  }, fsImpl);
}

export function removeDesktopRelayTask({ existingXml, run = defaultCommandRunner } = {}) {
  const decision = reconcileDesktopRelayTaskUninstall({ existingXml });
  if (decision.action === 'absent') return { status: 'ABSENT', taskName: DESKTOP_RELAY_TASK_NAME };
  const result = run('schtasks.exe', ['/Delete', '/TN', DESKTOP_RELAY_TASK_NAME, '/F']);
  if (result.code !== 0) throw new Error('desktop Relay Scheduled Task delete failed');
  return { status: 'DELETED', taskName: DESKTOP_RELAY_TASK_NAME };
}

export { currentWindowsUserSid };
