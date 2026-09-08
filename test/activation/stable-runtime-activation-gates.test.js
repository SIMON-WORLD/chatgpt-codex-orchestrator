import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StableRuntimeActivator } from '../../src/activation/stable-runtime-activator.js';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function binding() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-activation-gates-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const configPath = path.join(root, 'stable.json');
  fs.writeFileSync(configPath, '{}\n');
  return {
    repo,
    configPath,
    config: {
      host: '127.0.0.1', port: 8745, dataRoot: path.join(root, 'data'), governanceNamespace: 'stable-v02', workspaceRoots: [repo],
      worktree: { poolRoot: path.join(root, 'pool'), trustedRepos: [repo] },
      codex: { runtimeProfile: path.join(root, 'codex-profile'), extraArgs: [] },
      tunnel: { external: true, profile: 'stable-v02', localMcpUrl: 'http://127.0.0.1:8745/mcp', healthUrl: 'http://127.0.0.1:8081/readyz' },
    },
  };
}

test('exact target validation rejects missing, mismatched, and non-main-reachable revisions', async () => {
  for (const mode of ['missing', 'mismatch', 'not-main']) {
    const activator = new StableRuntimeActivator({ run: async (_file, args) => {
      if (args.includes('fetch')) return { code: 0, stdout: '', stderr: '' };
      if (args.includes('rev-parse')) {
        if (mode === 'missing') throw new Error('unknown revision');
        return { code: 0, stdout: `${mode === 'mismatch' ? OTHER : SHA}\n`, stderr: '' };
      }
      if (args.includes('merge-base')) {
        if (mode === 'not-main') throw new Error('not ancestor');
        return { code: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    } });
    await assert.rejects(() => activator._validateTarget('/trusted/repo', SHA), /missing, mismatched, or not reachable/);
  }
});

test('dependency preparation failure refuses cutover and never stops or starts a process', async () => {
  const { repo, configPath, config } = binding();
  let stopped = 0;
  let started = 0;
  const activator = new StableRuntimeActivator({
    platform: 'win32',
    loadConfig: () => config,
    probeJson: async (url) => ({ ok: true, status: 200, body: { status: url.endsWith('/healthz') ? 'ok' : 'ready' } }),
    stopPid: () => { stopped += 1; },
    spawnRuntime: async () => { started += 1; return { pid: 222 }; },
    run: async (file, args) => {
      if (args.includes('fetch') || args.includes('merge-base') || args.includes('worktree')) return { code: 0, stdout: '', stderr: '' };
      if (args.includes('rev-parse')) return { code: 0, stdout: `${SHA}\n`, stderr: '' };
      if (file === 'npm.cmd') throw new Error('npm ci failed');
      throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
    },
  });
  await assert.rejects(() => activator.activate({ targetSha: SHA, configPath, repoPath: repo }), /npm ci failed/);
  assert.equal(stopped, 0);
  assert.equal(started, 0);
});
