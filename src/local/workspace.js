// chatgpt-codex-orchestrator: explicit workspace binding + containment (v0.2 M2/M3).
// workspace_open is mandatory before any local repo operation. The authorization
// boundary is the configured allowedRoots, NOT an implicit arbitrary process cwd.
//
// Containment accounts for: '..', absolute path escape, symlink/junction escape,
// and Windows path casing / separators (via case-insensitive root compare).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  FILESYSTEM_SCOPE_POLICIES,
  normalizeFilesystemScopePolicy,
} from '../config.js';

export { FILESYSTEM_SCOPE_POLICIES, normalizeFilesystemScopePolicy } from '../config.js';

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

// Effective canonical path where an operation would actually land. For an
// existing target the entire chain (symlink/junction final components included)
// is canonicalized. For a planned create (non-existent target) the nearest
// existing ancestor is canonicalized and the unresolved suffix is appended, so
// containment and path policy are evaluated on the path that would really be
// reached, not just the caller-visible alias path.
function effectiveRealPath(root, target) {
  const real = realpathOrNull(target);
  if (real) return real;
  const unresolved = [];
  let probe = target;
  for (;;) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    unresolved.unshift(path.basename(probe));
    probe = parent;
    const r = realpathOrNull(probe);
    if (r) return path.join(r, ...unresolved);
  }
  const rootReal = realpathOrNull(root) || root;
  return path.join(rootReal, ...unresolved);
}

export class WorkspaceRegistry {
  constructor({ allowedRoots = null, fixtures = null, filesystemScope = null } = {}) {
    this.filesystemScope = normalizeFilesystemScopePolicy(filesystemScope);
    const configuredRoots = Array.isArray(allowedRoots)
      ? allowedRoots
      : (allowedRoots ? [allowedRoots] : []);
    const defaultRoots = this.filesystemScope === FILESYSTEM_SCOPE_POLICIES.OS_USER_SCOPE
      ? []
      : (configuredRoots.length ? configuredRoots : [process.cwd()]);
    this.allowedRoots = defaultRoots
      .map((r) => path.resolve(r)).filter(Boolean);
    this.fixtures = new Map();
    if (fixtures && typeof fixtures === 'object' && !Array.isArray(fixtures)) {
      for (const [name, fixtureSpec] of Object.entries(fixtures)) {
        if (!name) continue;
        if (typeof fixtureSpec === 'string' && fixtureSpec.trim()) {
          this.fixtures.set(name, { path: path.resolve(fixtureSpec), contract: null });
          continue;
        }
        if (fixtureSpec && typeof fixtureSpec === 'object' && !Array.isArray(fixtureSpec)
            && typeof fixtureSpec.path === 'string' && fixtureSpec.path.trim()) {
          const contract = fixtureSpec.contract && typeof fixtureSpec.contract === 'object' && !Array.isArray(fixtureSpec.contract)
            ? JSON.parse(JSON.stringify(fixtureSpec.contract))
            : null;
          this.fixtures.set(name, { path: path.resolve(fixtureSpec.path), contract });
        }
      }
    }
    this._workspaces = new Map();
  }

  get isOsUserScope() { return this.filesystemScope === FILESYSTEM_SCOPE_POLICIES.OS_USER_SCOPE; }

  // Keep the established readiness field truthful for legacy callers while
  // treating an explicit OS-user policy as the configured filesystem scope.
  get hasAllowedRoots() { return this.allowedRoots.length > 0 || this.isOsUserScope; }

  _allowedRootFor(canonical) {
    if (this.isOsUserScope) return canonical;
    for (const root of this.allowedRoots) {
      const rc = realpathOrNull(root) || root;
      if (isWithinCI(rc, canonical) || isWithin(rc, canonical)) return rc;
    }
    return null;
  }

