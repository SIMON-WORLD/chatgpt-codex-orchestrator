import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  StableRuntimeActivator,
  StableRuntimeActivationError,
  assertExactCommitSha,
  npmCiCommand,
  parseWindowsListeningPids,
  stableProfileFingerprint,
  stableProfileSnapshot,
} from '../../src/activation/stable-runtime-activator.js';

const SHA = 'a'.repeat(40);
const PREVIOUS_SHA = 'b'.repeat(40);

function makeConfig(repo) {
  return {
    host: '127.0.0.1', port: 8745, dataRoot: 'D:/stable-data', governanceNamespace: 'stable-v02', workspaceRoots: ['E:/src/work'],
    worktree: { poolRoot: 'E:/src/wt', trustedRepos: [repo] },
    codex: { bin: 'codex', listen: 'stdio://', cwd: null, runtimeProfile: 'D:/codex-stable', caBundle: null, sslCertFile: null, spawnArgs: null, extraArgs: [] },
    tunnel: { external: true, clientExecutable: 'tunnel-client.exe', profile: 'stable-v02', profileFile: null, profileDir: 'D:/tunnel', localMcpUrl: 'http://127.0.0.1:8745/mcp', healthUrl: 'http://127.0.0.1:8081/readyz' },
  };
}

function tempBinding() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-activate-test-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const configPath = path.join(root, 'stable.json');
  fs.writeFileSync(configPath, '{}\n');
  return { root, repo, configPath, config: makeConfig(repo) };
}

test('exact target binding requires a full 40-hex commit SHA', () => {
  assert.equal(assertExactCommitSha(SHA.toUpperCase()), SHA);
  for (const invalid of ['', 'main', 'abc123', 'g'.repeat(40), 'a'.repeat(39)]) assert.throws(() => assertExactCommitSha(invalid), StableRuntimeActivationError);
});

test('Stable Runtime profile fingerprint preserves durable/trust/tunnel/Codex bindings', () => {
  const config = makeConfig('E:/src/chatgpt-codex-orchestrator');
  const snapshot = stableProfileSnapshot(config);
  assert.equal(snapshot.dataRoot, 'D:/stable-data');
  assert.equal(snapshot.governanceNamespace, 'stable-v02');
  assert.deepEqual(snapshot.worktree.trustedRepos, ['E:/src/chatgpt-codex-orchestrator']);
  assert.equal(snapshot.codex.runtimeProfile, 'D:/codex-stable');
  assert.equal(snapshot.tunnel.profile, 'stable-v02');
  assert.equal(snapshot.tunnel.localMcpUrl, 'http://127.0.0.1:8745/mcp');
  assert.equal(stableProfileFingerprint(config), stableProfileFingerprint(structuredClone(config)));
});

test('process selection parses only the exact configured Windows listener endpoint', () => {
  const output = [
    'TCP 127.0.0.1:8745 0.0.0.0:0 LISTENING 111',
    'TCP 127.0.0.1:9999 0.0.0.0:0 LISTENING 222',
    'TCP 0.0.0.0:8745 0.0.0.0:0 LISTENING 333',
    'TCP 127.0.0.1:8745 127.0.0.1:50000 ESTABLISHED 444',
  ].join('\r\n');
  assert.deepEqual(parseWindowsListeningPids(output, { host: '127.0.0.1', port: 8745 }), [111]);
});

test('npm ci command uses bounded Windows ComSpec shape and preserves non-Windows behavior', () => {
  const comSpec = 'C:\\Windows\\System32\\cmd.exe';
  assert.deepEqual(npmCiCommand('win32', { ComSpec: comSpec }), {
    file: comSpec,
    args: ['/d', '/s', '/c', 'npm.cmd', 'ci'],
  });
  assert.deepEqual(npmCiCommand('win32', {}), {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', 'npm.cmd', 'ci'],
  });
  assert.deepEqual(npmCiCommand('linux', {}), { file: 'npm', args: ['ci'] });
});

test('target validation fails closed when exact revision is not reachable from origin/main', async () => {
  const activator = new StableRuntimeActivator({ run: async (_file, args) => {
    if (args.includes('fetch')) return { code: 0, stdout: '', stderr: '' };
    if (args.includes('rev-parse')) return { code: 0, stdout: `${SHA}\n`, stderr: '' };
    if (args.includes('merge-base')) throw new Error('not ancestor');
    throw new Error('unexpected');
  } });
  await assert.rejects(() => activator._validateTarget('/repo', SHA), /not reachable from origin\/main/);
});

