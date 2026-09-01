// chatgpt-codex-orchestrator: bounded read-only file read (v0.2 M2).
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../safety.js';
import { WorkspaceError } from './workspace.js';

const SENSITIVE = [/\.env($|\.)/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /id_rsa/i, /credentials/i, /\.htpasswd$/i, /secret/i, /\.pfx$/i, /token[^a-zA-Z0-9]/i];
const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_LINES = 2000;

function isSensitive(rel) {
  const parsed = path.posix.normalize(String(rel || '').replace(/\\/g, '/'));
  const base = path.posix.basename(parsed);
  return SENSITIVE.some((re) => re.test(parsed) || re.test(base));
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function readFile({ workspaceId, path: relPath, maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES } = {}, registry) {
  if (maxBytes > 4 * 1024 * 1024) throw new WorkspaceError('maxBytes exceeds 4MiB bound');
  const { workspace, absolute } = registry.resolve(workspaceId, relPath);
  if (!fs.existsSync(absolute)) throw new WorkspaceError(`file not found: ${relPath}`);
  const st = fs.statSync(absolute);
  if (!st.isFile()) throw new WorkspaceError(`not a regular file: ${relPath}`);
  if (isSensitive(path.relative(workspace.root, absolute))) throw new WorkspaceError(`sensitive path blocked: ${relPath}`);

  const buf = fs.readFileSync(absolute);
  if (looksBinary(buf)) throw new WorkspaceError(`binary file rejected: ${relPath}`);

  const truncatedBytes = buf.length > maxBytes;
  const chunk = buf.subarray(0, maxBytes).toString('utf8');
  const lines = chunk.split(/\r?\n/);
  const truncatedLines = lines.length > maxLines;
  const content = truncatedLines ? lines.slice(0, maxLines).join('\n') : chunk;

  return {
    path: relPath,
    bytes: buf.length,
    content: redactSecrets(content),
    truncated: truncatedBytes || truncatedLines,
  };
}

export const READ_DEFAULTS = { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES };
