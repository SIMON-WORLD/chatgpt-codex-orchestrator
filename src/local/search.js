// chatgpt-codex-orchestrator: bounded read-only search (v0.2 M2).
// Bounds BOTH result size (maxResults) and work size (maxScannedFiles,
// maxScannedBytes). Skips sensitive + generated/cache/dependency dirs. No shell.

import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceError } from './workspace.js';
import { isSensitivePath, isIgnoredSearchDir } from './sensitive.js';

const DEFAULT_MAX_RESULTS = 100;
const HARD_MAX_RESULTS = 1000;
const DEFAULT_MAX_SCANNED_FILES = 2000;
const DEFAULT_MAX_SCANNED_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const SNIPPET_LEN = 100;

function isWithin(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  if (t === r) return true;
  return t.startsWith(r + path.sep);
}

function realpathOrNull(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

function walk(root, registry, onFile, budget, wsRoot) {
  const stack = [root];
  while (stack.length && !budget.stop) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (isIgnoredSearchDir(e.name) || isSensitivePath(e.name)) continue;
        const real = realpathOrNull(p);
        if (real && !isWithin(wsRoot, real)) continue;
        stack.push(p);
      } else if (e.isFile()) {
        if (isSensitivePath(path.relative(wsRoot, p))) continue;
        budget.scannedFiles++;
        if (budget.scannedFiles > budget.maxScannedFiles) { budget.stop = true; budget.limitReason = 'maxScannedFiles'; return; }
        const st = fs.statSync(p);
        budget.scannedBytes += st.size || 0;
        if (budget.scannedBytes > budget.maxScannedBytes) { budget.stop = true; budget.limitReason = 'maxScannedBytes'; return; }
        onFile(p);
        if (budget.stop) return;
      }
    }
  }
}

export function search({ workspaceId, query, path: relScope = null, maxResults = DEFAULT_MAX_RESULTS, maxScannedFiles = DEFAULT_MAX_SCANNED_FILES, maxScannedBytes = DEFAULT_MAX_SCANNED_BYTES } = {}, registry) {
  if (!query || typeof query !== 'string' || !query.trim()) throw new WorkspaceError('search requires a query');
  if (!Number.isInteger(maxResults) || maxResults <= 0 || maxResults > HARD_MAX_RESULTS) {
    throw new WorkspaceError(`maxResults must be a positive integer <= ${HARD_MAX_RESULTS}`);
  }
  if (!Number.isInteger(maxScannedFiles) || maxScannedFiles <= 0) throw new WorkspaceError('maxScannedFiles must be a positive integer');
  const ws = registry.get(workspaceId);
  const root = scopeRoot(ws, relScope, registry);
  const matches = [];
  const needles = query.trim().split(/\s+/).filter(Boolean);
  const budget = { scannedFiles: 0, scannedBytes: 0, maxScannedFiles, maxScannedBytes, stop: false, limitReason: null };

  walk(root, registry, (file) => {
    if (budget.stop) return;
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
        matches.push({ path: path.relative(ws.root, file).replace(/\\/g, '/'), line: i + 1, snippet: line.trim().slice(0, SNIPPET_LEN) });
        if (matches.length >= maxResults) { budget.stop = true; budget.limitReason = 'maxResults'; return; }
      }
    }
  }, budget, ws.root);

  return {
    matches,
    truncated: budget.stop,
    count: matches.length,
    scannedFiles: budget.scannedFiles,
    limitReason: budget.limitReason,
  };
}

function scopeRoot(ws, relScope, registry) {
  if (!relScope) return ws.root;
  const { absolute } = registry.resolve(ws.workspaceId, relScope);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) throw new WorkspaceError(`scope is not a directory: ${relScope}`);
  return absolute;
}

export const SEARCH_DEFAULTS = { maxResults: DEFAULT_MAX_RESULTS };