  open({ path: rawPath = null, fixture = null, secondaryReadGrants = [] } = {}) {
    const hasPath = typeof rawPath === 'string' && rawPath.trim().length > 0;
    const hasFixture = typeof fixture === 'string' && fixture.trim().length > 0;
    if (hasPath === hasFixture) throw new WorkspaceError('workspace_open requires exactly one of path or fixture');

    let selectedPath = rawPath;
    let fixtureName = null;
    let fixtureContract = null;
    if (hasFixture) {
      fixtureName = fixture.trim();
      const fixtureSpec = this.fixtures.get(fixtureName) || null;
      if (!fixtureSpec) throw new WorkspaceError(`workspace fixture not configured: ${fixtureName}`);
      selectedPath = fixtureSpec.path;
      fixtureContract = fixtureSpec.contract;
    }

    const requested = path.resolve(selectedPath);
    const canonical = realpathOrNull(requested);
    if (!canonical) throw new WorkspaceError(`workspace path does not exist: ${requested}`);
    if (!fs.existsSync(canonical) || !fs.statSync(canonical).isDirectory()) throw new WorkspaceError(`workspace path is not a directory: ${canonical}`);
    const allowed = this._allowedRootFor(canonical);
    if (!allowed) throw new WorkspaceError(`workspace path not within configured allowed roots: ${canonical}`);
    const workspaceId = crypto.randomUUID();
    const isGitRepo = detectGitRepo(canonical);
    const normalizedSecondaryReadGrants = this.normalizeSecondaryReadGrants(secondaryReadGrants);
    const ws = {
      workspaceId,
      root: canonical,
      isGitRepo,
      allowedRoot: allowed,
      filesystemScope: this.filesystemScope,
      fixture: fixtureName,
      fixtureContract: fixtureContract ? JSON.parse(JSON.stringify(fixtureContract)) : null,
      secondaryReadGrants: normalizedSecondaryReadGrants,
    };
    this._workspaces.set(workspaceId, ws);
    return {
      workspaceId,
      root: canonical,
      isGitRepo,
      filesystemScope: this.filesystemScope,
      ...(fixtureName ? { fixture: fixtureName } : {}),
      ...(fixtureContract ? { fixtureContract: JSON.parse(JSON.stringify(fixtureContract)) } : {}),
      secondaryReadGrantCount: normalizedSecondaryReadGrants.length,
    };
  }

  get(workspaceId) {
    const ws = this._workspaces.get(workspaceId);
    if (!ws) throw new WorkspaceError(`unknown workspaceId: ${workspaceId}`);
    return ws;
  }

  getSecondaryReadGrants(workspaceId) {
    const ws = this.get(workspaceId);
    return structuredClone(ws.secondaryReadGrants || []);
  }

