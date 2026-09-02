// chatgpt-codex-orchestrator: Codex App Server executable discovery (M5 r1).
// Determines the exact binary + argv to spawn the real `codex app-server` from
// configuration / environment discovery. No hard-coded user path in commits.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function resolveCodexAppServer({ codexBin = null, listen = 'stdio://', spawnArgs = null } = {}) {
  if (Array.isArray(spawnArgs) && spawnArgs.length) {
    return { bin: codexBin || process.execPath, argv: spawnArgs.slice() };
  }
  const bin = codexBin || 'codex';
  if (String(bin).toLowerCase().endsWith('.js')) {
    return { bin: process.execPath, argv: [bin, 'app-server', '--listen', listen] };
  }
  if (bin === 'codex') {
    const d = discoverCodexAppServer({ listen });
    if (d && d.argv && d.argv.length) return d;
  }
  return { bin, argv: ['app-server', '--listen', listen] };
}

function npmGlobalRoot() {
  try { return execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(); } catch { return null; }
}

function candidatesForCodexJs() {
  const globalRoot = npmGlobalRoot();
  const candidates = [];
  if (globalRoot) candidates.push(path.join(globalRoot, '@openai', 'codex', 'bin', 'codex.js'));
  // npm shim dir (Windows-style global prefix) as a fallback.
  const npmPrefix = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : null;
  if (npmPrefix) candidates.push(npmPrefix);
  return candidates;
}

// Discover the canonical Codex App Server executable. Returns { bin, argv }.
export function discoverCodexAppServer({ listen = 'stdio://' } = {}) {
  const envBin = process.env.CODEX_BIN;
  const envJs = process.env.CODEX_APP_SERVER_JS;
  if (envJs) return { bin: process.execPath, argv: [envJs, 'app-server', '--listen', listen] };
  if (envBin) return resolveCodexAppServer({ codexBin: envBin, listen });

  for (const js of candidatesForCodexJs()) {
    if (fs.existsSync(js)) return { bin: process.execPath, argv: [js, 'app-server', '--listen', listen] };
  }
  // Fall back to the default `codex` on PATH (resolved at spawn time).
  return { bin: 'codex', argv: ['app-server', '--listen', listen] };
}

export { fs };
