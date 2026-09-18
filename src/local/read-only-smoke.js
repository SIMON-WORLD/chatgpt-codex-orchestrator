import fs from 'node:fs';
import path from 'node:path';

export const READ_ONLY_SMOKE_FIXTURE_NAME = 'read_only_smoke';
export const READ_ONLY_SMOKE_READ_TARGET = 'smoke.txt';
export const READ_ONLY_SMOKE_SEARCH_MARKER = 'READ_ONLY_SMOKE_V1';
export const READ_ONLY_SMOKE_GIT_DIFF_MODE = 'worktree';
export const READ_ONLY_SMOKE_CONTENT = [
  READ_ONLY_SMOKE_SEARCH_MARKER,
  'Disposable shared Local MCP fixture for bounded read/search/git verification.',
  '',
].join('\n');

export class ReadOnlySmokeFixtureError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ReadOnlySmokeFixtureError';
    this.details = details;
  }
}

export function readOnlySmokeFixtureContract() {
  return {
    readTarget: READ_ONLY_SMOKE_READ_TARGET,
    searchMarker: READ_ONLY_SMOKE_SEARCH_MARKER,
    gitDiffMode: READ_ONLY_SMOKE_GIT_DIFF_MODE,
  };
}

function assertDedicatedTopLevel(fsImpl, root) {
  const allowed = new Set(['.git', READ_ONLY_SMOKE_READ_TARGET]);
  const unknown = fsImpl.readdirSync(root).filter((name) => !allowed.has(name));
  if (unknown.length) {
    throw new ReadOnlySmokeFixtureError(
      'smoke fixture directory contains unexpected pre-existing content; refusing initialization',
      { phase: 'fixture_payload_binding', unexpectedEntryCount: unknown.length },
    );
  }
}

function assertOrCreateSentinel(fsImpl, root) {
  const target = path.join(root, READ_ONLY_SMOKE_READ_TARGET);
  if (fsImpl.existsSync(target)) {
    const stat = fsImpl.statSync(target);
    if (!stat.isFile()) {
      throw new ReadOnlySmokeFixtureError('smoke fixture sentinel exists but is not a regular file', {
        phase: 'fixture_payload_binding',
      });
    }
    const existing = fsImpl.readFileSync(target, 'utf8');
    if (existing !== READ_ONLY_SMOKE_CONTENT) {
      throw new ReadOnlySmokeFixtureError('smoke fixture sentinel content mismatch; refusing overwrite', {
        phase: 'fixture_payload_binding',
      });
    }
    return { created: false, target };
  }

  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fsImpl.writeFileSync(tmp, READ_ONLY_SMOKE_CONTENT, 'utf8');
    fsImpl.renameSync(tmp, target);
  } finally {
    try { if (fsImpl.existsSync(tmp)) fsImpl.unlinkSync(tmp); } catch {}
  }
  return { created: true, target };
}

export async function initializeReadOnlySmokeFixture(
  root,
  {
    fsImpl = fs,
    runGit,
  } = {},
) {
  if (typeof runGit !== 'function') {
    throw new ReadOnlySmokeFixtureError('bounded git runner is required for smoke fixture initialization', {
      phase: 'fixture_payload_binding',
    });
  }

  const canonical = fsImpl.realpathSync.native ? fsImpl.realpathSync.native(root) : fsImpl.realpathSync(root);
  const stat = fsImpl.statSync(canonical);
  if (!stat.isDirectory()) {
    throw new ReadOnlySmokeFixtureError('smoke fixture root must be an existing directory', {
      phase: 'fixture_payload_binding',
    });
  }

  assertDedicatedTopLevel(fsImpl, canonical);

  const gitDir = path.join(canonical, '.git');
  if (fsImpl.existsSync(gitDir) && !fsImpl.statSync(gitDir).isDirectory()) {
    throw new ReadOnlySmokeFixtureError('smoke fixture .git exists but is not a directory', {
      phase: 'fixture_payload_binding',
    });
  }

  let gitInitialized = false;
  if (!fsImpl.existsSync(gitDir)) {
    try {
      await runGit(['init', '--quiet'], { cwd: canonical });
      gitInitialized = true;
    } catch (error) {
      throw new ReadOnlySmokeFixtureError('failed to initialize smoke fixture git repository', {
        phase: 'fixture_payload_init',
        cause: error?.message || String(error),
      });
    }
  }

  const sentinel = assertOrCreateSentinel(fsImpl, canonical);

  try {
    await runGit(['add', '-N', '--', READ_ONLY_SMOKE_READ_TARGET], { cwd: canonical });
  } catch (error) {
    throw new ReadOnlySmokeFixtureError('failed to establish deterministic smoke fixture worktree diff', {
      phase: 'fixture_payload_init',
      cause: error?.message || String(error),
    });
  }

  return {
    root: canonical,
    gitInitialized,
    sentinelCreated: sentinel.created,
    contract: readOnlySmokeFixtureContract(),
  };
}
