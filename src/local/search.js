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

function childText(child, method, args) {
  if (typeof child?.[method] !== 'function') throw new WorkspaceError('desktop commander child adapter is required');
  return Promise.resolve(child[method](args)).then((result) => typeof result === 'string' ? result : extractTextContent(result));
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function searchThroughChild(validation, child) {
  const needles = validation.query.split(/\s+/).filter(Boolean);
  const startText = await childText(child, 'startSearch', {
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
  });
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
      page = parseChildSearchPage(await childText(child, 'getMoreSearchResults', {
        sessionId,
        offset: upstreamOffset,
        length: HARD_MAX_RESULTS,
      }));
      requestedPage = true;
      lastPage = page;
      upstreamOffset += page.results.length;
      complete = page.complete;
    }
  } finally {
    try { await childText(child, 'stopSearch', { sessionId }); } catch {}
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
  if (!child) throw new WorkspaceError('desktop commander child adapter is required');
  return searchThroughChild(validateSearch(args, registry), child);
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
