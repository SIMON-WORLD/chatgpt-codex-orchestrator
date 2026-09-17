import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  StableRuntimeRecoveryCoordinator,
  StableRuntimeRecoveryError,
  recoveryFailurePayload,
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
      clientExecutable: path.join(root, 'tunnel-client.exe'),
      profile: 'stable-v02',
      profileFile: null,
      profileDir: path.join(root, 'profiles'),
      localMcpUrl: 'http://127.0.0.1:8745/mcp',
      healthUrl: 'http://127.0.0.1:8081/readyz',
      spawnArgs: null,
    },
  };
  fs.writeFileSync(config.tunnel.clientExecutable, 'binary-placeholder');
  return { root, repo, activationRoot, checkout, configPath, config };
}

function doctorOk(url = 'http://127.0.0.1:8745/mcp') {
  return {
    code: 0,
    stdout: JSON.stringify({
      result: 'ok',
      checks: [
        { id: 'profile_load', status: 'pass', summary: 'profile stable-v02 loaded' },
        { id: 'control_plane_api_key', status: 'pass', summary: 'runtime key reference resolved' },
        { id: 'mcp_server_reachable', status: 'pass', summary: `HTTP 200 from ${url}` },
      ],
      failed_checks: [],
    }),
    stderr: '',
  };
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
    _requireBoundedProfile: () => ({ baseUrl: 'http://127.0.0.1:8745', trusted: [repo] }),
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

test('both-down recovery cold-starts exact runtime, validates tunnel profile, starts tunnel, and proves joint READY', async () => {
  const { repo, checkout, configPath, config } = fixture();
  const { activator, calls } = makeActivator({ config, repo, checkout, runtime: 'down', pids: (state) => state === 'down' ? [] : [222] });
  let tunnelReady = false;
  let tunnelStarts = 0;
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    run: async (file, args) => {
      assert.equal(file, config.tunnel.clientExecutable);
      assert.deepEqual(args, ['doctor', '--profile', 'stable-v02', '--profile-dir', config.tunnel.profileDir, '--json']);
      return doctorOk();
    },
    probeJson: async (url) => {
      assert.equal(url, config.tunnel.healthUrl);
      return tunnelReady ? { ok: true, status: 200, body: { status: 'ready' } } : { ok: false, status: 0, body: null };
    },
    spawnTunnel: async ({ executable, args, env }) => {
      tunnelStarts += 1;
      assert.equal(executable, config.tunnel.clientExecutable);
      assert.deepEqual(args, ['run', '--profile', 'stable-v02', '--profile-dir', config.tunnel.profileDir]);
      assert.equal(env.CONTROL_PLANE_API_KEY, undefined, 'coordinator must not synthesize raw credentials');
      tunnelReady = true;
      return { pid: 333, stop: () => { tunnelReady = false; } };
    },
    sleep: async () => {},
  });

  const result = await coordinator.recover({ targetSha: SHA, configPath, repoPath: repo });
  assert.equal(result.status, 'PASS');
  assert.equal(result.sha, SHA);
  assert.equal(result.runtime.action, 'started');
  assert.equal(result.runtime.pid, 222);
  assert.equal(result.tunnel.action, 'started');
  assert.equal(result.tunnel.pid, 333);
  assert.equal(result.evidence.healthz.revision, SHA);
  assert.equal(result.evidence.readyz.revision, SHA);
  assert.equal(result.evidence.tunnel.status, 200);
  assert.equal(calls.prepare, 1);
  assert.equal(calls.spawnRuntime, 1);
  assert.equal(tunnelStarts, 1);
});

