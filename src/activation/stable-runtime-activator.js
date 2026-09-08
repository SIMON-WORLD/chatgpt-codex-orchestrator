import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadV02Config } from '../config.js';

const EXACT_SHA_RE = /^[0-9a-f]{40}$/i;
const STATE_FILE = 'stable-runtime-active.json';
const PREPARE_CAUSE_LIMIT = 320;

export class StableRuntimeActivationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'StableRuntimeActivationError';
    this.details = details;
  }
}

export function assertExactCommitSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  if (!EXACT_SHA_RE.test(sha)) throw new StableRuntimeActivationError('target SHA must be an exact 40-hex commit SHA', { phase: 'target_binding' });
  return sha;
}

function comparePath(value, platform = process.platform) {
  const normalized = path.resolve(String(value));
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function stableProfileSnapshot(config) {
  return {
    host: config.host,
    port: config.port,
    dataRoot: config.dataRoot,
    governanceNamespace: config.governanceNamespace || 'default',
    workspaceRoots: [...(config.workspaceRoots || [])],
    worktree: {
      poolRoot: config.worktree?.poolRoot || null,
      trustedRepos: [...(config.worktree?.trustedRepos || [])],
    },
    codex: {
      bin: config.codex?.bin || null,
      listen: config.codex?.listen || null,
      cwd: config.codex?.cwd || null,
      runtimeProfile: config.codex?.runtimeProfile || null,
      caBundle: config.codex?.caBundle || null,
      sslCertFile: config.codex?.sslCertFile || null,
      spawnArgs: config.codex?.spawnArgs || null,
      extraArgs: [...(config.codex?.extraArgs || [])],
    },
    tunnel: {
      external: config.tunnel?.external === true,
      clientExecutable: config.tunnel?.clientExecutable || null,
      profile: config.tunnel?.profile || null,
      profileFile: config.tunnel?.profileFile || null,
      profileDir: config.tunnel?.profileDir || null,
      localMcpUrl: config.tunnel?.localMcpUrl || null,
      healthUrl: config.tunnel?.healthUrl || null,
    },
  };
}

export function stableProfileFingerprint(config) {
  return crypto.createHash('sha256').update(JSON.stringify(stableProfileSnapshot(config))).digest('hex');
}

export function deriveActivationRoot(repoPath) {
  const repo = path.resolve(repoPath);
  return path.join(path.dirname(repo), `${path.basename(repo)}-runtime-activations`);
}

export function parseWindowsListeningPids(output, { host, port }) {
  const wantedHost = String(host).toLowerCase();
  const wantedPort = Number(port);
  const pids = new Set();
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts.length < 5 || parts[0]?.toUpperCase() !== 'TCP' || parts[3]?.toUpperCase() !== 'LISTENING') continue;
    const match = parts[1].match(/^\[([^\]]+)\]:(\d+)$/) || parts[1].match(/^(.*):(\d+)$/);
    if (!match) continue;
    if (match[1].toLowerCase() !== wantedHost || Number(match[2]) !== wantedPort) continue;
    const pid = Number(parts[4]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

export function parseV02RuntimeReport(stdout) {
  const line = String(stdout || '').split(/\r?\n/).find((entry) => entry.startsWith('V02_RUNTIME '));
  if (!line) throw new StableRuntimeActivationError('pre-activation runtime sanity check did not emit V02_RUNTIME evidence', { phase: 'prepare' });
  try { return JSON.parse(line.slice('V02_RUNTIME '.length)); }
  catch { throw new StableRuntimeActivationError('pre-activation runtime sanity check emitted invalid V02_RUNTIME evidence', { phase: 'prepare' }); }
}

export function npmCiCommand(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return { file: env?.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npm.cmd', 'ci'] };
  }
  return { file: 'npm', args: ['ci'] };
}

function boundedPrepareCause(error) {
  const value = error?.message || String(error);
  return String(value).replace(/\s+/g, ' ').trim().slice(0, PREPARE_CAUSE_LIMIT);
}

function prepareCommandError(message, step, error) {
  const details = { phase: 'prepare', step, cause: boundedPrepareCause(error) };
  const exitCode = error?.result?.code;
  if (Number.isInteger(exitCode)) details.exitCode = exitCode;
  return new StableRuntimeActivationError(message, details);
}

export async function runCommand(file, args, { cwd = undefined, env = process.env } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      const result = { code: code ?? -1, stdout, stderr };
      if (code === 0) return resolve(result);
      const error = new Error(`${file} exited with code ${code}`);
      error.result = result;
      reject(error);
    });
  });
}

