import fs from 'node:fs';
import path from 'node:path';
import {
  FILESYSTEM_SCOPE_POLICIES,
  normalizeFilesystemScopePolicy as normalizePolicy,
} from '../config.js';

const EXACT_SHA_RE = /^[0-9a-f]{40}$/i;

export class FilesystemScopeInstallError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'FilesystemScopeInstallError';
    this.details = details;
  }
}

function pathApi(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function normalizeForCompare(value, platform = process.platform) {
  const api = pathApi(platform);
  const normalized = api.resolve(api.normalize(String(value)));
  if (platform !== 'win32') return normalized;

  let windowsPath = normalized.replace(/\//g, '\\');
  if (/^\\\\\?\\UNC\\/iu.test(windowsPath)) windowsPath = `\\\\${windowsPath.slice(8)}`;
  else if (/^\\\\\?\\/u.test(windowsPath)) windowsPath = windowsPath.slice(4);
  windowsPath = path.win32.normalize(windowsPath);
  if (windowsPath.length > 3) windowsPath = windowsPath.replace(/\\+$/u, '');
  return windowsPath.toLowerCase();
}

function canonicalForCompare(value, platform = process.platform, canonicalizeRoot = null) {
  try {
    const canonical = typeof canonicalizeRoot === 'function' ? canonicalizeRoot(value) : value;
    return normalizeForCompare(canonical, platform);
  } catch {
    return normalizeForCompare(value, platform);
  }
}

function exactSha(value, label) {
  const sha = String(value || '').trim().toLowerCase();
  if (!EXACT_SHA_RE.test(sha)) {
    throw new FilesystemScopeInstallError(`${label} must be an exact 40-hex commit SHA`, { phase: 'target_binding' });
  }
  return sha;
}

function policyValue(value) {
  try {
    return normalizePolicy(value);
  } catch (error) {
    throw new FilesystemScopeInstallError(error.message, { phase: 'scope_binding' });
  }
}

function configuredPolicy(config) { return policyValue(config?.filesystemScope); }

function existingRoots(config, platform = process.platform, canonicalizeRoot = null) {
  const roots = Array.isArray(config?.workspaceRoots)
    ? config.workspaceRoots.filter(Boolean).map((entry) => String(entry))
    : [];
  if (config?.workspaceRoot) roots.push(String(config.workspaceRoot));
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    const key = canonicalForCompare(root, platform, canonicalizeRoot);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(root);
    }
  }
  return out;
}

function normalizeSelectedRoots(selectedRoots, platform = process.platform, canonicalizeRoot = null) {
  if (!Array.isArray(selectedRoots)) {
    throw new FilesystemScopeInstallError('selected_roots policy requires an array of selected roots', { phase: 'scope_binding' });
  }
  if (selectedRoots.length === 0) {
    throw new FilesystemScopeInstallError('selected_roots policy requires at least one selected root', { phase: 'scope_binding' });
  }
  const out = [];
  const seen = new Set();
  for (const entry of selectedRoots) {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new FilesystemScopeInstallError('selected roots must be non-empty path strings', { phase: 'scope_binding' });
    }
    const root = entry.trim();
    const key = canonicalForCompare(root, platform, canonicalizeRoot);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(root);
    }
  }
  return out;
}