  normalizeSecondaryReadGrants(grants = []) {
    if (!Array.isArray(grants)) throw new WorkspaceError('secondaryReadGrants must be an array');
    if (grants.length > 16) throw new WorkspaceError('secondaryReadGrants may contain at most 16 paths');
    const out = [];
    const seen = new Set();
    for (const raw of grants) {
      if (typeof raw !== 'string' || !raw.trim()) throw new WorkspaceError('secondary read grant must be a non-empty path string');
      const requested = path.resolve(raw);
      const canonical = realpathOrNull(requested);
      if (!canonical) throw new WorkspaceError(`secondary read grant does not exist: ${requested}`);
      const allowed = this._allowedRootFor(canonical);
      if (!allowed) throw new WorkspaceError(`secondary read grant not within configured allowed roots: ${canonical}`);
      const stat = fs.statSync(canonical);
      const kind = stat.isFile() ? 'file' : (stat.isDirectory() ? 'root' : null);
      if (!kind) throw new WorkspaceError(`secondary read grant must be a regular file or directory: ${canonical}`);
      const key = `${kind}:${process.platform === 'win32' ? canonical.toLowerCase() : canonical}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ kind, path: canonical });
      }
    }
    return out;
  }

  _selectSecondaryGrant(canonical, grants = [], { exactRoot = false } = {}) {
    for (const grant of grants || []) {
      if (!grant || typeof grant.path !== 'string' || !['file', 'root'].includes(grant.kind)) continue;
      const grantReal = realpathOrNull(grant.path);
      if (!grantReal || !(isWithinCI(grant.path, grantReal) && isWithinCI(grantReal, grant.path))) continue;
      if (!this._allowedRootFor(grantReal)) continue;
      let grantStat;
      try { grantStat = fs.statSync(grantReal); } catch { continue; }
      if (grant.kind === 'file' && !grantStat.isFile()) continue;
      if (grant.kind === 'root' && !grantStat.isDirectory()) continue;
      if (grant.kind === 'file') {
        if (!exactRoot && isWithinCI(grantReal, canonical) && isWithinCI(canonical, grantReal)) return { ...grant, path: grantReal };
        continue;
      }
      if (exactRoot) {
        if (isWithinCI(grantReal, canonical) && isWithinCI(canonical, grantReal)) return { ...grant, path: grantReal };
      } else if (isWithinCI(grantReal, canonical)) {
        return { ...grant, path: grantReal };
      }
    }
    return null;
  }

  // Read-path resolution with containment checks (existing target). Relative paths
  // remain primary-workspace scoped; absolute paths may use a task-scoped secondary
  // read grant but never acquire write/process/network authority.
  resolve(workspaceId, relPath, { secondaryReadGrants = [] } = {}) {
    const ws = this.get(workspaceId);
    if (!relPath) throw new WorkspaceError('resolve requires a path');
    const target = path.resolve(ws.root, relPath);
    const canonical = effectiveRealPath(ws.root, target);
    if (isWithinCI(ws.root, target) && isWithinCI(ws.root, canonical)) {
      return { workspace: ws, absolute: target, canonical, authorizationRoot: ws.root, external: false };
    }
    if (!path.isAbsolute(relPath)) {
      if (!isWithinCI(ws.root, target)) throw new WorkspaceError(`path escapes workspace: ${relPath}`);
      throw new WorkspaceError(`symlink escapes workspace: ${relPath}`);
    }
    if (this.isOsUserScope) {
      return {
        workspace: ws,
        absolute: target,
        canonical,
        authorizationRoot: this._osUserAuthorizationRoot(canonical),
        external: true,
        grant: null,
      };
    }
    const grant = this._selectSecondaryGrant(canonical, secondaryReadGrants, { exactRoot: false });
    if (!grant) throw new WorkspaceError(`path not authorized by a secondary read grant: ${relPath}`);
    return { workspace: ws, absolute: target, canonical, authorizationRoot: grant.kind === 'file' ? path.dirname(grant.path) : grant.path, external: true, grant };
  }

  resolveSearchScope(workspaceId, requestedPath = null, { secondaryReadGrants = [] } = {}) {
    const ws = this.get(workspaceId);
    if (!requestedPath) return { workspace: ws, root: ws.root, authorizationRoot: ws.root, external: false, grant: null };
    if (!path.isAbsolute(requestedPath)) {
      const resolved = this.resolve(workspaceId, requestedPath);
      const { canonical } = resolved;
      if (!fs.existsSync(canonical) || !fs.statSync(canonical).isDirectory()) throw new WorkspaceError(`scope is not a directory: ${requestedPath}`);
      return {
        workspace: ws,
        root: canonical,
        authorizationRoot: resolved.authorizationRoot,
        external: resolved.external,
        grant: resolved.grant || null,
      };
    }
    const canonical = realpathOrNull(path.resolve(requestedPath));
    if (!canonical) throw new WorkspaceError(`search scope does not exist: ${requestedPath}`);
    if (isWithinCI(ws.root, canonical)) {
      if (!fs.statSync(canonical).isDirectory()) throw new WorkspaceError(`scope is not a directory: ${requestedPath}`);
      return { workspace: ws, root: canonical, authorizationRoot: ws.root, external: false, grant: null };
    }
    if (this.isOsUserScope) {
      if (!fs.statSync(canonical).isDirectory()) throw new WorkspaceError(`scope is not a directory: ${requestedPath}`);
      return { workspace: ws, root: canonical, authorizationRoot: canonical, external: true, grant: null };
    }
    const grant = this._selectSecondaryGrant(canonical, secondaryReadGrants, { exactRoot: true });
    if (!grant || grant.kind !== 'root') throw new WorkspaceError(`search scope not authorized by an exact secondary directory grant: ${requestedPath}`);
    if (!fs.statSync(canonical).isDirectory()) throw new WorkspaceError(`scope is not a directory: ${requestedPath}`);
    return { workspace: ws, root: canonical, authorizationRoot: grant.path, external: true, grant };
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
    const canonical = effectiveRealPath(ws.root, target);
    if (!isWithin(ws.root, canonical)) throw new WorkspaceError(`symlink/junction escapes workspace: ${relPath}`);
    return { workspace: ws, absolute: target, exists: fs.existsSync(target), canonical };
  }

  _osUserAuthorizationRoot(canonical) {
    try {
      return fs.statSync(canonical).isDirectory() ? canonical : path.dirname(canonical);
    } catch {
      return path.dirname(canonical);
    }
  }

  getWorkspace(workspaceId) { return this.get(workspaceId); }
}

export function detectGitRepo(root) {
  try { return fs.existsSync(path.join(root, '.git')); } catch { return false; }
}
