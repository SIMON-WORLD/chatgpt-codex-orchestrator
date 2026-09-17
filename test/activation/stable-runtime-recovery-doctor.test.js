import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StableRuntimeRecoveryCoordinator, StableRuntimeRecoveryError } from '../../host/stable-runtime-recover.mjs';

const SHA = 'a'.repeat(40);

test('tunnel doctor requires the exact configured Local MCP URL, not a prefix-containing URL', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-recovery-doctor-'));
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

  const exactLocal = {
    health: { ok: true, status: 200, body: { status: 'ok', revision: SHA } },
    ready: { ok: true, status: 200, body: { status: 'ready', revision: SHA } },
  };
  const activator = {
    platform: 'win32',
    fs,
    loadConfig: () => config,
    probeJson: async () => ({ ok: false, status: 0, body: null }),
    stopPid: () => {},
    _requireBoundedProfile: () => ({ baseUrl: 'http://127.0.0.1:8745', trusted: [repo] }),
    _resolveTrustedRepo: () => repo,
    _validateTarget: async () => ({ sha: SHA, reachableFromOriginMain: true }),
    _probeLocal: async () => exactLocal,
    _listeningPids: async () => [111],
    _validateRollbackState: async () => null,
    _prepare: async () => { throw new Error('must reuse exact runtime'); },
    spawnRuntime: async () => { throw new Error('must not spawn runtime'); },
  };

  let tunnelStarts = 0;
  const coordinator = new StableRuntimeRecoveryCoordinator({
    activator,
    env: {},
    run: async () => ({
      code: 0,
      stdout: JSON.stringify({
        result: 'ok',
        checks: [
          { id: 'mcp_server_reachable', status: 'pass', summary: 'HTTP 200 from http://127.0.0.1:8745/mcp.evil' },
        ],
        failed_checks: [],
      }),
      stderr: '',
    }),
    probeJson: async () => ({ ok: true, status: 200, body: { status: 'ready' } }),
    spawnTunnel: async () => { tunnelStarts += 1; return { pid: 333, stop() {} }; },
  });

  await assert.rejects(
    () => coordinator.recover({ targetSha: SHA, configPath, repoPath: repo }),
    (error) => error instanceof StableRuntimeRecoveryError && error.details.phase === 'tunnel_profile_binding',
  );
  assert.equal(tunnelStarts, 0);
});
