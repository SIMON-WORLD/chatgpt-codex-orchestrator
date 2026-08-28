#!/usr/bin/env node
// chatgpt-codex-orchestrator: read-only brain-command status check CLI (Alpha.2).
// Checks whether the user-level launcher Skill is discoverable and the user-scoped
// brain-command config exists/parses, then prints the six safe config fields.
// Never prints any secret/token. Exits 0 when healthy, 1 when missing/invalid.
//   node scripts/brain-command-status.mjs [--codex-home <dir>] [--home <dir>] [--json]
import os from 'node:os';
import { brainCommandStatus, formatBrainCommandStatus } from '../src/bootstrap.js';

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
function has(name) { return process.argv.includes(name); }

const codexHome = arg('--codex-home') || process.env.CODEX_HOME || undefined;
const home = arg('--home') || process.env.HOME || process.env.USERPROFILE || os.homedir();

const status = brainCommandStatus({ codexHome, home });

if (has('--json')) {
  // The status object carries only the six safe config fields + check reasons;
  // it never contains a raw config dump or any secret/token field.
  console.log(JSON.stringify(status, null, 2));
} else {
  console.log(formatBrainCommandStatus(status));
}

process.exit(status.ok ? 0 : 1);
