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

function validateRead({ workspaceId, path: relPath, maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES } = {}, registry) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > HARD_MAX_BYTES) {
    throw new WorkspaceError(`maxBytes must be a positive integer <= ${HARD_MAX_BYTES}`);
  }
  if (!Number.isInteger(maxLines) || maxLines <= 0) throw new WorkspaceError('maxLines must be a positive integer');
  const { workspace, absolute, canonical } = registry.resolve(workspaceId, relPath);
  if (!fs.existsSync(absolute)) throw new WorkspaceError(`file not found: ${relPath}`);
  if (!isWithin(workspace.root, canonical)) throw new WorkspaceError(`path escapes workspace: ${relPath}`);
  const st = fs.statSync(canonical);
  if (!st.isFile()) throw new WorkspaceError(`not a regular file: ${relPath}`);

  // Evaluate read policy on BOTH the caller-visible path and the canonical
  // target (an internal symlink/junction alias must not hide a sensitive file).
  const canonicalRel = path.relative(workspace.root, canonical);
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

  return { workspace, canonical, relPath, size: st.size, maxBytes, maxLines };
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

function callChildTool(child, name, args) {
  if (typeof child?.callTool === 'function') return child.callTool(name, args);
  const legacy = { read_file: 'readFile' }[name];
  if (legacy && typeof child?.[legacy] === 'function') return child[legacy](args);
  throw new WorkspaceError('desktop commander child adapter is unavailable');
}

async function readFileThroughChild(validation, child) {
  const result = typeof child?.readFile === 'function'
    ? await child.readFile({ path: validation.canonical, maxLines: validation.maxLines, maxBytes: validation.maxBytes })
    : await callChildTool(child, 'read_file', { path: validation.canonical, offset: 0, length: validation.maxLines });
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
  return readFileThroughChild(validateRead(args, registry), child);
}

export function readFile(args = {}, registry, { child = null } = {}) {
  const validation = validateRead(args, registry);
  // Keep the historical direct helper synchronous for existing callers/tests.
  return child ? readFileThroughChild(validation, child) : readFileLocally(validation);
}

function readFileLocally(validation) {
  const fd = fs.openSync(validation.canonical, 'r');
  try {
    const toRead = Math.min(validation.size, validation.maxBytes);
    const buf = Buffer.alloc(toRead);
    const n = fs.readSync(fd, buf, 0, toRead, 0);
    return normalizeReadContent({
      raw: buf.subarray(0, n).toString('utf8'),
      relPath: validation.relPath,
      size: validation.size,
      maxBytes: validation.maxBytes,
      maxLines: validation.maxLines,
    });
  } finally {
    fs.closeSync(fd);
  }
}

export const READ_DEFAULTS = { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES };
