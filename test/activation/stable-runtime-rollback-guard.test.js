import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StableRuntimeActivator, StableRuntimeActivationError } from '../../src/activation/stable-runtime-rollback-guard.js';
import { stableProfileFingerprint } from '../../src/activation/stable-runtime-activator.js';

const SHA = 'a'.repeat(40);
const PREVIOUS_SHA = 'b'.repeat(40);

function binding() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-rollback-guard-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const configPath = path.join(root, 'stable.json');
  fs.writeFileSync(configPath, '{}\n');
  const config = {
    host: '127.0.0.1', port: 8745, dataRoot: path.join(root, 'data'), governanceNamespace: 'stable-v02', workspaceRoots: [repo],
    worktree: { poolRoot: path.join(root, 'pool'), trustedRepos: [repo] },
    codex: { runtimeProfile: path.join(root, 'codex-profile'), extraArgs: [] },
    tunnel: { external: true, profile: 'stable-v02', localMcpUrl: 'http://127.0.0.1:8745/mcp', healthUrl: 'http://127.0.0.1:8081/readyz' },
  };
  return { root, repo, configPath, config };
}

test('cutover records a provisional rollback candidate only when serving revision matches exact clean same-profile state', async () => {
  const { root, configPath, config } = binding();
  const checkout = path.join(root, 'previous');
  fs.mkdirSync(checkout, { recursive: true });
  const state = {
    version: 1, sha: PREVIOUS_SHA, checkout, configPath,
    profileFingerprint: stableProfileFingerprint(config),
  };
  const activator = new StableRuntimeActivator({
    platform: 'win32',
    run: async (_file, args) => {
      if (args.includes('rev-parse')) return { code: 0, stdout: `${PREVIOUS_SHA}\n`, stderr: '' };
      if (args.includes('status')) return { code: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
  });
  activator._latestLocalProbe = {
    health: { ok: true, body: { revision: PREVIOUS_SHA } },
    ready: { ok: true, body: { revision: PREVIOUS_SHA } },
  };
  const validated = await activator._validateRollbackState(state, {
    fingerprint: stableProfileFingerprint(config), configPath,
  });
  assert.equal(validated.sha, PREVIOUS_SHA);
  assert.equal(activator.rollbackEvidence.status, 'provisional_safe');
  assert.equal(activator.rollbackEvidence.sha, PREVIOUS_SHA);
  assert.equal(activator.rollbackEvidence.checkout, checkout);
});

test('first-use readiness failure never guesses a previous revision and emits structured no-safe-rollback evidence', async () => {
  const { repo, configPath, config } = binding();
  let oldStopped = false;
  let targetStarted = false;
  let spawnCount = 0;
  const stopped = [];
  const run = async (file, args) => {
    if (args.includes('fetch') || args.includes('merge-base') || args.includes('worktree')) return { code: 0, stdout: '', stderr: '' };
    if (args.includes('rev-parse')) return { code: 0, stdout: `${SHA}\n`, stderr: '' };
    if (args.includes('status')) return { code: 0, stdout: '', stderr: '' };
    if (file === 'npm.cmd') return { code: 0, stdout: '', stderr: '' };
    if (file === process.execPath && args.includes('--oneshot')) return { code: 0, stdout: 'V02_RUNTIME {"readyForLocalMcp":true}\n', stderr: '' };
    if (file === 'netstat.exe') return { code: 0, stdout: oldStopped ? '' : 'TCP 127.0.0.1:8745 0.0.0.0:0 LISTENING 111\r\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const probeJson = async (url) => {
    if (url === config.tunnel.healthUrl) return { ok: true, status: 200, body: { status: 'ready' } };
    if (!targetStarted) return { ok: true, status: 200, body: { status: url.endsWith('/healthz') ? 'ok' : 'ready' } };
    return { ok: true, status: 200, body: { status: url.endsWith('/healthz') ? 'ok' : 'ready' } };
  };
  const activator = new StableRuntimeActivator({
    platform: 'win32', run, probeJson, loadConfig: () => config,
    stopPid: (pid) => { stopped.push(pid); if (pid === 111) oldStopped = true; },
    spawnRuntime: async () => { spawnCount += 1; targetStarted = true; return { pid: 222 }; },
    sleep: async () => {},
  });
  activator._waitForExactReady = async () => { throw new StableRuntimeActivationError('target failed readiness', { phase: 'readiness' }); };

  await assert.rejects(() => activator.activate({ targetSha: SHA, configPath, repoPath: repo }), (error) => {
    assert.equal(error.details.cutoverStarted, true);
    assert.equal(error.details.rollback.attempted, false);
    assert.equal(error.details.rollback.status, 'not_available');
    assert.equal(error.details.rollbackEvidence.status, 'no_safe_rollback');
    assert.equal(error.details.rollbackEvidence.reason, 'no_valid_exact_clean_same_profile_activation_state');
    assert.equal(error.details.rollbackEvidence.healthRevision, null);
    assert.equal(error.details.rollbackEvidence.readyRevision, null);
    return true;
  });
  assert.equal(spawnCount, 1, 'no unproven previous revision may be spawned as rollback');
  assert.deepEqual(stopped, [111, 222]);
});
