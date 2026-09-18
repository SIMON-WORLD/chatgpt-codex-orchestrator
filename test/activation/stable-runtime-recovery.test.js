import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  StableRuntimeRecoveryCoordinator,
  StableRuntimeRecoveryError,
} from '../../host/stable-runtime-recover.mjs';
import {
  StableRuntimeActivationError,
  stableProfileFingerprint,
} from '../../src/activation/stable-runtime-activator.js';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-recovery-test-'));
  const repo = path.join(root, 'repo');
  const activationRoot = path.join(root, 'repo-runtime-activations');
  const checkout = path.join(activationRoot, SHA);
  const configPath = path.join(root, 'stable.json');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(checkout, { recursive: true });
  fs.writeFileSync(configPath, '{}\n');
  const config = {
    host: '127.0.0.1',
    port: 8745,
    dataRoot: path.join(root, 'data'),
    governanceNamespace: 'stable-v02',
    workspaceRoots: [repo],
    worktree: { poolRoot: path.join(root, 'wt'), trustedRepos: [repo] },
    codex: {
      bin: 'codex', listen: 'stdio://', cwd: null, runtimeProfile: path.join(root, 'codex-profile'),
      caBundle: null, sslCertFile: null, spawnArgs: null, extraArgs: [],
    },
    tunnel: {
      external: true,
      clientExecutable: null,
      profile: null,
      profileFile: null,
      profileDir: null,
      localMcpUrl: 'http://127.0.0.1:8745/mcp',
      healthUrl: 'http://127.0.0.1:8081/readyz',
      spawnArgs: null,
    },
  };
  return { root, repo, activationRoot, checkout, configPath, config };
}

function makeActivator({ config, repo, checkout, runtime = 'down', pids = null, onValidateTarget = null } = {}) {
  let runtimeState = runtime;
  const calls = { prepare: 0, spawnRuntime: 0, stopPid: [], validateTarget: [], listPids: 0 };
  const activator = {
    platform: 'win32',
    fs,
    loadConfig: () => config,
    probeJson: async () => ({ ok: false, status: 0, body: null }),
    sleep: async () => {},
    stopPid: (pid) => { calls.stopPid.push(pid); if (pid === 222) runtimeState = 'down'; },
    _requireBoundedProfile: () => {
      const baseUrl = 'http://127.0.0.1:8745';
      if (config.tunnel?.external !== true) {
        throw new StableRuntimeActivationError('activation requires the existing Secure Tunnel lifecycle to remain externally managed', { phase: 'profile_binding' });
      }
      if (!config.tunnel?.healthUrl) {
        throw new StableRuntimeActivationError('activation requires the existing external tunnel healthUrl for readiness proof', { phase: 'profile_binding' });
      }
      const expected = `${baseUrl}/mcp`;
      if (config.tunnel?.localMcpUrl !== expected) {
        throw new StableRuntimeActivationError('Stable Runtime tunnel profile must bind the exact configured local MCP endpoint', {
          phase: 'profile_binding',
          expectedMcpUrl: expected,
          actualMcpUrl: config.tunnel?.localMcpUrl || null,
        });
      }
      return { baseUrl, trusted: [repo] };
    },
    _resolveTrustedRepo: () => repo,
    _validateTarget: async (_repo, sha) => {
      calls.validateTarget.push(sha);
      if (onValidateTarget) return await onValidateTarget(sha);
      return { sha, reachableFromOriginMain: true };
    },
    _prepare: async () => {
      calls.prepare += 1;
      return { checkout, preflight: { revision: SHA, readyForLocalMcp: true } };
    },
    _probeLocal: async () => {
      if (runtimeState === 'exact') {
        return {
          health: { ok: true, status: 200, body: { status: 'ok', revision: SHA } },
          ready: { ok: true, status: 200, body: { status: 'ready', revision: SHA } },
        };
      }
      if (runtimeState === 'wrong') {
        return {
          health: { ok: true, status: 200, body: { status: 'ok', revision: OTHER_SHA } },
          ready: { ok: true, status: 200, body: { status: 'ready', revision: OTHER_SHA } },
        };
      }
      return {
        health: { ok: false, status: 0, body: null },
        ready: { ok: false, status: 0, body: null },
      };
    },
    _listeningPids: async () => {
      calls.listPids += 1;
      if (typeof pids === 'function') return pids(runtimeState);
      if (Array.isArray(pids)) return pids;
      return runtimeState === 'down' ? [] : [111];
    },
    _validateRollbackState: async (state, { fingerprint, configPath }) => {
      if (!state || state.sha !== SHA) return null;
      if (state.profileFingerprint !== fingerprint || state.configPath !== configPath) return null;
      return state;
    },
    spawnRuntime: async () => {
      calls.spawnRuntime += 1;
      runtimeState = 'exact';
      return { pid: 222 };
    },
  };
  return { activator, calls, getRuntimeState: () => runtimeState };
}

