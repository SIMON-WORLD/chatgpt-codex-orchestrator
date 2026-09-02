// chatgpt-codex-orchestrator: explicit workspace binding + containment (v0.2 M2/M3).
// workspace_open is mandatory before any local repo operation. The authorization
// boundary is the configured allowedRoots, NOT an implicit arbitrary process cwd.
//
// Containment accounts for: '..', absolute path escape, symlink/junction escape,
// and Windows path casing / separators (via case-insensitive root compare).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class WorkspaceError extends Error {
  constructor(msg) { super(msg); this.name = 'WorkspaceError'; }
}

function isWithin(root, target) {
  const norm = (p) => path.resolve(p);
  const r = norm(root); const t = norm(target);
  if (t === r) return true;
  return t.startsWith(r + path.sep);
}

function isWithinCI(root, target) {
  const norm = (p) => path.resolve(p);
  const r = process.platform === 'win32' ? norm(root).toLowerCase() : norm(root);
  const t = process.platform === 'win32' ? norm(target).toLowerCase() : norm(target);
  if (t === r) return true;
  return t.startsWith(r + (process.platform === 'win32' ? path.sep.toLowerCase() : path.sep));
}

function realpathOrNull(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

export class WorkspaceRegistry {
  constructor({ allowedRoots = null } = {}) {
    this.allowedRoots = (allowedRoots && allowedRoots.length ? allowedRoots : [process.cwd()])
      .map((r) => path.resolve(r)).filter(Boolean);
    this._workspaces = new Map();
  }

  get hasAllowedRoots() { return this.allowedRoots.length > 0; }

  _allowedRootFor(canonical) {
    for (const root of this.allowedRoots) {
      const rc = realpathOrNull(root) || root;
      if (isWithinCI(rc, canonical) || isWithin(rc, canonical)) return rc;
    }
    return null;
  }

  open({ path: rawPath } = {}) {
    if (!rawPath || typeof rawPath !== 'string') throw new WorkspaceError('workspace_open requires a path');
    const requested = path.resolve(rawPath);
    const canonical = realpathOrNull(requested);
    if (!canonical) throw new WorkspaceError(`workspace path does not exist: ${requested}`);
    if (!fs.existsSync(canonical) || !fs.statSync(canonical).isDirectory()) throw new WorkspaceError(`workspace path is not a directory: ${canonical}`);
    const allowed = this._allowedRootFor(canonical);
    if (!allowed) throw new WorkspaceError(`workspace path not within configured allowed roots: ${canonical}`);
    const workspaceId = crypto.randomUUID();
    const isGitRepo = detectGitRepo(canonical);
    const ws = { workspaceId, root: canonical, isGitRepo, allowedRoot: allowed };
    this._workspaces.set(workspaceId, ws);
    return { workspaceId, root: canonical, isGitRepo };
  }

  get(workspaceId) {
    const ws = this._workspaces.get(workspaceId);
    if (!ws) throw new WorkspaceError(`unknown workspaceId: ${workspaceId}`);
    return ws;
  }

  // Read-path resolution with containment checks (existing target).
  resolve(workspaceId, relPath) {
    const ws = this.get(workspaceId);
    if (!relPath) throw new WorkspaceError('resolve requires a path');
    const target = path.resolve(ws.root, relPath);
    if (!isWithin(ws.root, target)) throw new WorkspaceError(`path escapes workspace: ${relPath}`);
    const real = realpathOrNull(target);
    if (real && !isWithin(ws.root, real)) throw new WorkspaceError(`symlink escapes workspace: ${relPath}`);
    return { workspace: ws, absolute: target };
  }

  // Write-safe resolution: for an EXISTING target, canonicalize the resolved path
  // and reject symlink/junction escape. For a NEW target, canonicalize the nearest
  // existing parent and reject parent escape / .. / absolute escape.
  resolveWritable(workspaceId, relPath, { forCreate = false } = {}) {
    const ws = this.get(workspaceId);
    if (!relPath) throw new WorkspaceError('resolveWritable requires a path');
    if (path.isAbsolute(relPath)) throw new WorkspaceError(`absolute path not allowed: ${relPath}`);
    const target = path.resolve(ws.root, relPath);
    if (!isWithin(ws.root, target)) throw new WorkspaceError(`path escapes workspace: ${relPath}`);
    const probe = forCreate ? (fs.existsSync(target) ? target : path.dirname(target)) : target;
    const real = realpathOrNull(probe);
    if (real && !isWithin(ws.root, real)) throw new WorkspaceError(`symlink/junction escapes workspace: ${relPath}`);
    return { workspace: ws, absolute: target, exists: fs.existsSync(target) };
  }

  getWorkspace(workspaceId) { return this.get(workspaceId); }
}

export function detectGitRepo(root) {
  try { return fs.existsSync(path.join(root, '.git')); } catch { return false; }
}
