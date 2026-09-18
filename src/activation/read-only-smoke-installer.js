import fs from 'node:fs';
import path from 'node:path';

const EXACT_SHA_RE = /^[0-9a-f]{40}$/i;

export class ReadOnlySmokeInstallError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ReadOnlySmokeInstallError';
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

function containsPath(root, candidate, platform = process.platform) {
  const api = pathApi(platform);
  const rootResolved = api.resolve(String(root));
  const candidateResolved = api.resolve(String(candidate));
  const relative = api.relative(rootResolved, candidateResolved);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative));
}

function safeCanonicalRoot(value, canonicalizeRoot, platform) {
  try {
    return canonicalizeRoot(String(value));
  } catch {
    return pathApi(platform).resolve(String(value));
  }
}

export function applyExactReadOnlySmokeFixture(
  input,
  canonicalFixture,
  {
    platform = process.platform,
    canonicalizeRoot = (value) => value,
  } = {},
) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ReadOnlySmokeInstallError('Stable Runtime config must be a JSON object', { phase: 'config_parse' });
  }
  if (typeof canonicalFixture !== 'string' || !canonicalFixture.trim()) {
    throw new ReadOnlySmokeInstallError('fixture path is required', { phase: 'fixture_binding' });
  }

  const fixture = canonicalFixture.trim();
  const roots = [];
  if (Array.isArray(input.workspaceRoots)) {
    for (const root of input.workspaceRoots) {
      if (root) roots.push(String(root));
    }
  }
  if (input.workspaceRoot) roots.push(String(input.workspaceRoot));

  const covered = roots.some((root) => containsPath(
    safeCanonicalRoot(root, canonicalizeRoot, platform),
    fixture,
    platform,
  ));

  const config = JSON.parse(JSON.stringify(input));
  let rootAdded = false;
  if (!covered) {
    const existing = Array.isArray(config.workspaceRoots)
      ? config.workspaceRoots.filter(Boolean).map((entry) => String(entry))
      : [];
    if (!existing.some((entry) => normalizeForCompare(entry, platform) === normalizeForCompare(fixture, platform))) {
      config.workspaceRoots = [...existing, fixture];
      rootAdded = true;
    }
  }

  const diagnostics = config.diagnostics && typeof config.diagnostics === 'object' && !Array.isArray(config.diagnostics)
    ? { ...config.diagnostics }
    : {};
  diagnostics.localReadOnlyFixture = fixture;
  config.diagnostics = diagnostics;

  const changed = JSON.stringify(config) !== JSON.stringify(input);
  return { config, changed, rootAdded, alreadyCovered: covered };
}

function realpathDirectory(fsImpl, value) {
  const input = String(value || '').trim();
  if (!input) throw new ReadOnlySmokeInstallError('fixture path is required', { phase: 'fixture_binding' });
  let real;
  try {
    real = fsImpl.realpathSync.native ? fsImpl.realpathSync.native(input) : fsImpl.realpathSync(input);
  } catch {
    throw new ReadOnlySmokeInstallError('fixture path must be an existing directory', { phase: 'fixture_binding' });
  }
  let stat;
  try { stat = fsImpl.statSync(real); }
  catch {
    throw new ReadOnlySmokeInstallError('fixture path must be an existing directory', { phase: 'fixture_binding' });
  }
  if (!stat.isDirectory()) {
    throw new ReadOnlySmokeInstallError('fixture path must be an existing directory', { phase: 'fixture_binding' });
  }
  return real;
}

function exactSha(value, label) {
  const sha = String(value || '').trim().toLowerCase();
  if (!EXACT_SHA_RE.test(sha)) {
    throw new ReadOnlySmokeInstallError(`${label} must be an exact 40-hex commit SHA`, { phase: 'target_binding' });
  }
  return sha;
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

function parseConfig(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed;
  } catch {
    throw new ReadOnlySmokeInstallError('Stable Runtime config is not valid JSON', { phase: 'config_parse' });
  }
}

