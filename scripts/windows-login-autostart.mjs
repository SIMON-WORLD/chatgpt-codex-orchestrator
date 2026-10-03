#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WINDOWS_LOGIN_TASK_NAME,
  applyWindowsLoginTask,
  buildLauncherAction,
  buildWindowsLoginTaskSpec,
  canonicalTaskFingerprint,
  currentWindowsUserSid,
  launchRelayHost,
  launchStableRuntime,
  queryWindowsLoginTask,
  removeWindowsLoginTask,
  renderWindowsLoginTaskXml,
  safeTaskStatus,
  validateRelayHostBootstrap,
  validateStableRuntimeAutostartBinding,
} from '../src/operability/windows-login-autostart.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXACT_SHA_RE = /^[0-9a-f]{40}$/u;

function usage() {
  return [
    'Windows per-user login autostart for the existing Local Connector stack',
    '',
    'Usage:',
    '  node scripts/windows-login-autostart.mjs plan|install --kind stable-runtime --config <absolute-config.json> [--repo <absolute-trusted-repo>] [--sha <exact-40-hex>]',
    '  node scripts/windows-login-autostart.mjs plan|install --kind relay-host --bootstrap <absolute-reviewed-bootstrap.ps1> --bootstrap-sha256 <64-hex>',
    '  node scripts/windows-login-autostart.mjs status',
    '  node scripts/windows-login-autostart.mjs uninstall',
  ].join('\n');
}

function parse(argv) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') return { help: true };
  const allowed = new Set(['plan', 'install', 'status', 'uninstall', 'launch-stable-runtime', 'launch-relay-host']);
  if (!allowed.has(command)) throw new Error('unsupported command: ' + command);
  const args = { command };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--kind') args.kind = argv[++i];
    else if (arg === '--config') args.configPath = argv[++i];
    else if (arg === '--repo') args.repoPath = argv[++i];
    else if (arg === '--sha') args.targetSha = argv[++i];
    else if (arg === '--binding-sha256') args.bindingSha256 = argv[++i];
    else if (arg === '--bootstrap') args.bootstrapPath = argv[++i];
    else if (arg === '--bootstrap-sha256') args.bootstrapSha256 = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error('unknown argument: ' + arg);
  }
  return args;
}

function requireWindows(command) {
  if (process.platform !== 'win32' && command !== 'plan') throw new Error(command + ' is supported only on Windows');
}

function desiredSpec(args, userSid) {
  if (args.kind === 'stable-runtime') {
    if (!args.configPath) throw new Error('--config is required for stable-runtime');
    const binding = validateStableRuntimeAutostartBinding({
      configPath: args.configPath,
      repoPath: args.repoPath || null,
      launcherRepoRoot: ROOT,
    });
    const targetSha = args.targetSha ? String(args.targetSha).trim().toLowerCase() : null;
    if (targetSha && !EXACT_SHA_RE.test(targetSha)) throw new Error('--sha must be an exact 40-hex commit SHA');
    if (binding.profileKind === 'relay-agent' && !targetSha) {
      throw new Error('--sha is required for relay-agent Stable Runtime autostart');
    }
    const launchArgs = [
      'launch-stable-runtime',
      '--config', binding.configPath,
      '--repo', binding.repoPath,
      '--binding-sha256', binding.bindingSha256,
    ];
    if (targetSha) launchArgs.push('--sha', targetSha);
    const action = buildLauncherAction({
      nodePath: process.execPath,
      repoRoot: ROOT,
      launchArgs,
    });
    return buildWindowsLoginTaskSpec({ kind: args.kind, userSid, action });
  }
  if (args.kind === 'relay-host') {
    if (!args.bootstrapPath || !args.bootstrapSha256) {
      throw new Error('--bootstrap and --bootstrap-sha256 are required for relay-host');
    }
    const binding = validateRelayHostBootstrap({
      bootstrapPath: args.bootstrapPath,
      bootstrapSha256: args.bootstrapSha256,
    });
    const action = buildLauncherAction({
      nodePath: process.execPath,
      repoRoot: ROOT,
      launchArgs: [
        'launch-relay-host',
        '--bootstrap', binding.bootstrapPath,
        '--bootstrap-sha256', binding.bootstrapSha256,
      ],
    });
    return buildWindowsLoginTaskSpec({ kind: args.kind, userSid, action });
  }
  throw new Error('--kind must be stable-runtime or relay-host');
}
function planSummary(spec, xml) {
  return {
    status: 'PLAN',
    taskName: WINDOWS_LOGIN_TASK_NAME,
    kind: spec.kind,
    userSid: spec.userSid,
    trigger: spec.trigger,
    logonType: spec.logonType,
    runLevel: spec.runLevel,
    multipleInstances: spec.multipleInstances,
    networkRequired: spec.networkRequired,
    restartOnFailure: spec.restartOnFailure,
    actionCommand: path.win32.basename(spec.action.command),
    desiredTaskFingerprint: canonicalTaskFingerprint(xml),
  };
}

function writeResult(value) {
  process.stdout.write('WINDOWS_LOGIN_AUTOSTART ' + JSON.stringify(value) + '\n');
}

async function main() {
  let args;
  try { args = parse(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(String(error.message || error) + '\n' + usage() + '\n');
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return;
  }

  try {
    requireWindows(args.command);

    if (args.command === 'launch-stable-runtime') {
      if (!args.configPath || !args.repoPath || !args.bindingSha256) {
        throw new Error('--config, --repo, and --binding-sha256 are required');
      }
      const result = launchStableRuntime({
        configPath: args.configPath,
        repoPath: args.repoPath,
        launcherRepoRoot: ROOT,
        targetSha: args.targetSha || null,
        expectedBindingSha256: args.bindingSha256,
      });
      writeResult(result);
      if (result.code !== 0) process.exitCode = result.code || 1;
      return;
    }

    if (args.command === 'launch-relay-host') {
      if (!args.bootstrapPath || !args.bootstrapSha256) throw new Error('--bootstrap and --bootstrap-sha256 are required');
      const result = launchRelayHost({
        bootstrapPath: args.bootstrapPath,
        bootstrapSha256: args.bootstrapSha256,
      });
      writeResult(result);
      if (result.code !== 0) process.exitCode = result.code || 1;
      return;
    }

    if (args.command === 'status') {
      writeResult(safeTaskStatus(queryWindowsLoginTask()));
      return;
    }

    if (args.command === 'uninstall') {
      writeResult(removeWindowsLoginTask({ existingXml: queryWindowsLoginTask() }));
      return;
    }

    const userSid = process.platform === 'win32'
      ? currentWindowsUserSid()
      : 'S-1-5-21-111-222-333-1001';
    const spec = desiredSpec(args, userSid);
    const xml = renderWindowsLoginTaskXml(spec);

    if (args.command === 'plan') {
      writeResult(planSummary(spec, xml));
      return;
    }

    writeResult(applyWindowsLoginTask({ desiredXml: xml, existingXml: queryWindowsLoginTask() }));
  } catch (error) {
    process.stderr.write('WINDOWS_LOGIN_AUTOSTART ' + JSON.stringify({
      status: 'FAIL',
      message: String(error?.message || error).slice(0, 768),
    }) + '\n');
    process.exitCode = 1;
  }
}

await main();