async function defaultProbeJson(url, timeoutMs = 1500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try { body = await response.json(); } catch {}
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: error?.message || String(error) };
  }
}

async function defaultSpawnRuntime({ checkout, configPath, sha, logPath }) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  try {
    const child = spawn(process.execPath, ['scripts/v0.2-start.mjs', '--config', configPath], {
      cwd: checkout,
      env: { ...process.env, V02_BUILD_REVISION: sha },
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', fd, fd],
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    return { pid: child.pid };
  } finally { fs.closeSync(fd); }
}

function baseUrlFor(config) {
  if (config.host !== '127.0.0.1') throw new StableRuntimeActivationError('Stable Runtime activator is intentionally bounded to host 127.0.0.1', { phase: 'profile_binding' });
  const port = Number(config.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new StableRuntimeActivationError('Stable Runtime profile must have a fixed TCP port', { phase: 'profile_binding' });
  return `http://127.0.0.1:${port}`;
}

function readJsonIfPresent(fsImpl, filename) {
  if (!fsImpl.existsSync(filename)) return null;
  try { return JSON.parse(fsImpl.readFileSync(filename, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(fsImpl, filename, value) {
  fsImpl.mkdirSync(path.dirname(filename), { recursive: true });
  const tmp = `${filename}.tmp-${process.pid}-${Date.now()}`;
  fsImpl.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fsImpl.renameSync(tmp, filename);
}

export class StableRuntimeActivator {
  constructor({
    platform = process.platform,
    fsImpl = fs,
    run = runCommand,
    probeJson = defaultProbeJson,
    spawnRuntime = defaultSpawnRuntime,
    stopPid = (pid) => process.kill(pid, 'SIGTERM'),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    loadConfig = (configPath) => loadV02Config({}, { configPath }),
    now = () => new Date().toISOString(),
  } = {}) {
    this.platform = platform;
    this.fs = fsImpl;
    this.run = run;
    this.probeJson = probeJson;
    this.spawnRuntime = spawnRuntime;
    this.stopPid = stopPid;
    this.sleep = sleep;
    this.loadConfig = loadConfig;
    this.now = now;
  }

  _requireBoundedProfile(config) {
    const baseUrl = baseUrlFor(config);
    if (config.tunnel?.external !== true) throw new StableRuntimeActivationError('activation requires the existing Secure Tunnel lifecycle to remain externally managed', { phase: 'profile_binding' });
    if (!config.tunnel?.healthUrl) throw new StableRuntimeActivationError('activation requires the existing external tunnel healthUrl for readiness proof', { phase: 'profile_binding' });
    const expectedMcpUrl = `${baseUrl}/mcp`;
    if (!config.tunnel?.localMcpUrl || String(config.tunnel.localMcpUrl).replace(/\/$/, '') !== expectedMcpUrl) {
      throw new StableRuntimeActivationError('Stable Runtime tunnel profile must bind the exact configured local MCP endpoint', { phase: 'profile_binding', expectedMcpUrl, actualMcpUrl: config.tunnel?.localMcpUrl || null });
    }
    const trusted = config.worktree?.trustedRepos || [];
    if (!trusted.length) throw new StableRuntimeActivationError('Stable Runtime profile must declare at least one trusted canonical repository', { phase: 'profile_binding' });
    return { baseUrl, trusted };
  }

  _resolveTrustedRepo(config, repoPath) {
    const trusted = config.worktree?.trustedRepos || [];
    const selected = repoPath || (trusted.length === 1 ? trusted[0] : null);
    if (!selected) throw new StableRuntimeActivationError('multiple trusted repositories are configured; select one exact trusted repo with --repo', { phase: 'profile_binding' });
    let real;
    try { real = this.fs.realpathSync.native ? this.fs.realpathSync.native(selected) : this.fs.realpathSync(selected); }
    catch { throw new StableRuntimeActivationError('trusted canonical repository does not exist', { phase: 'profile_binding', repo: path.resolve(selected) }); }
    const allowed = trusted.map((entry) => {
      try { return this.fs.realpathSync.native ? this.fs.realpathSync.native(entry) : this.fs.realpathSync(entry); }
      catch { return path.resolve(entry); }
    });
    if (!allowed.some((entry) => comparePath(entry, this.platform) === comparePath(real, this.platform))) {
      throw new StableRuntimeActivationError('selected repository is not bound by the Stable Runtime trusted-repo profile', { phase: 'profile_binding', repo: real });
    }
    return real;
  }

  async _validateTarget(repo, sha) {
    try {
      await this.run('git', ['-C', repo, 'fetch', '--quiet', 'origin', 'main']);
      const resolved = (await this.run('git', ['-C', repo, 'rev-parse', `${sha}^{commit}`])).stdout.trim().toLowerCase();
      if (resolved !== sha) throw new Error('resolved SHA mismatch');
      await this.run('git', ['-C', repo, 'merge-base', '--is-ancestor', sha, 'origin/main']);
      return { sha, reachableFromOriginMain: true };
    } catch (error) {
      throw new StableRuntimeActivationError('target SHA is missing, mismatched, or not reachable from origin/main', { phase: 'target_binding', sha, cause: error?.message || String(error) });
    }
  }

  async _prepare({ repo, sha, configPath, activationRoot }) {
    this.fs.mkdirSync(activationRoot, { recursive: true });
    const checkout = path.join(activationRoot, sha);
    if (!this.fs.existsSync(checkout)) {
      await this.run('git', ['-C', repo, 'worktree', 'add', '--detach', checkout, sha]);
    } else {
      const head = (await this.run('git', ['-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim().toLowerCase();
      const dirty = (await this.run('git', ['-C', checkout, 'status', '--porcelain'])).stdout.trim();
      if (head !== sha || dirty) throw new StableRuntimeActivationError('existing activation checkout is not an exact clean target worktree', { phase: 'prepare', checkout, expectedSha: sha, actualSha: head, dirty: !!dirty });
    }

    const npmCi = npmCiCommand(this.platform, process.env);
    try {
      await this.run(npmCi.file, npmCi.args, { cwd: checkout });
    } catch (error) {
      throw prepareCommandError('dependency installation failed during target preparation', 'dependency_install', error);
    }

    let preflight;
    try {
      preflight = await this.run(process.execPath, ['scripts/v0.2-start.mjs', '--config', configPath, '--activation-preflight', '--oneshot'], {
        cwd: checkout,
        env: { ...process.env, V02_PORT: '0', V02_BUILD_REVISION: sha },
      });
    } catch (error) {
      throw prepareCommandError('pre-activation runtime sanity check process failed', 'preflight', error);
    }

    const report = parseV02RuntimeReport(preflight.stdout);
    if (report.readyForLocalMcp !== true) throw new StableRuntimeActivationError('prepared target failed local-MCP startup sanity check', { phase: 'prepare', sha, report });
    const preparedHead = (await this.run('git', ['-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim().toLowerCase();
    if (preparedHead !== sha) throw new StableRuntimeActivationError('prepared activation checkout drifted from the exact target revision', { phase: 'prepare', sha, preparedHead });
    return { checkout, preflight: { revision: sha, readyForLocalMcp: true } };
  }

  async _listeningPids(config) {
    if (this.platform !== 'win32') throw new StableRuntimeActivationError('Stable Runtime host activation bootstrap currently supports the Windows dogfood host only', { phase: 'process_selection', platform: this.platform });
    const result = await this.run('netstat.exe', ['-ano', '-p', 'TCP']);
    return parseWindowsListeningPids(result.stdout, { host: config.host, port: config.port });
  }

  async _probeLocal(baseUrl) {
    const [health, ready] = await Promise.all([this.probeJson(`${baseUrl}/healthz`), this.probeJson(`${baseUrl}/readyz`)]);
    return { health, ready };
  }

  async _requireTunnelReady(config) {
    const tunnel = await this.probeJson(config.tunnel.healthUrl);
    if (!tunnel.ok) throw new StableRuntimeActivationError('existing external Secure Tunnel is not ready', { phase: 'tunnel_readiness', healthUrl: config.tunnel.healthUrl, status: tunnel.status });
    return { ok: true, status: tunnel.status };
  }

  async _waitForNoListener(config, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this._listeningPids(config)).length === 0) return true;
      await this.sleep(100);
    }
    return false;
  }

  async _waitForExactReady(config, baseUrl, sha, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const local = await this._probeLocal(baseUrl);
      if (local.health.ok && local.ready.ok && local.health.body?.revision === sha && local.ready.body?.revision === sha) {
        const tunnel = await this._requireTunnelReady(config);
        return { healthz: local.health.body, readyz: local.ready.body, tunnel };
      }
      await this.sleep(150);
    }
    throw new StableRuntimeActivationError('target runtime did not become ready at the exact requested revision', { phase: 'readiness', sha });
  }

  async _validateRollbackState(state, { fingerprint, configPath }) {
    if (!state || state.version !== 1 || !EXACT_SHA_RE.test(String(state.sha || ''))) return null;
    if (state.profileFingerprint !== fingerprint || comparePath(state.configPath, this.platform) !== comparePath(configPath, this.platform)) return null;
    if (!state.checkout || !this.fs.existsSync(state.checkout)) return null;
    try {
      const head = (await this.run('git', ['-C', state.checkout, 'rev-parse', 'HEAD'])).stdout.trim().toLowerCase();
      const dirty = (await this.run('git', ['-C', state.checkout, 'status', '--porcelain'])).stdout.trim();
      if (head !== state.sha.toLowerCase() || dirty) return null;
      return { ...state, sha: state.sha.toLowerCase() };
    } catch { return null; }
  }

  async activate({ targetSha, configPath, repoPath = null }) {
    const sha = assertExactCommitSha(targetSha);
    const absoluteConfigPath = path.resolve(String(configPath || ''));
    if (!configPath || !this.fs.existsSync(absoluteConfigPath)) throw new StableRuntimeActivationError('existing Stable Runtime config file is required', { phase: 'profile_binding', configPath: absoluteConfigPath });

    const config = this.loadConfig(absoluteConfigPath);
    const { baseUrl } = this._requireBoundedProfile(config);
    const repo = this._resolveTrustedRepo(config, repoPath);
    const activationRoot = deriveActivationRoot(repo);
    const statePath = path.join(activationRoot, STATE_FILE);
    const fingerprint = stableProfileFingerprint(config);
    const profile = stableProfileSnapshot(config);

    await this._validateTarget(repo, sha);

    const current = await this._probeLocal(baseUrl);
    if (current.health.ok && current.ready.ok && current.health.body?.revision === sha && current.ready.body?.revision === sha) {
      const tunnel = await this._requireTunnelReady(config);
      return { status: 'PASS', alreadyActive: true, sha, repo, configPath: absoluteConfigPath, profileFingerprint: fingerprint, evidence: { healthz: current.health.body, readyz: current.ready.body, tunnel } };
    }

    const prepared = await this._prepare({ repo, sha, configPath: absoluteConfigPath, activationRoot });
    await this._requireTunnelReady(config);

    const cutoverCurrent = await this._probeLocal(baseUrl);
    if (!cutoverCurrent.health.ok || !cutoverCurrent.ready.ok) {
      throw new StableRuntimeActivationError('current Stable Runtime endpoint is not healthy/ready immediately before cutover; refusing cutover', { phase: 'cutover_precheck', baseUrl });
    }

    const pids = await this._listeningPids(config);
    if (pids.length !== 1) throw new StableRuntimeActivationError('expected exactly one Stable Runtime listener PID on the configured endpoint', { phase: 'process_selection', host: config.host, port: config.port, pids });
    const previousPid = pids[0];
    if (previousPid === process.pid) throw new StableRuntimeActivationError('refusing to stop the activator process itself', { phase: 'process_selection', pid: previousPid });

    const previousState = await this._validateRollbackState(readJsonIfPresent(this.fs, statePath), { fingerprint, configPath: absoluteConfigPath });
    let targetPid = null;
    let cutoverStarted = false;
    let rollback = { attempted: false, status: 'not_available' };

    try {
      cutoverStarted = true;
      this.stopPid(previousPid);
      if (!(await this._waitForNoListener(config))) throw new StableRuntimeActivationError('previous Stable Runtime listener did not release the configured endpoint', { phase: 'cutover', pid: previousPid });

      const logPath = path.join(activationRoot, 'logs', `${sha}.log`);
      const started = await this.spawnRuntime({ checkout: prepared.checkout, configPath: absoluteConfigPath, sha, logPath });
      targetPid = started.pid;
      if (!Number.isInteger(targetPid) || targetPid <= 0) throw new StableRuntimeActivationError('target runtime did not return a valid process id', { phase: 'start_target' });

      const readiness = await this._waitForExactReady(config, baseUrl, sha);
      const state = { version: 1, sha, checkout: prepared.checkout, pid: targetPid, configPath: absoluteConfigPath, profileFingerprint: fingerprint, activatedAt: this.now() };
      writeJsonAtomic(this.fs, statePath, state);
      return {
        status: 'PASS', alreadyActive: false, sha, repo, checkout: prepared.checkout, pid: targetPid, previousPid,
        configPath: absoluteConfigPath, profileFingerprint: fingerprint, profile, preflight: prepared.preflight,
        evidence: readiness, tunnelLifecycle: 'external-preserved', statePath,
      };
    } catch (error) {
      if (targetPid) {
        try { this.stopPid(targetPid); } catch {}
        try { await this._waitForNoListener(config, 3000); } catch {}
      }
      if (cutoverStarted && previousState && previousState.sha !== sha) {
        rollback = { attempted: true, status: 'failed', sha: previousState.sha };
        try {
          const rollbackLog = path.join(activationRoot, 'logs', `${previousState.sha}-rollback.log`);
          const restarted = await this.spawnRuntime({ checkout: previousState.checkout, configPath: absoluteConfigPath, sha: previousState.sha, logPath: rollbackLog });
          const readiness = await this._waitForExactReady(config, baseUrl, previousState.sha);
          const restored = { ...previousState, pid: restarted.pid, activatedAt: this.now() };
          writeJsonAtomic(this.fs, statePath, restored);
          rollback = { attempted: true, status: 'restored', sha: previousState.sha, pid: restarted.pid, evidence: readiness };
        } catch (rollbackError) {
          rollback = { attempted: true, status: 'failed', sha: previousState.sha, cause: rollbackError?.message || String(rollbackError) };
        }
      }
      const details = error instanceof StableRuntimeActivationError ? error.details : {};
      throw new StableRuntimeActivationError(error?.message || String(error), { ...details, targetSha: sha, cutoverStarted, previousPid, targetPid, rollback });
    }
  }
}
