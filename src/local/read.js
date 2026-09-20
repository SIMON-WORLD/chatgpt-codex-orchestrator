// chatgpt-codex-orchestrator: bounded read-only file read (v0.2 M2).
// Reads only the bounded prefix/range required (stat + open/read), never the
// whole file. Binary detection operates on a small probe, not the whole file.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { WorkspaceError } from './workspace.js';
import { isSensitivePath } from './sensitive.js';
import { redactSecrets } from '../safety.js';
import { extractTextContent } from './desktop-commander-child.js';

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_LINES = 2000;
const HARD_MAX_BYTES = 4 * 1024 * 1024;
const EDITABLE_MAX_BYTES = 256 * 1024;
const PROBE_BYTES = 8192;

// DesktopCommander 0.2.51 routes these extensions into dedicated PDF,
// Office/Excel, or image handlers. Keep child-backed read on the ordinary
// text path until the pinned dependency graph no longer carries the current
// special-format transitive risk.
const CHILD_SPECIAL_FORMAT_EXTENSIONS = new Set([
  '.pdf',
  '.docx',
  '.xlsx', '.xls', '.xlsm',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
]);

function assertChildTextFormat(validation) {
  const visibleExt = path.extname(String(validation.relPath || '')).toLowerCase();
  const canonicalExt = path.extname(String(validation.canonical || '')).toLowerCase();
  if (CHILD_SPECIAL_FORMAT_EXTENSIONS.has(visibleExt) || CHILD_SPECIAL_FORMAT_EXTENSIONS.has(canonicalExt)) {
    throw new WorkspaceError(`special-format read blocked: ${validation.relPath}`);
  }
  return validation;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, PROBE_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

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

function validateRead({ workspaceId, path: relPath, maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES, secondaryReadGrants = [] } = {}, registry) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > HARD_MAX_BYTES) {
    throw new WorkspaceError(`maxBytes must be a positive integer <= ${HARD_MAX_BYTES}`);
  }
  if (!Number.isInteger(maxLines) || maxLines <= 0) throw new WorkspaceError('maxLines must be a positive integer');
  const { workspace, absolute, canonical, authorizationRoot, external } = registry.resolve(workspaceId, relPath, { secondaryReadGrants });
  if (!fs.existsSync(absolute)) throw new WorkspaceError(`file not found: ${relPath}`);
  if (!external && !isWithin(workspace.root, canonical)) throw new WorkspaceError(`path escapes workspace: ${relPath}`);
  const st = fs.statSync(canonical);
  if (!st.isFile()) throw new WorkspaceError(`not a regular file: ${relPath}`);

  // Evaluate read policy on BOTH the caller-visible path and the canonical
  // target (an internal symlink/junction alias must not hide a sensitive file).
  const canonicalRel = path.relative(authorizationRoot || workspace.root, canonical);
  if (isSensitivePath(relPath) || (canonicalRel && isSensitivePath(canonicalRel))) {
    throw new WorkspaceError(`sensitive path blocked: ${relPath}`);
  }

  // Read a small canonical probe before dispatch. This guarantees the child
  // never receives a path that has not passed binary and sensitive checks.
  const fd = fs.openSync(canonical, 'r');
  try {
    const probe = Buffer.alloc(Math.min(st.size, PROBE_BYTES));
    const nprobe = fs.readSync(fd, probe, 0, probe.length, 0);
    if (looksBinary(probe.subarray(0, nprobe))) throw new WorkspaceError(`binary file rejected: ${relPath}`);
  } finally {
    fs.closeSync(fd);
  }

  return { workspace, canonical, relPath: external ? canonical : relPath, size: st.size, maxBytes, maxLines };
}

function extractChildReadText(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  return text.replace(/^\[Reading [^\n]*\]\n\n/u, '');
}

function normalizeReadContent({ raw, relPath, size, maxBytes, maxLines }) {
  // Desktop Commander returns text plus a bounded line header. Re-apply the
  // orchestrator byte/line bounds because those bounds are part of the current
  // Direct Local response contract, not an upstream promise.
  const source = extractChildReadText(raw);
  const buf = Buffer.from(source, 'utf8');
  const n = Math.min(buf.length, maxBytes);
  const chunk = buf.subarray(0, n).toString('utf8');
  const lines = chunk.split(/\r?\n/);
  const truncatedLines = lines.length > maxLines;
  const content = truncatedLines ? lines.slice(0, maxLines).join('\n') : chunk;
  const full = !(size > maxBytes) && !truncatedLines && size <= EDITABLE_MAX_BYTES;
  const sha = full ? crypto.createHash('sha256').update(buf.subarray(0, n)).digest('hex') : null;
  return {
    path: relPath,
    bytes: size,
    content: redactSecrets(content),
    sha256: sha,
    truncated: size > maxBytes || buf.length > maxBytes || truncatedLines,
  };
}

async function readFileThroughChild(validation, child) {
  if (typeof child?.readFile !== 'function') throw new WorkspaceError('desktop commander child adapter is required');
  const result = await child.readFile({ path: validation.canonical, maxLines: validation.maxLines, maxBytes: validation.maxBytes });
  const raw = typeof result === 'string' ? result : extractTextContent(result);
  return normalizeReadContent({
    raw,
    relPath: validation.relPath,
    size: validation.size,
    maxBytes: validation.maxBytes,
    maxLines: validation.maxLines,
  });
}

export async function readFileWithDesktopCommander(args = {}, registry, child) {
  if (!child) throw new WorkspaceError('desktop commander child adapter is required');
  return readFileThroughChild(assertChildTextFormat(validateRead(args, registry)), child);
}

export const READ_DEFAULTS = { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES };
