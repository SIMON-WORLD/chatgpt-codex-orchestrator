// chatgpt-codex-orchestrator: durable runtime data-root resolver (Final Closure).
// Probe in order: explicit config -> env -> standard user root -> workspace candidates.
// A durable root must pass a real read/write/rename/delete probe. Never auto-elevate.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDataRoot } from './runtime-paths.js';

export function probeWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.probe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    fs.writeFileSync(probe, 'x', 'utf8');
    fs.renameSync(probe, probe + '.r');
    const read = fs.readFileSync(probe + '.r', 'utf8');
    fs.rmSync(probe + '.r', { force: true });
    return read === 'x';
  } catch (e) { return false; }
}

export function resolveDataRoot({ explicit = null, env = (typeof process !== 'undefined' ? process.env : {}), candidates = [] } = {}) {
  const sources = [
    { dir: explicit, source: 'explicit' },
    { dir: env.CHATGPT_ORCHESTRATOR_DATA_ROOT, source: 'env' },
    { dir: getDataRoot(), source: 'user-root' },
  ];
  for (const s of sources) { if (s.dir && probeWritable(s.dir)) return { dataRoot: s.dir, source: s.source }; }
  for (const c of candidates) { if (c && probeWritable(c)) return { dataRoot: c, source: 'workspace-candidate' }; }
  return { error: 'no durable writable dataRoot; set CHATGPT_ORCHESTRATOR_DATA_ROOT or supply a writable persistent dir' };
}