test('cold-starts exact runtime and only verifies externally managed tunnel readiness', async () => {
  const { repo, checkout, configPath, config } = fixture();
  const { activator, calls } = makeActivator({ config, repo, checkout, runtime: 'down', pids: (state) => state === 'down' ? [] : [222] });
  let runCalls = 0;
  let tunnelStarts = 0;
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    run: async () => { runCalls += 1; throw new Error('tunnel doctor must not run'); },
    probeJson: async (url) => {
      assert.equal(url, config.tunnel.healthUrl);
      return { ok: true, status: 200, body: { status: 'ready' } };
    },
    spawnTunnel: async () => { tunnelStarts += 1; return { pid: 333, stop() {} }; },
    sleep: async () => {},
  });

  const result = await coordinator.recover({ targetSha: SHA, configPath, repoPath: repo });
  assert.equal(result.status, 'PASS');
  assert.equal(result.sha, SHA);
  assert.equal(result.runtime.action, 'started');
  assert.equal(result.runtime.pid, 222);
  assert.deepEqual(result.tunnel, { action: 'reused', status: 200 });
  assert.deepEqual(result.tunnelPreflight, {
    mode: 'external-readiness-only',
    checkedLocalMcpUrl: config.tunnel.localMcpUrl,
  });
  assert.equal(result.evidence.healthz.revision, SHA);
  assert.equal(result.evidence.readyz.revision, SHA);
  assert.equal(result.evidence.tunnel.status, 200);
  assert.equal(calls.prepare, 1);
  assert.equal(calls.spawnRuntime, 1);
  assert.equal(runCalls, 0);
  assert.equal(tunnelStarts, 0);
});

test('retry reuses one exact runtime and one ready external tunnel without spawning duplicates', async () => {
  const { repo, checkout, configPath, config } = fixture();
  const { activator, calls } = makeActivator({ config, repo, checkout, runtime: 'exact', pids: [111] });
  let tunnelStarts = 0;
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    probeJson: async () => ({ ok: true, status: 200, body: { status: 'ready' } }),
    spawnTunnel: async () => { tunnelStarts += 1; return { pid: 333, stop() {} }; },
    sleep: async () => {},
  });

  const result = await coordinator.recover({ targetSha: SHA, configPath, repoPath: repo });
  assert.equal(result.status, 'PASS');
  assert.equal(result.runtime.action, 'reused');
  assert.equal(result.runtime.pid, 111);
  assert.equal(result.tunnel.action, 'reused');
  assert.equal(calls.prepare, 0);
  assert.equal(calls.spawnRuntime, 0);
  assert.equal(tunnelStarts, 0);
});

test('wrong healthy runtime revision fails closed without stopping or starting any process', async () => {
  const { repo, checkout, configPath, config } = fixture();
  const { activator, calls } = makeActivator({ config, repo, checkout, runtime: 'wrong', pids: [111] });
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    probeJson: async () => ({ ok: true, status: 200 }),
    sleep: async () => {},
  });

  await assert.rejects(
    () => coordinator.recover({ targetSha: SHA, configPath, repoPath: repo }),
    (error) => error instanceof StableRuntimeRecoveryError && error.details.phase === 'runtime_conflict',
  );
  assert.deepEqual(calls.stopPid, []);
  assert.equal(calls.spawnRuntime, 0);
});

test('ambiguous listener fails closed without broad process kill', async () => {
  const { repo, checkout, configPath, config } = fixture();
  const { activator, calls } = makeActivator({ config, repo, checkout, runtime: 'down', pids: [111, 222] });
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    probeJson: async () => ({ ok: true, status: 200 }),
    sleep: async () => {},
  });

  await assert.rejects(
    () => coordinator.recover({ targetSha: SHA, configPath, repoPath: repo }),
    (error) => error instanceof StableRuntimeRecoveryError && error.details.phase === 'runtime_conflict',
  );
  assert.deepEqual(calls.stopPid, []);
  assert.equal(calls.spawnRuntime, 0);
});