test('successful activation prepares before exact PID cutover and proves exact revision/readiness', async () => {
  const { repo, configPath, config } = tempBinding();
  const events = [];
  let oldStopped = false;
  let targetStarted = false;
  const run = async (file, args) => {
    events.push(`run:${file}:${args.join(' ')}`);
    if (args.includes('rev-parse')) return { code: 0, stdout: `${SHA}\n`, stderr: '' };
    if (args.includes('status')) return { code: 0, stdout: '', stderr: '' };
    if (file === 'netstat.exe') return { code: 0, stdout: oldStopped ? '' : 'TCP 127.0.0.1:8745 0.0.0.0:0 LISTENING 111\r\n', stderr: '' };
    if (file === process.execPath && args.includes('--oneshot')) return { code: 0, stdout: 'V02_RUNTIME {"readyForLocalMcp":true}\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const probeJson = async (url) => {
    if (url === config.tunnel.healthUrl) return { ok: true, status: 200, body: { status: 'ready' } };
    if (!targetStarted) return { ok: true, status: 200, body: { status: url.endsWith('/healthz') ? 'ok' : 'ready' } };
    return { ok: true, status: 200, body: { status: url.endsWith('/healthz') ? 'ok' : 'ready', revision: SHA } };
  };
  const activator = new StableRuntimeActivator({
    platform: 'win32', run, probeJson, loadConfig: () => config,
    stopPid: (pid) => { events.push(`stop:${pid}`); oldStopped = true; },
    spawnRuntime: async () => { events.push('start:target'); targetStarted = true; return { pid: 222 }; },
    sleep: async () => {}, now: () => '2026-09-08T00:00:00.000Z',
  });
  const result = await activator.activate({ targetSha: SHA, configPath, repoPath: repo });
  assert.equal(result.status, 'PASS');
  assert.equal(result.sha, SHA);
  assert.equal(result.pid, 222);
  assert.equal(result.tunnelLifecycle, 'external-preserved');
  assert.equal(result.evidence.healthz.revision, SHA);
  assert.equal(result.evidence.readyz.revision, SHA);
  const npmCommand = npmCiCommand('win32', process.env);
  const ci = events.findIndex((event) => event === `run:${npmCommand.file}:${npmCommand.args.join(' ')}`);
  const preflight = events.findIndex((event) => event.includes('--oneshot'));
  const stop = events.findIndex((event) => event === 'stop:111');
  assert.ok(ci >= 0 && preflight > ci && stop > preflight, events.join(' | '));
  assert.equal(events.some((event) => /taskkill|node\.exe.*kill|codex.*kill/i.test(event)), false);
});

test('readiness failure restores only a previously recorded exact same-profile activation', async () => {
  const { repo, configPath, config } = tempBinding();
  const activationRoot = path.join(path.dirname(repo), `${path.basename(repo)}-runtime-activations`);
  const previousCheckout = path.join(activationRoot, PREVIOUS_SHA);
  fs.mkdirSync(previousCheckout, { recursive: true });
  fs.writeFileSync(path.join(activationRoot, 'stable-runtime-active.json'), JSON.stringify({
    version: 1, sha: PREVIOUS_SHA, checkout: previousCheckout, pid: 100, configPath,
    profileFingerprint: stableProfileFingerprint(config), activatedAt: 'old',
  }));
  let stoppedOld = false;
  let spawnCount = 0;
  const stopped = [];
  const run = async (file, args) => {
    if (args.includes('rev-parse')) return { code: 0, stdout: `${args[1] === previousCheckout ? PREVIOUS_SHA : SHA}\n`, stderr: '' };
    if (args.includes('status')) return { code: 0, stdout: '', stderr: '' };
    if (file === 'netstat.exe') return { code: 0, stdout: stoppedOld ? '' : 'TCP 127.0.0.1:8745 0.0.0.0:0 LISTENING 111\r\n', stderr: '' };
    if (file === process.execPath && args.includes('--oneshot')) return { code: 0, stdout: 'V02_RUNTIME {"readyForLocalMcp":true}\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const activator = new StableRuntimeActivator({
    platform: 'win32', run,
    probeJson: async (url) => ({ ok: true, status: 200, body: { status: url.endsWith('/healthz') ? 'ok' : 'ready' } }),
    loadConfig: () => config,
    stopPid: (pid) => { stopped.push(pid); if (pid === 111) stoppedOld = true; },
    spawnRuntime: async () => ({ pid: ++spawnCount === 1 ? 222 : 333 }), sleep: async () => {},
  });
  activator._waitForExactReady = async (_config, _baseUrl, sha) => {
    if (sha === SHA) throw new StableRuntimeActivationError('target failed readiness', { phase: 'readiness' });
    return { healthz: { revision: PREVIOUS_SHA }, readyz: { revision: PREVIOUS_SHA }, tunnel: { ok: true } };
  };
  await assert.rejects(() => activator.activate({ targetSha: SHA, configPath, repoPath: repo }), (error) => {
    assert.equal(error.details.rollback.status, 'restored');
    assert.equal(error.details.rollback.sha, PREVIOUS_SHA);
    return true;
  });
  assert.deepEqual(stopped, [111, 222]);
});

test('profile binding rejects non-external tunnel lifecycle or wrong local MCP URL', () => {
  const { repo, config } = tempBinding();
  const activator = new StableRuntimeActivator();
  config.tunnel.external = false;
  assert.throws(() => activator._requireBoundedProfile(config), /externally managed/);
  config.tunnel.external = true;
  config.tunnel.localMcpUrl = 'http://127.0.0.1:9999/mcp';
  assert.throws(() => activator._requireBoundedProfile(config), /exact configured local MCP endpoint/);
  assert.ok(repo);
});
