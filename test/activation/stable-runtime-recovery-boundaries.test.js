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
  const tunnelExecutable = path.join(root, 'tunnel-client.exe');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(configPath, '{}\n');
  fs.writeFileSync(tunnelExecutable, 'binary-placeholder');
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
      clientExecutable: tunnelExecutable,
      profile: 'stable-v02',
      profileFile: null,
      profileDir: path.join(root, 'profiles'),
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

function doctorOk(config) {
  return {
    code: 0,
    stdout: JSON.stringify({
      result: 'ok',
      checks: [
        { id: 'control_plane_api_key', status: 'pass', summary: 'runtime key reference resolved' },
        { id: 'mcp_server_reachable', status: 'pass', summary: `HTTP 200 from ${config.tunnel.localMcpUrl}` },
      ],
      failed_checks: [],
    }),
    stderr: '',
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

test('exact runtime up with tunnel down starts only the configured external tunnel', async () => {
  const { repo, configPath, config } = fixture();
  const { activator, spawnRuntimeCalls } = exactRuntimeActivator({ config, repo });
  let tunnelReady = false;
  let tunnelStarts = 0;
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    env: {},
    run: async () => doctorOk(config),
    probeJson: async () => tunnelReady
      ? { ok: true, status: 200, body: { status: 'ready' } }
      : { ok: false, status: 0, body: null },
    spawnTunnel: async ({ executable, args }) => {
      tunnelStarts += 1;
      assert.equal(executable, config.tunnel.clientExecutable);
      assert.deepEqual(args, ['run', '--profile', 'stable-v02', '--profile-dir', config.tunnel.profileDir]);
      tunnelReady = true;
      return { pid: 333, stop: () => { tunnelReady = false; } };
    },
    sleep: async () => {},
  });

  const result = await coordinator.recover({ targetSha: SHA, configPath, repoPath: repo });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.runtime, { action: 'reused', pid: 111 });
  assert.deepEqual(result.tunnel, { action: 'started', pid: 333 });
  assert.equal(spawnRuntimeCalls(), 0);
  assert.equal(tunnelStarts, 1);
});

test('missing or rejected tunnel credential reference fails non-secret preflight and never launches tunnel', async () => {
  const { repo, configPath, config } = fixture();
  const { activator } = exactRuntimeActivator({ config, repo });
  let tunnelStarts = 0;
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    env: {},
    run: async () => {
      const error = new Error('tunnel-client exited with code 1');
      error.result = {
        code: 1,
        stdout: JSON.stringify({ result: 'error', failed_checks: ['control_plane_api_key'] }),
        stderr: '',
      };
      throw error;
    },
    probeJson: async () => ({ ok: false, status: 0, body: null }),
    spawnTunnel: async () => { tunnelStarts += 1; return { pid: 333, stop() {} }; },
  });

  await assert.rejects(
    () => coordinator.recover({ targetSha: SHA, configPath, repoPath: repo }),
    (error) => {
      assert.ok(error instanceof StableRuntimeRecoveryError);
      assert.equal(error.details.phase, 'tunnel_preflight');
      assert.deepEqual(error.details.failedChecks, ['control_plane_api_key']);
      assert.equal(JSON.stringify(error.details).includes('CONTROL_PLANE_API_KEY='), false);
      return true;
    },
  );
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

test('reachable-but-not-ready tunnel endpoint refuses duplicate tunnel launch', async () => {
  const { repo, configPath, config } = fixture();
  const { activator } = exactRuntimeActivator({ config, repo });
  let tunnelStarts = 0;
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    env: {},
    run: async () => doctorOk(config),
    probeJson: async () => ({ ok: false, status: 503, body: { status: 'starting' } }),
    spawnTunnel: async () => { tunnelStarts += 1; return { pid: 333, stop() {} }; },
  });

  await assert.rejects(
    () => coordinator.recover({ targetSha: SHA, configPath, repoPath: repo }),
    (error) => error instanceof StableRuntimeRecoveryError && error.details.phase === 'tunnel_conflict',
  );
  assert.equal(tunnelStarts, 0);
});