export class ReadOnlySmokeInstaller {
  constructor({
    fsImpl = fs,
    platform = process.platform,
    probeCurrent,
    stopCurrent,
    recoverTarget,
  } = {}) {
    if (typeof probeCurrent !== 'function') throw new Error('probeCurrent callback is required');
    if (typeof stopCurrent !== 'function') throw new Error('stopCurrent callback is required');
    if (typeof recoverTarget !== 'function') throw new Error('recoverTarget callback is required');
    this.fs = fsImpl;
    this.platform = platform;
    this.probeCurrent = probeCurrent;
    this.stopCurrent = stopCurrent;
    this.recoverTarget = recoverTarget;
  }

  async install({ fixturePath, configPath, targetSha, repoPath = null }) {
    const target = exactSha(targetSha, 'target SHA');
    const canonicalFixture = realpathDirectory(this.fs, fixturePath);
    const absoluteConfigPath = path.resolve(String(configPath || ''));
    if (!configPath || !this.fs.existsSync(absoluteConfigPath)) {
      throw new ReadOnlySmokeInstallError('existing Stable Runtime config file is required', { phase: 'profile_binding' });
    }

    const originalText = this.fs.readFileSync(absoluteConfigPath, 'utf8');
    const originalConfig = parseConfig(originalText);
    const previous = await this.probeCurrent({ configPath: absoluteConfigPath, repoPath });
    const previousSha = exactSha(previous?.sha, 'previous serving revision');

    const canonicalizeRoot = (root) => {
      const resolved = path.resolve(String(root));
      if (!this.fs.existsSync(resolved)) return resolved;
      return this.fs.realpathSync.native ? this.fs.realpathSync.native(resolved) : this.fs.realpathSync(resolved);
    };
    const prepared = applyExactReadOnlySmokeFixture(originalConfig, canonicalFixture, {
      platform: this.platform,
      canonicalizeRoot,
    });

    const updatedText = prepared.changed
      ? `${JSON.stringify(prepared.config, null, 2)}\n`
      : originalText;
    if (prepared.changed) writeTextAtomic(this.fs, absoluteConfigPath, updatedText);

    let currentStopped = false;
    try {
      const stopResult = await this.stopCurrent({
        pid: previous?.pid,
        sha: previousSha,
        configPath: absoluteConfigPath,
        repoPath,
      });
      currentStopped = stopResult?.stopped === true;
      if (!currentStopped) {
        throw new ReadOnlySmokeInstallError('fixture installer could not prove that the exact serving runtime stopped', {
          phase: 'stop_current_runtime',
        });
      }

      const recovery = await this.recoverTarget({
        targetSha: target,
        configPath: absoluteConfigPath,
        repoPath,
      });
      if (recovery?.runtime?.action === 'reused') {
        throw new ReadOnlySmokeInstallError(
          'fixture installation requires a restarted runtime that proves the updated profile was loaded',
          { phase: 'activate_updated_profile' },
        );
      }
      return {
        status: 'PASS',
        operation: 'read_only_smoke_install',
        fixtureConfigured: true,
        configChanged: prepared.changed,
        rootAdded: prepared.rootAdded,
        previousSha,
        recovery,
      };
    } catch (error) {
      if (prepared.changed) writeTextAtomic(this.fs, absoluteConfigPath, originalText);
      currentStopped = currentStopped || error?.details?.currentStopped === true;

      if (!currentStopped) {
        throw new ReadOnlySmokeInstallError('read-only smoke fixture activation failed before cutover', {
          phase: 'stop_current_runtime',
          cause: error?.message || String(error),
          rollback: { status: prepared.changed ? 'config_restored_runtime_unchanged' : 'runtime_unchanged' },
        });
      }

      let rollback;
      try {
        const restored = await this.recoverTarget({
          targetSha: previousSha,
          configPath: absoluteConfigPath,
          repoPath,
        });
        rollback = { status: 'restored', sha: previousSha, recovery: restored };
      } catch (rollbackError) {
        rollback = {
          status: 'failed',
          sha: previousSha,
          cause: rollbackError?.message || String(rollbackError),
        };
      }

      const cause = error instanceof ReadOnlySmokeInstallError
        ? error.message
        : (error?.message || String(error));
      throw new ReadOnlySmokeInstallError('read-only smoke fixture activation failed', {
        phase: 'activate_updated_profile',
        cause,
        rollback,
      });
    }
  }
}
