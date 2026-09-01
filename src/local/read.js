// chatgpt-codex-orchestrator: bounded read-only file read (v0.2 M2).
// Reads only the bounded prefix/range required (stat + open/read), never the
// whole file. Binary detection operates on a small probe, not the whole file.

import fs from 'node:fs';
import { redactSecrets } from '../safety.js';
import { WorkspaceError } from './workspace.js';
import { isSensitivePath } from './sensitive.js';

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_LINES = 2000;
const HARD_MAX_BYTES = 4 * 1024 * 1024;
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
  const { workspace, absolute } = registry.resolve(workspaceId, relPath);
  if (!fs.existsSync(absolute)) throw new WorkspaceError(`file not found: ${relPath}`);
  const st = fs.statSync(absolute);
  if (!st.isFile()) throw new WorkspaceError(`not a regular file: ${relPath}`);
  if (isSensitivePath(relPath)) throw new WorkspaceError(`sensitive path blocked: ${relPath}`);

  const fd = fs.openSync(absolute, 'r');
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

    return {
      path: relPath,
      bytes: st.size,
      content: redactSecrets(content),
      truncated: st.size > maxBytes || truncatedLines,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export const READ_DEFAULTS = { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES };
