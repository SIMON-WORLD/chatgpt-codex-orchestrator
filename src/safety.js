import { runtimePaths } from './runtime-paths.js';
// chatgpt-codex-orchestrator: safety / runtime boundary (Batch B4).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createSecret() { return crypto.randomBytes(32).toString('hex'); }

const SECRET_KEY_RE = /(authorization|api[_-]?key|bearer|token|secret|password|credential|experimental_bearer_token)/i;
const SECRET_VALUE_RE = /(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+|api[_-]?key\s*[:=]\s*\S+)/gi;

// Redact a known secret string and generic secret-looking patterns.
export function redactSecrets(text, secrets = []) {
  let out = String(text || '');
  for (const s of secrets) { if (s) out = out.split(s).join('***'); }
  return out.replace(SECRET_VALUE_RE, '***');
}

// Recursively redact secret-named keys in an object (for logs).
export function redactObject(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactObject);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEY_RE.test(k)) { out[k] = v === undefined ? v : '***'; }
    else if (typeof v === 'object') out[k] = redactObject(v);
    else out[k] = typeof v === 'string' ? redactSecrets(v) : v;
  }
  return out;
}

export function normalizeRepoDir(dir) {
  const abs = path.resolve(dir || '.');
  return abs;
}

// Structured JSONL task log with a size cap.
export class TaskLog {
  constructor({ logDir, taskId, maxBytes = 2_000_000 } = {}) {
    this.logDir = logDir || path.join(process.cwd(), '.state', 'logs');
    fs.mkdirSync(this.logDir, { recursive: true });
    this.file = path.join(this.logDir, (taskId || 'task') + '.jsonl');
    this.maxBytes = maxBytes;
  }
  write(entry, secrets = []) {
    try {
      const line = JSON.stringify(redactObject({ ...entry, at: new Date().toISOString() })) + '\n';
      if (fs.existsSync(this.file)) {
        const stat = fs.statSync(this.file);
        if (stat.size + line.length > this.maxBytes) this._rotate();
      }
      fs.appendFileSync(this.file, line, 'utf8');
    } catch (e) {}
  }
  _rotate() {
    try { fs.renameSync(this.file, this.file + '.1'); } catch (e) {}
  }
}

// Detect whether our codex invocation would rely on a dangerous bypass.
export function detectBypass({ bypassSandbox = false } = {}) {
  return { needsBypass: bypassSandbox, note: bypassSandbox ? 'dangerously-bypass-approvals-and-sandbox would be used (development opt-in)' : 'safe default (workspace-write sandbox)' };
}

// Verify a request carries the expected auth + task identity.
export function verifyAuth(req, { token, taskId }) {
  if (!token || req.auth !== token) return { ok: false, reason: 'auth token mismatch' };
  if (taskId && req.taskId !== taskId) return { ok: false, reason: 'task identity mismatch' };
  return { ok: true };
}

// Redirect Codex's home to a fresh writable temp dir (copy config+auth) so a codex
// child can write its tmp/state without hitting a read-only ~/.codex. Used because
// the node-REPL sandbox denies descendants writing ~/.codex/tmp/arg0. Best-effort.
export function redirectCodexHome() {
  const srcHome = path.join(os.homedir(), '.codex');
  const tempHome = path.join(os.tmpdir(), 'cxhome-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(tempHome, { recursive: true });
  try { fs.copyFileSync(path.join(srcHome, 'config.toml'), path.join(tempHome, 'config.toml')); } catch (e) {}
  try { fs.copyFileSync(path.join(srcHome, 'auth.json'), path.join(tempHome, 'auth.json')); } catch (e) {}
  if (typeof process !== 'undefined') process.env.CODEX_HOME = tempHome;
  return tempHome;
}