export function applyFilesystemScopePolicy(
  input,
  { policy = null, selectedRoots = undefined, platform = process.platform, canonicalizeRoot = null } = {},
) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new FilesystemScopeInstallError('Stable Runtime config must be a JSON object', { phase: 'config_parse' });
  }

  const requestedPolicy = policy === null || policy === undefined ? configuredPolicy(input) : policyValue(policy);
  const config = JSON.parse(JSON.stringify(input));
  const previousRoots = existingRoots(input, platform, canonicalizeRoot);
  let nextRoots = previousRoots;

  if (requestedPolicy === FILESYSTEM_SCOPE_POLICIES.SELECTED_ROOTS) {
    nextRoots = selectedRoots === undefined
      ? normalizeSelectedRoots(previousRoots, platform, canonicalizeRoot)
      : normalizeSelectedRoots(selectedRoots, platform, canonicalizeRoot);
    // Retain an existing spelling when it resolves to the same canonical
    // directory. This makes a short-name/case-only re-selection idempotent
    // without weakening canonical containment at runtime.
    nextRoots = nextRoots.map((root) => previousRoots.find((previous) => (
      canonicalForCompare(previous, platform, canonicalizeRoot) === canonicalForCompare(root, platform, canonicalizeRoot)
    )) || root);
    config.workspaceRoots = nextRoots.slice();

    // A legacy singular root is an effective root. Clear it when narrowing to
    // a list that excludes it, otherwise the config loader would re-inject the
    // old root and silently widen the new policy.
    if (Object.prototype.hasOwnProperty.call(input, 'workspaceRoot')) {
      const oldSingle = input.workspaceRoot ? String(input.workspaceRoot) : null;
      config.workspaceRoot = oldSingle && nextRoots.some((root) => canonicalForCompare(root, platform, canonicalizeRoot) === canonicalForCompare(oldSingle, platform, canonicalizeRoot))
        ? input.workspaceRoot
        : null;
    }
  } else if (selectedRoots !== undefined && selectedRoots !== null) {
    if (!Array.isArray(selectedRoots) || selectedRoots.length > 0) {
      throw new FilesystemScopeInstallError('os_user_scope must not receive selected roots', { phase: 'scope_binding' });
    }
  }

  // This is the only persisted scope selector. Existing roots and unrelated
  // config remain intact in os_user_scope; no drive/root discovery occurs.
  config.filesystemScope = requestedPolicy;
  const changed = JSON.stringify(config) !== JSON.stringify(input);
  return {
    config,
    changed,
    idempotent: !changed,
    policy: requestedPolicy,
    selectedRootCount: requestedPolicy === FILESYSTEM_SCOPE_POLICIES.SELECTED_ROOTS ? nextRoots.length : 0,
    rootsChanged: JSON.stringify(nextRoots) !== JSON.stringify(previousRoots),
  };
}

function realpathDirectory(fsImpl, value) {
  const input = String(value || '').trim();
  if (!input) throw new FilesystemScopeInstallError('selected root is required', { phase: 'scope_binding' });
  let real;
  try { real = fsImpl.realpathSync.native ? fsImpl.realpathSync.native(input) : fsImpl.realpathSync(input); }
  catch { throw new FilesystemScopeInstallError('selected root must be an existing directory', { phase: 'scope_binding' }); }
  try {
    if (!fsImpl.statSync(real).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new FilesystemScopeInstallError('selected root must be an existing directory', { phase: 'scope_binding' });
  }
  return real;
}

function parseConfig(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed;
  } catch {
    throw new FilesystemScopeInstallError('Stable Runtime config is not valid JSON', { phase: 'config_parse' });
  }
}

function writeTextAtomic(fsImpl, filename, text) {
  fsImpl.mkdirSync(path.dirname(filename), { recursive: true });
  const tmp = `${filename}.tmp-${process.pid}-${Date.now()}`;
  try {
    fsImpl.writeFileSync(tmp, text, 'utf8');
    fsImpl.renameSync(tmp, filename);
  } finally {
    try { if (fsImpl.existsSync(tmp)) fsImpl.unlinkSync(tmp); } catch {}
  }
}

function sanitizedActivation(activation) {
  const evidence = activation?.evidence || {};
  return {
    status: activation?.status || null,
    sha: activation?.sha || null,
    alreadyActive: activation?.alreadyActive === true,
    readiness: {
      healthStatus: evidence.healthz?.status || null,
      readyStatus: evidence.readyz?.status || null,
      loopback: evidence.readyz?.loopback === true,
      hasAllowedRoots: evidence.readyz?.hasAllowedRoots === true,
      tunnelOk: evidence.tunnel?.ok === true,
      tunnelStatus: Number.isInteger(evidence.tunnel?.status) ? evidence.tunnel.status : null,
    },
    tunnelLifecycle: activation?.tunnelLifecycle || null,
  };
}

export class FilesystemScopeInstaller {
  constructor({
    fsImpl = fs,
    platform = process.platform,
    probeCurrent,
    activateTarget,
  } = {}) {
    if (typeof probeCurrent !== 'function') throw new Error('probeCurrent callback is required');
    if (typeof activateTarget !== 'function') throw new Error('activateTarget callback is required');
    this.fs = fsImpl;
    this.platform = platform;
    this.probeCurrent = probeCurrent;
    this.activateTarget = activateTarget;
  }

