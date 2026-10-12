#!/usr/bin/env node
import path from 'node:path';
import {
  DESKTOP_RELAY_DURABLE_BOOTSTRAP_PATH,
  DESKTOP_RELAY_TASK_NAME,
  applyDesktopRelayTask,
  buildDesktopRelayTaskSpec,
  currentWindowsUserSid,
  desktopRelayTaskFingerprint,
  materializeDesktopRelayBootstrap,
  queryDesktopRelayTask,
  reconcileDesktopRelayTaskInstall,
  removeDesktopRelayTask,
  renderDesktopRelayTaskXml,
  safeDesktopRelayTaskStatus,
  validateDesktopRelayBootstrap,
} from '../src/operability/windows-desktop-relay-host.js';

function usage() {
  return [
    'Windows desktop-primary Relay/Tunnel-only AtLogOn task for Issue #222',
    '',
    'Usage:',
    '  node scripts/windows-desktop-relay-host-autostart.mjs plan --bootstrap <absolute.ps1> --bootstrap-sha256 <64-hex>',
    '  node scripts/windows-desktop-relay-host-autostart.mjs install --bootstrap <absolute.ps1> --bootstrap-sha256 <64-hex>',
    '  node scripts/windows-desktop-relay-host-autostart.mjs status',
    '  node scripts/windows-desktop-relay-host-autostart.mjs uninstall',
  ].join('\n');
}

function parse(argv) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') return { help: true };
  if (!new Set(['plan', 'install', 'status', 'uninstall']).has(command)) {
    throw new Error('unsupported command: ' + command);
  }
  const args = { command };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--bootstrap') args.bootstrapPath = argv[++i];
    else if (arg === '--bootstrap-sha256') args.bootstrapSha256 = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error('unknown argument: ' + arg);
  }
  return args;
}

function requireWindows() {
  if (process.platform !== 'win32') throw new Error('desktop Relay Task operations are supported only on Windows');
}

function writeResult(value) {
  process.stdout.write('WINDOWS_DESKTOP_RELAY_HOST ' + JSON.stringify(value) + '\n');
}

async function main() {
  let args;
  try { args = parse(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(String(error?.message || error) + '\n' + usage() + '\n');
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return;
  }

  try {
    requireWindows();

    if (args.command === 'status') {
      writeResult(safeDesktopRelayTaskStatus(queryDesktopRelayTask()));
      return;
    }

    if (args.command === 'uninstall') {
      const existingXml = queryDesktopRelayTask();
      const result = removeDesktopRelayTask({ existingXml });
      writeResult({ ...result, durableBootstrapRetained: DESKTOP_RELAY_DURABLE_BOOTSTRAP_PATH });
      return;
    }

    if (!args.bootstrapPath || !args.bootstrapSha256) {
      throw new Error('--bootstrap and --bootstrap-sha256 are required');
    }
    const reviewed = validateDesktopRelayBootstrap({
      bootstrapPath: args.bootstrapPath,
      bootstrapSha256: args.bootstrapSha256,
    });
    const userSid = currentWindowsUserSid();
    const spec = buildDesktopRelayTaskSpec({
      userSid,
      bootstrapSha256: reviewed.bootstrapSha256,
    });
    const desiredXml = renderDesktopRelayTaskXml(spec);
    const existingXml = queryDesktopRelayTask();
    const decision = reconcileDesktopRelayTaskInstall({ existingXml, desiredXml });

    if (args.command === 'plan') {
      writeResult({
        status: 'PLAN',
        taskName: DESKTOP_RELAY_TASK_NAME,
        installDecision: decision.action,
        userSid,
        trigger: spec.trigger,
        logonType: spec.logonType,
        runLevel: spec.runLevel,
        multipleInstances: spec.multipleInstances,
        networkRequired: spec.networkRequired,
        restartOnFailure: spec.restartOnFailure,
        actionCommand: path.win32.basename(spec.action.command),
        desiredTaskFingerprint: desktopRelayTaskFingerprint(desiredXml),
        reviewedBootstrapSha256: reviewed.bootstrapSha256,
        durableBootstrapPath: DESKTOP_RELAY_DURABLE_BOOTSTRAP_PATH,
        bootstrapScope: 'Relay/Tunnel ports 18745-18748 only; Device B 18749 task retained separately',
      });
      return;
    }

    materializeDesktopRelayBootstrap({
      sourcePath: reviewed.bootstrapPath,
      sourceSha256: reviewed.bootstrapSha256,
    });
    const result = applyDesktopRelayTask({ desiredXml, existingXml });
    writeResult({
      ...result,
      bootstrapSha256: reviewed.bootstrapSha256,
      durableBootstrapPath: DESKTOP_RELAY_DURABLE_BOOTSTRAP_PATH,
    });
  } catch (error) {
    process.stderr.write('WINDOWS_DESKTOP_RELAY_HOST ' + JSON.stringify({
      status: 'FAIL',
      message: String(error?.message || error).slice(0, 768),
    }) + '\n');
    process.exitCode = 1;
  }
}

await main();
