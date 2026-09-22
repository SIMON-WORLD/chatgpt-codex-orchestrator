import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceError } from './workspace.js';
import { isSensitivePath, isIgnoredSearchDir } from './sensitive.js';
import { assertChildTextFormat, normalizeReadContent, validateRead } from './read.js';

const MAX_MULTI_FILES = 16;
const MAX_LIST_DEPTH = 3;
const DEFAULT_LIST_RESULTS = 200;
const HARD_LIST_RESULTS = 1000;
const DEFAULT_FILENAME_RESULTS = 100;
const HARD_FILENAME_RESULTS = 1000;
const FILENAME_SEARCH_POLL_DELAY_MS = 50;

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

function realpathOrNull(value) {
  try { return fs.realpathSync.native(value); } catch { return null; }
}

function displayPath(validation, canonical) {
  return validation.external
    ? canonical
    : path.relative(validation.workspace.root, canonical).replace(/\\/g, '/');
}

function validateDirectory({ workspaceId, path: requestedPath = null, depth = 1, maxResults = DEFAULT_LIST_RESULTS, secondaryReadGrants = [] } = {}, registry) {
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_LIST_DEPTH) throw new WorkspaceError(`depth must be an integer between 1 and ${MAX_LIST_DEPTH}`);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > HARD_LIST_RESULTS) throw new WorkspaceError(`maxResults must be a positive integer <= ${HARD_LIST_RESULTS}`);
  const ws = registry.get(workspaceId);
  if (requestedPath && isSensitivePath(requestedPath)) throw new WorkspaceError(`sensitive path blocked: ${requestedPath}`);
  const scope = registry.resolveSearchScope(workspaceId, requestedPath, { secondaryReadGrants });
  const scopedRel = path.relative(scope.authorizationRoot, scope.root);
  if ((scopedRel && isSensitivePath(scopedRel)) || isSensitivePath(scope.root)) throw new WorkspaceError(`sensitive path blocked: ${requestedPath}`);
  return { workspace: ws, ...scope, requestedPath, depth, maxResults };
}

function parseMultiFileContent(raw, validations) {
  const normalized = String(raw || '').replace(/\r\n/g, '\n');
  const out = [];
  for (let i = 0; i < validations.length; i += 1) {
    const validation = validations[i];
    const marker = `--- ${validation.canonical} contents: ---`;
    const start = normalized.indexOf(marker);
    if (start < 0) throw new WorkspaceError(`DesktopCommander multi-file read omitted an authorized target: ${validation.relPath}`);
    const bodyStart = start + marker.length;
    let end = normalized.length;
    for (let j = i + 1; j < validations.length; j += 1) {
      const nextMarker = `--- ${validations[j].canonical} contents: ---`;
      const next = normalized.indexOf(nextMarker, bodyStart);
      if (next >= 0) { end = next; break; }
    }
    out.push(normalized.slice(bodyStart, end).replace(/^\n+/, '').replace(/\n+$/, '\n'));
  }
  return out;
}

export async function readMultipleFilesWithDesktopCommander({ workspaceId, paths = [], maxBytes, maxLines, secondaryReadGrants = [] } = {}, registry, child) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_MULTI_FILES) throw new WorkspaceError(`paths must contain 1-${MAX_MULTI_FILES} explicit files`);
  if (new Set(paths).size !== paths.length) throw new WorkspaceError('paths must not contain duplicates');
  if (typeof child?.readMultipleFiles !== 'function') throw new WorkspaceError('desktop commander child adapter is required');

  // Validate every target before any child dispatch. Mixed authorized/unauthorized
  // requests fail closed and cannot leak partial content.
  const validations = paths.map((filePath) => assertChildTextFormat(validateRead({
    workspaceId, path: filePath, maxBytes, maxLines, secondaryReadGrants,
  }, registry)));

  const raw = await child.readMultipleFiles({ paths: validations.map((item) => item.canonical) });
  const bodies = parseMultiFileContent(raw, validations);
  return {
    files: validations.map((validation, index) => normalizeReadContent({
      raw: bodies[index],
      relPath: validation.relPath,
      size: validation.size,
      offset: 0,
      maxBytes: validation.maxBytes,
      maxLines: validation.maxLines,
    })),
  };
}

export async function listDirectoryWithDesktopCommander(args = {}, registry, child) {
  if (typeof child?.listDirectory !== 'function') throw new WorkspaceError('desktop commander child adapter is required');
  const validation = validateDirectory(args, registry);
  const result = await child.listDirectory({ path: validation.root, depth: validation.depth });
  const raw = typeof result === 'string' ? result : result?.output;
  const entries = [];
  for (const line of String(raw || '').replace(/\r\n/g, '\n').split('\n')) {
    const match = line.match(/^\[(FILE|DIR)\]\s+(.+)$/u);
    if (!match) continue;
    const candidate = path.resolve(validation.root, match[2]);
    const canonical = realpathOrNull(candidate);
    if (!canonical || !isWithin(validation.root, canonical) || !isWithin(validation.authorizationRoot, canonical)) {
      throw new WorkspaceError('directory listing escaped authorized scope');
    }
    const rel = path.relative(validation.authorizationRoot, canonical).replace(/\\/g, '/');
    if (isSensitivePath(rel) || isSensitivePath(canonical) || rel.split('/').some((part) => isIgnoredSearchDir(part))) continue;
    let stat;
    try { stat = fs.statSync(canonical); } catch { throw new WorkspaceError('directory listing returned a stale entry'); }
    const expected = match[1] === 'DIR' ? stat.isDirectory() : stat.isFile();
    if (!expected) throw new WorkspaceError('directory listing type changed during revalidation');
    entries.push({ path: displayPath(validation, canonical), type: match[1] === 'DIR' ? 'directory' : 'file' });
    if (entries.length >= validation.maxResults) break;
  }
  return {
    path: validation.external ? validation.root : (validation.requestedPath || '.'),
    entries,
    count: entries.length,
    truncated: !!result?.truncated || entries.length >= validation.maxResults || /\[WARNING\]/u.test(String(raw || '')),
  };
}

