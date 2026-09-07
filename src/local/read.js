// chatgpt-codex-orchestrator: bounded read-only file read (v0.2 M2).
// Reads only the bounded prefix/range required (stat + open/read), never the
// whole file. Binary detection operates on a small probe, not the whole file.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { WorkspaceError } from './workspace.js';
import { isSensitivePath } from './sensitive.js';
import { redactSecrets } from '../safety.js';


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

export function readFile({ workspaceId, path: relPath, maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES } = {}, registry) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > HARD_MAX_BYTES) {
    throw new WorkspaceError(`maxBytes must be a positive integer <= ${HARD_MAX_BYTES}`);
  }
  const { workspace, absolute, canonical } = registry.resolve(workspaceId, relPath);
  if (!fs.existsSync(absolute)) throw new WorkspaceError(`file not found: ${relPath}`);
  const st = fs.statSync(absolute);
  if (!st.isFile()) throw new WorkspaceError(`not a regular file: ${relPath}`);
  // Evaluate read policy on BOTH the caller-visible path and the canonical
  // target (an internal symlink/junction alias must not hide a sensitive file).
  const canonicalRel = path.relative(workspace.root, canonical);
  if (isSensitivePath(relPath) || (canonicalRel && isSensitivePath(canonicalRel))) {
    throw new WorkspaceError(`sensitive path blocked: ${relPath}`);
  }
  // Read the canonical file that was policy-checked so a late alias retarget
  // cannot swap in a sensitive target after the check.
  const target = canonical;

  const fd = fs.openSync(target, 'r');
  try {
    const probe = Buffer.alloc(Math.min(st.size, PROBE_BYTES));
    const nprobe = fs.readSync(fd, probe, 0, probe.length, 0);
    if (looksBinary(probe.subarray(0, nprobe))) throw new WorkspaceError(`binary file rejected: ${relPath}`);

    const toRead = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(toRead);
    const n = fs.readSync(fd, buf, 0, toRead, 0);
    const chunk = buf.subarray(0, n).toString('utf8');
    const lines = chunk.split(/\r?\n/);
    const truncatedLines = lines.length > maxLines;
    const content = truncatedLines ? lines.slice(0, maxLines).join('\n') : chunk;

    const full = !(st.size > maxBytes) && !truncatedLines && st.size <= EDITABLE_MAX_BYTES;
    const sha = full ? crypto.createHash('sha256').update(buf.subarray(0, n)).digest('hex') : null;
    return {
      path: relPath,
      bytes: st.size,
      content: redactSecrets(content),
      sha256: sha,
      truncated: st.size > maxBytes || truncatedLines,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export const READ_DEFAULTS = { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES };
