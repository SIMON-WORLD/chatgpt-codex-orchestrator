// chatgpt-codex-orchestrator: bounded read-only search (v0.2 M2).
// Bounds BOTH result size (maxResults) and work size (maxScannedFiles,
// maxScannedBytes). Skips sensitive + generated/cache/dependency dirs. No shell.

import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceError } from './workspace.js';
import { isSensitivePath, isIgnoredSearchDir } from './sensitive.js';
import { extractTextContent } from './desktop-commander-child.js';

const DEFAULT_MAX_RESULTS = 100;
const HARD_MAX_RESULTS = 1000;
const DEFAULT_MAX_SCANNED_FILES = 2000;
const DEFAULT_MAX_SCANNED_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const SNIPPET_LEN = 100;

function isWithin(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  if (process.platform === 'win32') {
    const rl = r.toLowerCase();
    const tl = t.toLowerCase();
    return tl === rl || tl.startsWith(rl.endsWith(path.sep) ? rl : `${rl}${path.sep}`);
  }
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : `${r}${path.sep}`);
}

function realpathOrNull(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

function walk(root, onFile, budget, wsRoot) {
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
        const real = realpathOrNull(p);
        if (real && isSensitivePath(path.relative(wsRoot, real))) continue;
        budget.scannedFiles++;
        if (budget.scannedFiles > budget.maxScannedFiles) {
          budget.stop = true;
          budget.limitReason = 'maxScannedFiles';
          return;
        }
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        budget.scannedBytes += st.size || 0;
        if (budget.scannedBytes > budget.maxScannedBytes) {
          budget.stop = true;
          budget.limitReason = 'maxScannedBytes';
          return;
        }
        onFile(p);
        if (budget.stop) return;
      }
    }
  }
}

function validateSearch({ workspaceId, query, path: relScope = null, maxResults = DEFAULT_MAX_RESULTS, maxScannedFiles = DEFAULT_MAX_SCANNED_FILES, maxScannedBytes = DEFAULT_MAX_SCANNED_BYTES } = {}, registry) {
  if (!query || typeof query !== 'string' || !query.trim()) throw new WorkspaceError('search requires a query');
  if (!Number.isInteger(maxResults) || maxResults <= 0 || maxResults > HARD_MAX_RESULTS) {
    throw new WorkspaceError(`maxResults must be a positive integer <= ${HARD_MAX_RESULTS}`);
  }
  if (!Number.isInteger(maxScannedFiles) || maxScannedFiles <= 0) throw new WorkspaceError('maxScannedFiles must be a positive integer');
  if (!Number.isInteger(maxScannedBytes) || maxScannedBytes <= 0) throw new WorkspaceError('maxScannedBytes must be a positive integer');
  const ws = registry.get(workspaceId);
  if (relScope && isSensitivePath(relScope)) throw new WorkspaceError(`sensitive path blocked: ${relScope}`);
  const root = scopeRoot(ws, relScope, registry);
  return { ws, root, query: query.trim(), maxResults, maxScannedFiles, maxScannedBytes };
}

function searchLocal({ ws, root, query, maxResults, maxScannedFiles, maxScannedBytes }) {
  const matches = [];
  const needles = query.split(/\s+/).filter(Boolean);
  const budget = { scannedFiles: 0, scannedBytes: 0, maxScannedFiles, maxScannedBytes, stop: false, limitReason: null };

  walk(root, (file) => {
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

export function search({ workspaceId, query, path: relScope = null, maxResults = DEFAULT_MAX_RESULTS, maxScannedFiles = DEFAULT_MAX_SCANNED_FILES, maxScannedBytes = DEFAULT_MAX_SCANNED_BYTES } = {}, registry) {
  return searchLocal(validateSearch({ workspaceId, query, path: relScope, maxResults, maxScannedFiles, maxScannedBytes }, registry));
}

function parseChildSearchPage(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const sessionId = (text.match(/(?:Started content search session|Search session):\s*([^\n]+)/i) || [])[1]?.trim() || null;
  const totalMatch = text.match(/Total results(?: found)?:\s*(\d+)/i);
  const status = (text.match(/Status:\s*([^\n]+)/i) || [])[1] || '';
  const results = [];
  const re = /^📄 (.*):(\d+) - (.*)$/gmu;
  let match;
  while ((match = re.exec(text))) results.push({ file: match[1], line: Number(match[2]), snippet: match[3] });
  return {
    sessionId,
    results,
    totalResults: totalMatch ? Number(totalMatch[1]) : null,
    complete: /COMPLETED|Search completed/iu.test(status) || /✅ Search completed/iu.test(text),
    hasMore: /More results available/iu.test(text),
  };
}

function normalizeChildMatch(result, ws) {
  const absolute = path.isAbsolute(result.file) ? path.resolve(result.file) : path.resolve(ws.root, result.file);
  const canonical = realpathOrNull(absolute);
  if (!canonical || !isWithin(ws.root, canonical)) return null;
  const rel = path.relative(ws.root, canonical).replace(/\\/g, '/');
  if (!rel || isSensitivePath(rel) || rel.split('/').some((part) => isIgnoredSearchDir(part))) return null;
  try {
    const stat = fs.statSync(canonical);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
  } catch { return null; }
  return { path: rel, line: result.line, snippet: String(result.snippet || '').trim().slice(0, SNIPPET_LEN) };
}

function appendChildMatches(target, seen, page, ws, maxResults, needles, budget) {
  for (const result of page.results) {
    const normalized = normalizeChildMatch(result, ws);
    if (!normalized) continue;
    if (!budget.files.has(normalized.path)) {
      let size;
      try { size = fs.statSync(path.resolve(ws.root, normalized.path)).size; } catch { continue; }
      if (budget.files.size >= budget.maxScannedFiles) return 'maxScannedFiles';
      if (budget.scannedBytes + size > budget.maxScannedBytes) return 'maxScannedBytes';
      budget.files.add(normalized.path);
      budget.scannedBytes += size;
    }
    const lower = normalized.snippet.toLowerCase();
    if (!needles.every((needle) => lower.includes(needle.toLowerCase()))) continue;
    const key = `${normalized.path}\u0000${normalized.line}\u0000${normalized.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(normalized);
    if (target.length >= maxResults) break;
  }
}

function childText(child, name, args, legacyName = null) {
  if (typeof child?.callTool === 'function') {
    return Promise.resolve(child.callTool(name, args)).then((result) => typeof result === 'string' ? result : extractTextContent(result));
  }
  if (legacyName && typeof child?.[legacyName] === 'function') return Promise.resolve(child[legacyName](args));
  throw new WorkspaceError('desktop commander child adapter is unavailable');
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function searchThroughChild(validation, child) {
  const needles = validation.query.split(/\s+/).filter(Boolean);
  const startText = await childText(child, 'start_search', {
    path: validation.root,
    pattern: needles[0],
    searchType: 'content',
    ignoreCase: true,
    // Over-fetch only within the existing hard result bound so parent-side
    // filtering can remove sensitive/ignored paths without hiding safe hits.
    maxResults: HARD_MAX_RESULTS,
    includeHidden: false,
    contextLines: 0,
    timeout_ms: 3000,
    literalSearch: true,
    origin: 'llm',
  }, 'startSearch');
  let page = parseChildSearchPage(startText);
  const sessionId = page.sessionId;
  if (!sessionId) throw new WorkspaceError('DesktopCommander search did not return a session id');

  const matches = [];
  const seen = new Set();
  let complete = page.complete;
  let lastPage = page;
  let requestedPage = false;
  let upstreamOffset = page.results.length;
  const budget = {
    files: new Set(),
    scannedBytes: 0,
    maxScannedFiles: validation.maxScannedFiles,
    maxScannedBytes: validation.maxScannedBytes,
    limitReason: null,
  };
  try {
    for (let attempt = 0; attempt < 25 && matches.length < validation.maxResults; attempt++) {
      budget.limitReason = appendChildMatches(matches, seen, page, validation.ws, validation.maxResults, needles, budget);
      if (budget.limitReason) break;
      if (matches.length >= validation.maxResults) break;
      // Fetch one session page even when start_search reports COMPLETED: the
      // upstream start response can contain only the initial page/status.
      if (complete && requestedPage && !page.hasMore) break;
      if (!complete) await wait(30);
      page = parseChildSearchPage(await childText(child, 'get_more_search_results', {
        sessionId,
        offset: upstreamOffset,
        length: HARD_MAX_RESULTS,
      }, 'getMoreSearchResults'));
      requestedPage = true;
      lastPage = page;
      upstreamOffset += page.results.length;
      complete = page.complete;
    }
  } finally {
    try { await childText(child, 'stop_search', { sessionId }, 'stopSearch'); } catch {}
  }

  const totalResults = lastPage.totalResults ?? page.totalResults;
  const truncated = !!budget.limitReason || !complete || !!lastPage.hasMore || (totalResults !== null && totalResults >= validation.maxResults) || matches.length >= validation.maxResults;
  return {
    matches: matches.slice(0, validation.maxResults),
    truncated,
    count: Math.min(matches.length, validation.maxResults),
    scannedFiles: budget.files.size,
    limitReason: budget.limitReason || (truncated ? 'maxResults' : null),
  };
}

export async function searchWithOptions(args = {}, registry, { child = null } = {}) {
  const validation = validateSearch(args, registry);
  return child ? searchThroughChild(validation, child) : searchLocal(validation);
}

function scopeRoot(ws, relScope, registry) {
  if (!relScope) return ws.root;
  const { canonical } = registry.resolve(ws.workspaceId, relScope);
  if (!isWithin(ws.root, canonical)) throw new WorkspaceError(`path escapes workspace: ${relScope}`);
  if (!fs.existsSync(canonical) || !fs.statSync(canonical).isDirectory()) throw new WorkspaceError(`scope is not a directory: ${relScope}`);
  const canonicalRel = path.relative(ws.root, canonical);
  if (canonicalRel && isSensitivePath(canonicalRel)) throw new WorkspaceError(`sensitive path blocked: ${relScope}`);
  return canonical;
}

export const SEARCH_DEFAULTS = { maxResults: DEFAULT_MAX_RESULTS };
