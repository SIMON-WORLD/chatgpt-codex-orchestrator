// chatgpt-codex-orchestrator: bounded read-only search inside a bound workspace
// (v0.2 M2). Skips sensitive + generated/cache/dependency directories. No shell.

import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceError } from './workspace.js';

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', 'venv', '.state', '.codex', 'coverage']);
const SENSITIVE = [/\.env($|\.)/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /id_rsa/i, /credentials/i, /\.htpasswd$/i, /secret/i, /\.pfx$/i, /token[^a-zA-Z0-9]/i];
const DEFAULT_MAX_RESULTS = 100;
const MAX_FILE_BYTES = 512 * 1024;
const SNIPPET_LEN = 100;

function isSensitive(base) {
  return SENSITIVE.some((re) => re.test(base));
}

function walk(root, registry, callback) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || isSensitive(e.name)) continue;
        // symlink/junction escape: ensure realpath stays within workspace.
        const real = realpathOrNull(p);
        if (real && !isWithin(root, real)) continue;
        stack.push(p);
      } else if (e.isFile()) {
        if (isSensitive(e.name)) continue;
        callback(p);
        if (callback.done) return;
      }
    }
  }
}

function isWithin(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  if (t === r) return true;
  return t.startsWith(r + path.sep);
}

function realpathOrNull(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

export function search({ workspaceId, query, path: relScope = null, maxResults = DEFAULT_MAX_RESULTS } = {}, registry) {
  if (!query || typeof query !== 'string' || !query.trim()) throw new WorkspaceError('search requires a query');
  const ws = registry.get(workspaceId);
  const root = relayScopeRoot(ws, relScope, registry);
  const matches = [];
  const needles = query.trim().split(/\s+/).filter(Boolean);
  let done = false;

  walk(root, registry, (file) => {
    if (done) return;
    // container boundary re-check for files.
    const real = realpathOrNull(file);
    if (real && !isWithin(ws.root, real)) return;
    let stat;
    try { stat = fs.statSync(file); } catch { return; }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const lower = line.toLowerCase();
      if (needles.every((n) => lower.includes(n.toLowerCase()))) {
        matches.push({
          path: path.relative(ws.root, file).replace(/\\/g, '/'),
          line: i + 1,
          snippet: line.trim().slice(0, SNIPPET_LEN),
        });
        if (matches.length >= maxResults) { done = true; return; }
      }
    }
  });

  return { matches, truncated: matches.length >= maxResults, count: matches.length };
}

function relayScopeRoot(ws, relScope, registry) {
  if (!relScope) return ws.root;
  const { absolute } = registry.resolve(ws.workspaceId, relScope);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) throw new WorkspaceError(`scope is not a directory: ${relScope}`);
  return absolute;
}

export const SEARCH_DEFAULTS = { maxResults: DEFAULT_MAX_RESULTS };
