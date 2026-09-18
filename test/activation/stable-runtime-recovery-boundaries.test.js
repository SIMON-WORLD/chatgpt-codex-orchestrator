import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StableRuntimeRecoveryCoordinator, StableRuntimeRecoveryError } from '../../host/stable-runtime-recover.mjs';
import { StableRuntimeActivationError } from '../../src/activation/stable-runtime-activator.js';

const SHA = 'a'.repeat(40);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-recovery-boundary-'));
  const repo = path.join(root, 'repo');
  const configPath = path.join(root, 'stable.json');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(configPath, '{}\n');
  const config = {
    host: '127.0.0.1',
    port: 8745,
    dataRoot: path.join(root, 'data'),
    governanceNamespace: 'stable-v02',
    workspaceRoots: [repo],
    worktree: { poolRoot: path.join(root, 'wt'), trustedRepos: [repo] },
    codex: { bin: 'codex', runtimeProfile: path.join(root, 'codex-home'), extraArgs: [] },
    tunnel: {
      external: true,
      clientExecutable: null,
      profile: null,
      profileFile: null,
      profileDir: null,
      localMcpUrl: 'http://127.0.0.1:8745/mcp',
      healthUrl: 'http://127.0.0.1:8081/readyz',
    },
  };
  return { root, repo, configPath, config };
}

function exactLocal() {
  return {
    health: { ok: true, status: 200, body: { status: 'ok', revision: SHA } },
    ready: { ok: true, status: 200, body: { status: 'ready', revision: SHA } },
  };
}

function exactRuntimeActivator({ config, repo, resolveRepo = null } = {}) {
  let spawnRuntimeCalls = 0;
  return {
    activator: {
      platform: 'win32',
      fs,
      loadConfig: () => config,
      probeJson: async () => ({ ok: false, status: 0, body: null }),
      stopPid: () => {},
      _requireBoundedProfile: () => ({ baseUrl: 'http://127.0.0.1:8745', trusted: [repo] }),
      _resolveTrustedRepo: (_config, requested) => resolveRepo ? resolveRepo(requested) : repo,
      _validateTarget: async () => ({ sha: SHA, reachableFromOriginMain: true }),
      _probeLocal: async () => exactLocal(),
      _listeningPids: async () => [111],
      _validateRollbackState: async () => null,
      _prepare: async () => { throw new Error('exact runtime must be reused'); },
      spawnRuntime: async () => { spawnRuntimeCalls += 1; return { pid: 222 }; },
    },
    spawnRuntimeCalls: () => spawnRuntimeCalls,
  };
}

test('critical binding environment override fails before config loading or process inspection', async () => {
  const { repo, configPath } = fixture();
  let loaded = 0;
  const activator = {
    fs,
    loadConfig: () => { loaded += 1; throw new Error('must not load'); },
  };
  const coordinator = new StableRuntimeRecoveryCoordinator({ activator, env: { V02_PORT: '9999' } });

  await assert.rejects(
    () => coordinator.recover({ targetSha: SHA, configPath, repoPath: repo }),
    (error) => {
      assert.ok(error instanceof StableRuntimeRecoveryError);
      assert.equal(error.details.phase, 'profile_binding');
      assert.deepEqual(error.details.envOverrides, ['V02_PORT']);
      return true;
    },
  );
  assert.equal(loaded, 0);
});

test('external tunnel down fails closed and recovery never tries to launch it', async () => {
  const { repo, configPath, config } = fixture();
  const { activator, spawnRuntimeCalls } = exactRuntimeActivator({ config, repo });
  let tunnelStarts = 0;
  let runCalls = 0;
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    env: {},
    run: async () => { runCalls += 1; throw new Error('doctor must not run'); },
    probeJson: async () => ({ ok: false, status: 0, body: null }),
    spawnTunnel: async () => { tunnelStarts += 1; return { pid: 333, stop() {} }; },
    sleep: async () => {},
  });

  await assert.rejects(
    () => coordinator.recover({ targetSha: SHA, configPath, repoPath: repo }),
    (error) => error instanceof StableRuntimeRecoveryError && error.details.phase === 'tunnel_readiness',
  );
  assert.equal(spawnRuntimeCalls(), 0);
  assert.equal(tunnelStarts, 0);
  assert.equal(runCalls, 0);
});

test('external ready recovery requires no tunnel executable/profile/doctor and reuses readiness only', async () => {
  const { repo, configPath, config } = fixture();
  const { activator } = exactRuntimeActivator({ config, repo });
  let tunnelStarts = 0;
  let runCalls = 0;
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    env: {},
    run: async () => { runCalls += 1; throw new Error('doctor must not run'); },
    probeJson: async () => ({ ok: true, status: 200, body: { status: 'ready' } }),
    spawnTunnel: async () => { tunnelStarts += 1; return { pid: 333, stop() {} }; },
  });

  const result = await coordinator.recover({ targetSha: SHA, configPath, repoPath: repo });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.tunnel, { action: 'reused', status: 200 });
  assert.deepEqual(result.tunnelPreflight, {
    mode: 'external-readiness-only',
    checkedLocalMcpUrl: config.tunnel.localMcpUrl,
  });
  assert.equal(runCalls, 0);
  assert.equal(tunnelStarts, 0);
});

test('untrusted or stale requested repo binding fails closed before target validation', async () => {
  const { repo, configPath, config } = fixture();
  let targetValidations = 0;
  const { activator } = exactRuntimeActivator({
    config,
    repo,
    resolveRepo: () => { throw new StableRuntimeActivationError('selected repository is not bound by the Stable Runtime profile', { phase: 'profile_binding' }); },
  });
  activator._validateTarget = async () => { targetValidations += 1; return { sha: SHA }; };
  const coordinator = new StableRuntimeRecoveryCoordinator({ activator, env: {} });

  await assert.rejects(
    () => coordinator.recover({ targetSha: SHA, configPath, repoPath: path.join(repo, '..', 'stale-copy') }),
    (error) => error instanceof StableRuntimeRecoveryError && error.details.phase === 'profile_binding',
  );
  assert.equal(targetValidations, 0);
});

test('reachable-but-not-ready external tunnel fails readiness and is never restarted by recovery', async () => {
  const { repo, configPath, config } = fixture();
  const { activator } = exactRuntimeActivator({ config, repo });
  let tunnelStarts = 0;
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    env: {},
    probeJson: async () => ({ ok: false, status: 503, body: { status: 'starting' } }),
    spawnTunnel: async () => { tunnelStarts += 1; return { pid: 333, stop() {} }; },
  });

  await assert.rejects(
    () => coordinator.recover({ targetSha: SHA, configPath, repoPath: repo }),
    (error) => error instanceof StableRuntimeRecoveryError
      && error.details.phase === 'tunnel_readiness'
      && error.details.status === 503,
  );
  assert.equal(tunnelStarts, 0);
});