  async install({ policy, selectedRoots = undefined, configPath, targetSha, repoPath = null } = {}) {
    const target = exactSha(targetSha, 'target SHA');
    const absoluteConfigPath = path.resolve(String(configPath || ''));
    if (!configPath || !this.fs.existsSync(absoluteConfigPath)) {
      throw new FilesystemScopeInstallError('existing Stable Runtime config file is required', { phase: 'profile_binding' });
    }

    const originalText = this.fs.readFileSync(absoluteConfigPath, 'utf8');
    const originalConfig = parseConfig(originalText);
    const requestedPolicy = policy === undefined || policy === null
      ? configuredPolicy(originalConfig)
      : policyValue(policy);
    const previous = await this.probeCurrent({ configPath: absoluteConfigPath, repoPath });
    const previousSha = exactSha(previous?.sha, 'previous serving revision');
    if (requestedPolicy === FILESYSTEM_SCOPE_POLICIES.SELECTED_ROOTS && selectedRoots !== undefined && !Array.isArray(selectedRoots)) {
      throw new FilesystemScopeInstallError('selected_roots policy requires an array of selected roots', { phase: 'scope_binding' });
    }
    const canonicalRoots = requestedPolicy === FILESYSTEM_SCOPE_POLICIES.SELECTED_ROOTS
      ? (selectedRoots === undefined
        ? undefined
        : selectedRoots.map((entry) => realpathDirectory(this.fs, entry)))
      : selectedRoots;
    const prepared = applyFilesystemScopePolicy(originalConfig, {
      policy: requestedPolicy,
      selectedRoots: canonicalRoots,
      platform: this.platform,
      canonicalizeRoot: (value) => {
        try { return this.fs.realpathSync.native ? this.fs.realpathSync.native(value) : this.fs.realpathSync(value); }
        catch { return value; }
      },
    });

    if (!prepared.changed) {
      return {
        status: 'PASS',
        operation: 'filesystem_scope_update',
        filesystemScope: prepared.policy,
        selectedRootCount: prepared.selectedRootCount,
        configChanged: false,
        idempotent: true,
        previousSha,
        activation: { status: 'PASS', sha: previousSha, alreadyActive: true },
      };
    }

    writeTextAtomic(this.fs, absoluteConfigPath, `${JSON.stringify(prepared.config, null, 2)}\n`);
    try {
      const activation = await this.activateTarget({
        targetSha: target,
        configPath: absoluteConfigPath,
        repoPath,
        forceRestart: true,
      });
      if (activation?.alreadyActive === true) {
        throw new FilesystemScopeInstallError(
          'filesystem scope update requires a forced runtime reload that proves the updated profile was loaded',
          { phase: 'activate_updated_profile' },
        );
      }
      return {
        status: 'PASS',
        operation: 'filesystem_scope_update',
        filesystemScope: prepared.policy,
        selectedRootCount: prepared.selectedRootCount,
        configChanged: true,
        idempotent: false,
        previousSha,
        activation: sanitizedActivation(activation),
      };
    } catch (error) {
      writeTextAtomic(this.fs, absoluteConfigPath, originalText);
      let rollback = { status: 'not_attempted', sha: previousSha };
      try {
        const restored = await this.activateTarget({
          targetSha: previousSha,
          configPath: absoluteConfigPath,
          repoPath,
          forceRestart: true,
        });
        rollback = { status: 'restored', sha: previousSha, activation: sanitizedActivation(restored) };
      } catch {
        rollback = { status: 'failed', sha: previousSha };
      }
      const causePhase = error instanceof FilesystemScopeInstallError
        ? (error.details?.phase || 'activate_updated_profile')
        : (error?.details?.phase || 'activate_updated_profile');
      throw new FilesystemScopeInstallError('filesystem scope activation failed', {
        phase: 'activate_updated_profile',
        causePhase,
        rollback,
      });
    }
  }
}

export const applyExactFilesystemScopePolicy = applyFilesystemScopePolicy;