test('omitted target uses only a validated exact same-profile last-active state', async () => {
  const { repo, activationRoot, checkout, configPath, config } = fixture();
  const statePath = path.join(activationRoot, 'stable-runtime-active.json');
  fs.mkdirSync(activationRoot, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    sha: SHA,
    checkout,
    pid: 999,
    configPath,
    profileFingerprint: stableProfileFingerprint(config),
    activatedAt: '2026-09-17T00:00:00.000Z',
  }));
  const { activator, calls } = makeActivator({ config, repo, checkout, runtime: 'exact', pids: [111] });
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    probeJson: async () => ({ ok: true, status: 200, body: { status: 'ready' } }),
    sleep: async () => {},
  });

  const result = await coordinator.recover({ configPath, repoPath: repo });
  assert.equal(result.sha, SHA);
  assert.deepEqual(calls.validateTarget, [SHA]);
});

test('omitted target fails closed when last-active state cannot be validated', async () => {
  const { repo, checkout, configPath, config } = fixture();
  const { activator } = makeActivator({ config, repo, checkout, runtime: 'down' });
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    probeJson: async () => ({ ok: true, status: 200 }),
    sleep: async () => {},
  });

  await assert.rejects(
    () => coordinator.recover({ configPath, repoPath: repo }),
    (error) => error instanceof StableRuntimeRecoveryError && error.details.phase === 'target_binding',
  );
});

test('external tunnel local MCP binding drift fails at profile binding without doctor or launch', async () => {
  const { repo, checkout, configPath, config } = fixture();
  config.tunnel.localMcpUrl = 'http://127.0.0.1:8765/mcp';
  const { activator } = makeActivator({ config, repo, checkout, runtime: 'exact', pids: [111] });
  let runCalls = 0;
  let tunnelStarts = 0;
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    run: async () => { runCalls += 1; return { code: 0, stdout: '{}', stderr: '' }; },
    probeJson: async () => ({ ok: true, status: 200 }),
    spawnTunnel: async () => { tunnelStarts += 1; return { pid: 333, stop() {} }; },
  });

  await assert.rejects(
    () => coordinator.recover({ targetSha: SHA, configPath, repoPath: repo }),
    (error) => error instanceof StableRuntimeRecoveryError && error.details.phase === 'profile_binding',
  );
  assert.equal(runCalls, 0);
  assert.equal(tunnelStarts, 0);
});

test('external tunnel readiness failure after starting runtime cleans up only that runtime', async () => {
  const { repo, checkout, configPath, config } = fixture();
  const { activator, calls } = makeActivator({ config, repo, checkout, runtime: 'down', pids: (state) => state === 'down' ? [] : [222] });
  let tunnelStarts = 0;
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    probeJson: async () => ({ ok: false, status: 0, body: null }),
    spawnTunnel: async () => { tunnelStarts += 1; return { pid: 333, stop() {} }; },
    sleep: async () => {},
  });

  await assert.rejects(
    () => coordinator.recover({ targetSha: SHA, configPath, repoPath: repo }),
    (error) => error instanceof StableRuntimeRecoveryError && error.details.phase === 'tunnel_readiness',
  );
  assert.deepEqual(calls.stopPid, [222]);
  assert.equal(tunnelStarts, 0);
});

test('target validation failure remains fail-closed and does not prepare or start runtime', async () => {
  const { repo, checkout, configPath, config } = fixture();
  const { activator, calls } = makeActivator({
    config, repo, checkout, runtime: 'down',
    onValidateTarget: async () => { throw new StableRuntimeActivationError('target unavailable', { phase: 'target_binding' }); },
  });
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    probeJson: async () => ({ ok: true, status: 200 }),
    sleep: async () => {},
  });

  await assert.rejects(
    () => coordinator.recover({ targetSha: SHA, configPath, repoPath: repo }),
    (error) => error instanceof StableRuntimeRecoveryError && error.details.phase === 'target_binding',
  );
  assert.equal(calls.prepare, 0);
  assert.equal(calls.spawnRuntime, 0);
});