test('retry reuses one exact runtime and one ready tunnel without spawning duplicates', async () => {
  const { repo, checkout, configPath, config } = fixture();
  const { activator, calls } = makeActivator({ config, repo, checkout, runtime: 'exact', pids: [111] });
  let tunnelStarts = 0;
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    run: async () => doctorOk(),
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
  const coordinator = new StableRuntimeRecoveryCoordinator({ activator, run: async () => doctorOk(), probeJson: async () => ({ ok: false, status: 0 }), sleep: async () => {} });

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
  const coordinator = new StableRuntimeRecoveryCoordinator({ activator, run: async () => doctorOk(), probeJson: async () => ({ ok: false, status: 0 }), sleep: async () => {} });

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
    run: async () => doctorOk(),
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
  const coordinator = new StableRuntimeRecoveryCoordinator({ activator, run: async () => doctorOk(), probeJson: async () => ({ ok: false, status: 0 }), sleep: async () => {} });

  await assert.rejects(
    () => coordinator.recover({ configPath, repoPath: repo }),
    (error) => error instanceof StableRuntimeRecoveryError && error.details.phase === 'target_binding',
  );
});

test('tunnel doctor profile binding drift fails before tunnel launch', async () => {
  const { repo, checkout, configPath, config } = fixture();
  const { activator } = makeActivator({ config, repo, checkout, runtime: 'exact', pids: [111] });
  let tunnelStarts = 0;
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    run: async () => doctorOk('http://127.0.0.1:8765/mcp'),
    probeJson: async () => ({ ok: false, status: 0, body: null }),
    spawnTunnel: async () => { tunnelStarts += 1; return { pid: 333, stop() {} }; },
    sleep: async () => {},
  });

  await assert.rejects(
    () => coordinator.recover({ targetSha: SHA, configPath, repoPath: repo }),
    (error) => error instanceof StableRuntimeRecoveryError && error.details.phase === 'tunnel_profile_binding',
  );
  assert.equal(tunnelStarts, 0);
});

test('tunnel doctor failure preserves a bounded redacted cause and never emits raw secret values', async () => {
  const { repo, checkout, configPath, config } = fixture();
  const { activator } = makeActivator({ config, repo, checkout, runtime: 'exact', pids: [111] });
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    run: async () => { throw new Error('CONTROL_PLANE_API_KEY=top-secret-value is missing or rejected'); },
    probeJson: async () => ({ ok: false, status: 0, body: null }),
    sleep: async () => {},
  });

  let thrown;
  try { await coordinator.recover({ targetSha: SHA, configPath, repoPath: repo }); } catch (error) { thrown = error; }
  assert.ok(thrown instanceof StableRuntimeRecoveryError);
  assert.equal(thrown.details.phase, 'tunnel_preflight');
  const payload = recoveryFailurePayload(thrown);
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes('top-secret-value'), false);
  assert.equal(serialized.includes('[REDACTED]'), true);
});

test('tunnel launch failure cleans up only the runtime process started by this recovery attempt', async () => {
  const { repo, checkout, configPath, config } = fixture();
  const { activator, calls } = makeActivator({ config, repo, checkout, runtime: 'down', pids: (state) => state === 'down' ? [] : [222] });
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    run: async () => doctorOk(),
    probeJson: async () => ({ ok: false, status: 0, body: null }),
    spawnTunnel: async () => { throw new Error('launch failed'); },
    sleep: async () => {},
  });

  await assert.rejects(() => coordinator.recover({ targetSha: SHA, configPath, repoPath: repo }), StableRuntimeRecoveryError);
  assert.deepEqual(calls.stopPid, [222]);
});

test('target validation failure remains fail-closed and does not prepare or start runtime', async () => {
  const { repo, checkout, configPath, config } = fixture();
  const { activator, calls } = makeActivator({
    config, repo, checkout, runtime: 'down',
    onValidateTarget: async () => { throw new StableRuntimeActivationError('target unavailable', { phase: 'target_binding' }); },
  });
  const coordinator = new StableRuntimeRecoveryCoordinator({ activator, run: async () => doctorOk(), probeJson: async () => ({ ok: false, status: 0 }), sleep: async () => {} });

  await assert.rejects(
    () => coordinator.recover({ targetSha: SHA, configPath, repoPath: repo }),
    (error) => error instanceof StableRuntimeRecoveryError && error.details.phase === 'target_binding',
  );
  assert.equal(calls.prepare, 0);
  assert.equal(calls.spawnRuntime, 0);
});
