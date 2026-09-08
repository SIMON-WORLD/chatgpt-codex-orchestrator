import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StableRuntimeActivator, StableRuntimeActivationError, npmCiCommand } from '../../src/activation/stable-runtime-activator.js';

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

function preCutoverRun({ failStep = null } = {}) {
  const npmCommand = npmCiCommand('win32', process.env);
  return async (file, args) => {
    if (args.includes('fetch') || args.includes('merge-base') || args.includes('worktree')) return { code: 0, stdout: '', stderr: '' };
    if (args.includes('rev-parse')) return { code: 0, stdout: `${SHA}\n`, stderr: '' };
    if (file === npmCommand.file && args.join(' ') === npmCommand.args.join(' ')) {
      if (failStep === 'dependency_install') throw new Error('spawn EINVAL');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (file === process.execPath && args.includes('--oneshot')) {
      if (failStep === 'preflight') {
        const error = new Error('node preflight exited with code 1');
        error.result = { code: 1, stdout: '', stderr: 'preflight failed' };
        throw error;
      }
      return { code: 0, stdout: 'V02_RUNTIME {"readyForLocalMcp":true}\n', stderr: '' };
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
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

test('dependency spawn failure is phase prepare and refuses cutover before any stop/start', async () => {
  const { repo, configPath, config } = binding();
  let stopped = 0;
  let started = 0;
  const activator = new StableRuntimeActivator({
    platform: 'win32',
    loadConfig: () => config,
    probeJson: async (url) => ({ ok: true, status: 200, body: { status: url.endsWith('/healthz') ? 'ok' : 'ready' } }),
    stopPid: () => { stopped += 1; },
    spawnRuntime: async () => { started += 1; return { pid: 222 }; },
    run: preCutoverRun({ failStep: 'dependency_install' }),
  });
  await assert.rejects(() => activator.activate({ targetSha: SHA, configPath, repoPath: repo }), (error) => {
    assert.ok(error instanceof StableRuntimeActivationError);
    assert.equal(error.details.phase, 'prepare');
    assert.equal(error.details.step, 'dependency_install');
    assert.equal(error.details.cause, 'spawn EINVAL');
    return true;
  });
  assert.equal(stopped, 0);
  assert.equal(started, 0);
});

test('preflight child-process failure is phase prepare and refuses cutover before any stop/start', async () => {
  const { repo, configPath, config } = binding();
  let stopped = 0;
  let started = 0;
  const activator = new StableRuntimeActivator({
    platform: 'win32',
    loadConfig: () => config,
    probeJson: async (url) => ({ ok: true, status: 200, body: { status: url.endsWith('/healthz') ? 'ok' : 'ready' } }),
    stopPid: () => { stopped += 1; },
    spawnRuntime: async () => { started += 1; return { pid: 222 }; },
    run: preCutoverRun({ failStep: 'preflight' }),
  });
  await assert.rejects(() => activator.activate({ targetSha: SHA, configPath, repoPath: repo }), (error) => {
    assert.ok(error instanceof StableRuntimeActivationError);
    assert.equal(error.details.phase, 'prepare');
    assert.equal(error.details.step, 'preflight');
    assert.equal(error.details.cause, 'node preflight exited with code 1');
    assert.equal(error.details.exitCode, 1);
    return true;
  });
  assert.equal(stopped, 0);
  assert.equal(started, 0);
});
