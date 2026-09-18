import fs from 'node:fs';
import path from 'node:path';

const EXACT_SHA_RE = /^[0-9a-f]{40}$/i;

export class AuthorizedWorkspaceRootInstallError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AuthorizedWorkspaceRootInstallError';
    this.details = details;
  }
}

function pathApi(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function normalizeForCompare(value, platform = process.platform) {
  const api = pathApi(platform);
  const normalized = api.resolve(String(value));
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function exactSha(value, label) {
  const sha = String(value || '').trim().toLowerCase();
  if (!EXACT_SHA_RE.test(sha)) {
    throw new AuthorizedWorkspaceRootInstallError(`${label} must be an exact 40-hex commit SHA`, {
      phase: 'target_binding',
    });
  }
  return sha;
}

function realpathDirectory(fsImpl, value) {
  const input = String(value || '').trim();
  if (!input) {
    throw new AuthorizedWorkspaceRootInstallError('authorized workspace root is required', {
      phase: 'workspace_root_binding',
    });
  }

  let real;
  try {
    real = fsImpl.realpathSync.native ? fsImpl.realpathSync.native(input) : fsImpl.realpathSync(input);
  } catch {
    throw new AuthorizedWorkspaceRootInstallError('authorized workspace root must be an existing directory', {
      phase: 'workspace_root_binding',
    });
  }

  let stat;
  try { stat = fsImpl.statSync(real); }
  catch {
    throw new AuthorizedWorkspaceRootInstallError('authorized workspace root must be an existing directory', {
      phase: 'workspace_root_binding',
    });
  }
  if (!stat.isDirectory()) {
    throw new AuthorizedWorkspaceRootInstallError('authorized workspace root must be an existing directory', {
      phase: 'workspace_root_binding',
    });
  }
  return real;
}

function parseConfig(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed;
  } catch {
    throw new AuthorizedWorkspaceRootInstallError('Stable Runtime config is not valid JSON', {
      phase: 'config_parse',
    });
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

export function applyExactAuthorizedWorkspaceRoot(
  input,
  canonicalRoot,
  { platform = process.platform } = {},
) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AuthorizedWorkspaceRootInstallError('Stable Runtime config must be a JSON object', {
      phase: 'config_parse',
    });
  }
  if (typeof canonicalRoot !== 'string' || !canonicalRoot.trim()) {
    throw new AuthorizedWorkspaceRootInstallError('authorized workspace root is required', {
      phase: 'workspace_root_binding',
    });
  }

  const exactRoot = canonicalRoot.trim();
  const config = JSON.parse(JSON.stringify(input));
  const existing = Array.isArray(config.workspaceRoots)
    ? config.workspaceRoots.filter(Boolean).map((entry) => String(entry))
    : [];

  const exactPresent = existing.some(
    (entry) => normalizeForCompare(entry, platform) === normalizeForCompare(exactRoot, platform),
  );

  let rootAdded = false;
  if (!exactPresent) {
    config.workspaceRoots = [...existing, exactRoot];
    rootAdded = true;
  }

  const changed = JSON.stringify(config) !== JSON.stringify(input);
  return { config, changed, rootAdded, exactPresent: exactPresent || rootAdded };
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

export class AuthorizedWorkspaceRootInstaller {
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

  async install({ workspaceRootPath, configPath, targetSha, repoPath = null }) {
    const target = exactSha(targetSha, 'target SHA');
    const canonicalRoot = realpathDirectory(this.fs, workspaceRootPath);

    const absoluteConfigPath = path.resolve(String(configPath || ''));
    if (!configPath || !this.fs.existsSync(absoluteConfigPath)) {
      throw new AuthorizedWorkspaceRootInstallError('existing Stable Runtime config file is required', {
        phase: 'profile_binding',
      });
    }

    const originalText = this.fs.readFileSync(absoluteConfigPath, 'utf8');
    const originalConfig = parseConfig(originalText);
    const previous = await this.probeCurrent({ configPath: absoluteConfigPath, repoPath });
    const previousSha = exactSha(previous?.sha, 'previous serving revision');

    const prepared = applyExactAuthorizedWorkspaceRoot(originalConfig, canonicalRoot, {
      platform: this.platform,
    });

    if (prepared.changed) {
      writeTextAtomic(this.fs, absoluteConfigPath, `${JSON.stringify(prepared.config, null, 2)}\n`);
    }

    try {
      const activation = await this.activateTarget({
        targetSha: target,
        configPath: absoluteConfigPath,
        repoPath,
        forceRestart: true,
      });
      if (activation?.alreadyActive === true) {
        throw new AuthorizedWorkspaceRootInstallError(
          'authorized workspace root activation requires a forced runtime reload',
          { phase: 'activate_updated_profile' },
        );
      }

      return {
        status: 'PASS',
        operation: 'authorized_workspace_root_install',
        rootAuthorized: true,
        rootAdded: prepared.rootAdded,
        configChanged: prepared.changed,
        previousSha,
        activation: sanitizedActivation(activation),
      };
    } catch (error) {
      if (prepared.changed) writeTextAtomic(this.fs, absoluteConfigPath, originalText);

      let rollback = { status: 'not_attempted', sha: previousSha };
      try {
        const restored = await this.activateTarget({
          targetSha: previousSha,
          configPath: absoluteConfigPath,
          repoPath,
          forceRestart: true,
        });
        rollback = {
          status: 'restored',
          sha: previousSha,
          activation: sanitizedActivation(restored),
        };
      } catch {
        rollback = { status: 'failed', sha: previousSha };
      }

      const causePhase = error instanceof AuthorizedWorkspaceRootInstallError
        ? (error.details?.phase || 'activate_updated_profile')
        : (error?.details?.phase || 'activate_updated_profile');

      throw new AuthorizedWorkspaceRootInstallError('authorized workspace root activation failed', {
        phase: 'activate_updated_profile',
        causePhase,
        rollback,
      });
    }
  }
}
