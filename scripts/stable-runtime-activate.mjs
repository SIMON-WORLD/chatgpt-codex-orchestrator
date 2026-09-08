#!/usr/bin/env node
import { StableRuntimeActivator, StableRuntimeActivationError } from '../src/activation/stable-runtime-activator.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sha') out.targetSha = argv[++i];
    else if (arg === '--config') out.configPath = argv[++i];
    else if (arg === '--repo') out.repoPath = argv[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    'Stable Runtime activation bootstrap (Issue #36)',
    '',
    'One bounded host activation action:',
    '  node scripts/stable-runtime-activate.mjs --sha <exact-40-hex-commit> --config <existing-stable-v0.2-config.json> [--repo <trusted-canonical-repo>]',
    '',
    'The activator only prepares/starts the accepted Stable Runtime revision. It does not expose a shell/process API, mutate Governance JSON, or recreate the external Secure Tunnel.',
  ].join('\n');
}

let args;
try { args = parseArgs(process.argv.slice(2)); }
catch (error) {
  process.stderr.write(`${error.message}\n${usage()}\n`);
  process.exit(2);
}

if (args.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

args.targetSha ||= process.env.STABLE_RUNTIME_TARGET_SHA;
args.configPath ||= process.env.STABLE_RUNTIME_CONFIG;
if (!args.targetSha || !args.configPath) {
  process.stderr.write(`${usage()}\n`);
  process.exit(2);
}

const activator = new StableRuntimeActivator();
try {
  const result = await activator.activate(args);
  process.stdout.write(`STABLE_RUNTIME_ACTIVATION ${JSON.stringify(result)}\n`);
} catch (error) {
  const payload = { status: 'FAIL', message: error?.message || String(error), ...(error instanceof StableRuntimeActivationError ? error.details : {}) };
  process.stderr.write(`STABLE_RUNTIME_ACTIVATION ${JSON.stringify(payload)}\n`);
  process.exit(1);
}