function parseInfo(raw) {
  const values = {};
  for (const line of String(raw || '').replace(/\r\n/g, '\n').split('\n')) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/u);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return values;
}

export async function fileInfoWithDesktopCommander({ workspaceId, path: filePath, secondaryReadGrants = [] } = {}, registry, child) {
  if (typeof child?.getFileInfo !== 'function') throw new WorkspaceError('desktop commander child adapter is required');
  const validation = assertChildTextFormat(validateRead({ workspaceId, path: filePath, maxBytes: 1, maxLines: 1, secondaryReadGrants }, registry));
  const stat = fs.statSync(validation.canonical);
  const info = parseInfo(await child.getFileInfo({ path: validation.canonical }));
  return {
    path: validation.relPath,
    type: 'file',
    size: stat.size,
    createdAt: stat.birthtime.toISOString(),
    modifiedAt: stat.mtime.toISOString(),
    accessedAt: stat.atime.toISOString(),
    fileType: info.fileType || null,
    lineCount: /^\d+$/u.test(info.lineCount || '') ? Number(info.lineCount) : null,
    lastLine: /^\d+$/u.test(info.lastLine || '') ? Number(info.lastLine) : null,
  };
}

function parseFilenameSearchPage(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const sessionId = (text.match(/(?:Started file search session|Search session):\s*([^\n]+)/iu) || [])[1]?.trim() || null;
  const status = (text.match(/Status:\s*([^\n]+)/iu) || [])[1] || '';
  const total = (text.match(/Total results(?: found)?:\s*(\d+)/iu) || [])[1];
  const results = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^📁\s+(.+)$/u);
    if (match) results.push(match[1]);
  }
  return {
    sessionId,
    results,
    totalResults: total == null ? null : Number(total),
    complete: /COMPLETED|Search completed/iu.test(status) || /✅ Search completed/iu.test(text),
    hasMore: /More results available/iu.test(text),
  };
}

export async function filenameSearchWithDesktopCommander({ workspaceId, query, path: requestedPath = null, maxResults = DEFAULT_FILENAME_RESULTS, secondaryReadGrants = [] } = {}, registry, child) {
  if (!query || typeof query !== 'string' || !query.trim()) throw new WorkspaceError('filename_search requires a query');
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > HARD_FILENAME_RESULTS) throw new WorkspaceError(`maxResults must be a positive integer <= ${HARD_FILENAME_RESULTS}`);
  if (typeof child?.startSearch !== 'function' || typeof child?.getMoreSearchResults !== 'function' || typeof child?.stopSearch !== 'function') throw new WorkspaceError('desktop commander child adapter is required');
  const validation = validateDirectory({ workspaceId, path: requestedPath, depth: 1, maxResults, secondaryReadGrants }, registry);

  const start = parseFilenameSearchPage(await child.startSearch({
    path: validation.root,
    pattern: query.trim(),
    searchType: 'files',
    ignoreCase: true,
    maxResults: HARD_FILENAME_RESULTS,
    includeHidden: false,
    timeout_ms: 3000,
    literalSearch: true,
    earlyTermination: false,
    origin: 'llm',
  }));
  if (!start.sessionId) throw new WorkspaceError('DesktopCommander filename search did not return a session id');

  const found = [];
  const seen = new Set();
  let page = start;
  let offset = 0;
  let requestedPage = false;
  try {
    for (let attempt = 0; attempt < 25 && found.length < maxResults; attempt += 1) {
      for (const rawPath of page.results) {
        const candidate = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(validation.root, rawPath);
        const canonical = realpathOrNull(candidate);
        if (!canonical || !isWithin(validation.root, canonical) || !isWithin(validation.authorizationRoot, canonical)) throw new WorkspaceError('filename search escaped authorized scope');
        const rel = path.relative(validation.authorizationRoot, canonical).replace(/\\/g, '/');
        if (!rel || isSensitivePath(rel) || isSensitivePath(canonical) || rel.split('/').some((part) => isIgnoredSearchDir(part))) continue;
        const display = displayPath(validation, canonical);
        if (!seen.has(display)) { seen.add(display); found.push(display); }
        if (found.length >= maxResults) break;
      }
      offset += page.results.length;
      if (page.complete && requestedPage && !page.hasMore) break;
      if (!page.complete && page.results.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, FILENAME_SEARCH_POLL_DELAY_MS));
      }
      page = parseFilenameSearchPage(await child.getMoreSearchResults({ sessionId: start.sessionId, offset, length: HARD_FILENAME_RESULTS }));
      requestedPage = true;
    }
  } finally {
    try { await child.stopSearch({ sessionId: start.sessionId }); } catch {}
  }

  return {
    matches: found.slice(0, maxResults),
    count: Math.min(found.length, maxResults),
    truncated: found.length >= maxResults || !page.complete || page.hasMore || (page.totalResults !== null && page.totalResults > found.length),
  };
}

export const FILESYSTEM_LIMITS = {
  maxMultiFiles: MAX_MULTI_FILES,
  maxListDepth: MAX_LIST_DEPTH,
  maxListResults: HARD_LIST_RESULTS,
  maxFilenameResults: HARD_FILENAME_RESULTS,
};
