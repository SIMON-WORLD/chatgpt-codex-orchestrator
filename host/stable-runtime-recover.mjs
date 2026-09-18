#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  StableRuntimeActivator,
  StableRuntimeActivationError,
  assertExactCommitSha,
  deriveActivationRoot,
  runCommand,
  stableProfileFingerprint,
} from '../src/activation/stable-runtime-activator.js';
import {
  ReadOnlySmokeInstallError,
  ReadOnlySmokeInstaller,
} from '../src/activation/read-only-smoke-installer.js';
import {
  AuthorizedWorkspaceRootInstallError,
  AuthorizedWorkspaceRootInstaller,
} from '../src/activation/authorized-workspace-root-installer.js';

const STATE_FILE = 'stable-runtime-active.json';
const MAX_CAUSE_CHARS = 512;
const CRITICAL_BINDING_ENV_VARS = [
  'V02_PORT', 'V02_HOST', 'V02_WORKSPACE_ROOT', 'CODEX_BIN',
  'TUNNEL_CLIENT_EXECUTABLE', 'TUNNEL_PROFILE', 'TUNNEL_PROFILE_DIR',
  'TUNNEL_LOCAL_MCP_URL', 'TUNNEL_HEALTH_URL',
];
const SENSITIVE_ASSIGNMENT_RE = /\b([a-z0-9_-]*(?:api[_-]?key|authorization|cookie|credential|password|secret|token)[a-z0-9_-]*)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;

export class StableRuntimeRecoveryError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'StableRuntimeRecoveryError';
    this.details = details;
  }
}

function redact(value) {
  return String(value || '')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT_RE, '$1=[REDACTED]');
}

function boundedCause(error) {
  const text = redact(error?.message || String(error)).replace(/\s+/g, ' ').trim();
  return text.length <= MAX_CAUSE_CHARS ? text : `${text.slice(0, MAX_CAUSE_CHARS - 3)}...`;
}

function safeDetails(value, depth = 0) {
  if (depth > 5) return '[TRUNCATED]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redact(value).slice(0, 2048);
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => safeDetails(entry, depth + 1));
  if (!value || typeof value !== 'object') return undefined;
  const out = {};
  for (const [key, entry] of Object.entries(value).slice(0, 40)) {
    if (/(?:api[_-]?key|authorization|cookie|credential|password|secret|token|^env$|^environment$|stdout|stderr)/i.test(key)) continue;
    const safe = safeDetails(entry, depth + 1);
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}

export function recoveryFailurePayload(error) {
  return {
    status: 'FAIL',
    message: redact(error?.message || String(error)).slice(0, 1024),
    ...(error instanceof StableRuntimeRecoveryError ? safeDetails(error.details) : {}),
  };
}

function readJsonIfPresent(fsImpl, filename) {
  if (!fsImpl.existsSync(filename)) return null;
  try { return JSON.parse(fsImpl.readFileSync(filename, 'utf8')); }
  catch { return null; }
}

function writeJsonAtomic(fsImpl, filename, value) {
  fsImpl.mkdirSync(path.dirname(filename), { recursive: true });
  const tmp = `${filename}.tmp-${process.pid}-${Date.now()}`;
  fsImpl.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fsImpl.renameSync(tmp, filename);
}

function normalizeUrl(value) {
  return String(value || '').replace(/\/$/, '');
}

function assertNoCriticalBindingEnv(env) {
  const present = CRITICAL_BINDING_ENV_VARS.filter((name) => env?.[name] !== undefined && String(env[name]).length > 0);
  if (present.length) {
    throw new StableRuntimeRecoveryError('critical Stable Runtime binding environment overrides are not allowed during deterministic recovery', {
      phase: 'profile_binding', envOverrides: present,
    });
  }
}

function localExact(local, sha) {
  return local.health?.ok === true
    && local.ready?.ok === true
    && local.health?.body?.revision === sha
    && local.ready?.body?.revision === sha;
}

function exactServingRevision(local) {
  const health = String(local.health?.body?.revision || '').trim().toLowerCase();
  const ready = String(local.ready?.body?.revision || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(health) || health !== ready) return null;
  if (local.health?.ok !== true || local.ready?.ok !== true) return null;
  return health;
}

export class StableRuntimeRecoveryCoordinator {
  constructor({
    activator = new StableRuntimeActivator(),
    run = runCommand,
    probeJson = null,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => new Date().toISOString(),
    env = process.env,
  } = {}) {
    this.activator = activator;
    this.run = run;
    this.probeJson = probeJson || activator.probeJson;
    this.sleep = sleep;
    this.now = now;
    this.env = env;
  }

  _requireRecoveryProfile(config) {
    // The Stable Runtime contract requires an externally managed Secure Tunnel.
    // In external mode this process owns readiness verification only; it must not
    // require, launch, stop, or reconfigure tunnel-client.
    return this.activator._requireBoundedProfile(config);
  }

  async _probeCurrentServing({ configPath, repoPath = null }) {
    const absoluteConfigPath = path.resolve(String(configPath || ''));
    if (!configPath || !this.activator.fs.existsSync(absoluteConfigPath)) {
      throw new StableRuntimeRecoveryError('existing Stable Runtime config file is required', { phase: 'profile_binding' });
    }
    assertNoCriticalBindingEnv(this.env);
    const config = this.activator.loadConfig(absoluteConfigPath);
    const { baseUrl } = this._requireRecoveryProfile(config);
    this.activator._resolveTrustedRepo(config, repoPath);
    const local = await this.activator._probeLocal(baseUrl);
    const sha = exactServingRevision(local);
    const pids = await this.activator._listeningPids(config);
    if (!sha || pids.length !== 1) {
      throw new StableRuntimeRecoveryError('current Stable Runtime revision is not exactly proven for reversible fixture installation', {
        phase: 'current_runtime_binding',
        exactRevisionProven: Boolean(sha),
        listenerCount: pids.length,
      });
    }
    return { sha, pid: pids[0] };
  }

  async installReadOnlySmoke({ fixturePath, targetSha, configPath, repoPath = null }) {
    const installer = new ReadOnlySmokeInstaller({
      fsImpl: this.activator.fs,
      platform: this.activator.platform,
      probeCurrent: (args) => this._probeCurrentServing(args),
      activateTarget: (args) => this.activator.activate(args),
      runGit: (args, options) => this.activator.run('git', args, options),
    });
    try {
      return await installer.install({ fixturePath, targetSha, configPath, repoPath });
    } catch (error) {
      if (error instanceof StableRuntimeRecoveryError) throw error;
      if (error instanceof ReadOnlySmokeInstallError) {
        throw new StableRuntimeRecoveryError(error.message, safeDetails(error.details));
      }
      throw new StableRuntimeRecoveryError(error?.message || String(error), { phase: 'fixture_install' });
    }
  }

  async installAuthorizedWorkspaceRoot({ workspaceRootPath, targetSha, configPath, repoPath = null }) {
    const installer = new AuthorizedWorkspaceRootInstaller({
      fsImpl: this.activator.fs,
      platform: this.activator.platform,
      probeCurrent: (args) => this._probeCurrentServing(args),
      activateTarget: (args) => this.activator.activate(args),
    });
    try {
      return await installer.install({ workspaceRootPath, targetSha, configPath, repoPath });
    } catch (error) {
      if (error instanceof StableRuntimeRecoveryError) throw error;
      if (error instanceof AuthorizedWorkspaceRootInstallError) {
        throw new StableRuntimeRecoveryError(error.message, safeDetails(error.details));
      }
      throw new StableRuntimeRecoveryError('authorized workspace root installation failed', { phase: 'workspace_root_install' });
    }
  }

  async _selectTarget({ targetSha, statePath, fingerprint, configPath }) {
    if (targetSha) return assertExactCommitSha(targetSha);
    const state = readJsonIfPresent(this.activator.fs, statePath);
    const validated = await this.activator._validateRollbackState(state, { fingerprint, configPath });
    if (!validated) {
      throw new StableRuntimeRecoveryError('no validated same-profile exact last-active revision is available; provide --sha explicitly', { phase: 'target_binding' });
    }
    return assertExactCommitSha(validated.sha);
  }

  async _waitForLocalExact(config, baseUrl, sha, expectedPid, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const local = await this.activator._probeLocal(baseUrl);
      if (localExact(local, sha)) {
        const pids = await this.activator._listeningPids(config);
        if (pids.length !== 1 || (expectedPid && pids[0] !== expectedPid)) {
          throw new StableRuntimeRecoveryError('exact runtime readiness is not bound to the single expected listener PID', {
            phase: 'runtime_conflict', pids, expectedPid: expectedPid || null,
          });
        }
        return { local, pid: pids[0] };
      }
      await this.sleep(150);
    }
    throw new StableRuntimeRecoveryError('Stable Runtime did not become ready at the exact recovery revision', { phase: 'runtime_readiness', sha });
  }

  async recover({ targetSha = null, configPath, repoPath = null }) {
    const absoluteConfigPath = path.resolve(String(configPath || ''));
    if (!configPath || !this.activator.fs.existsSync(absoluteConfigPath)) {
      throw new StableRuntimeRecoveryError('existing Stable Runtime config file is required', { phase: 'profile_binding', configPath: absoluteConfigPath });
    }

    let startedRuntimePid = null;
     try {
      assertNoCriticalBindingEnv(this.env);
      const config = this.activator.loadConfig(absoluteConfigPath);
      const { baseUrl } = this._requireRecoveryProfile(config);
      const repo = this.activator._resolveTrustedRepo(config, repoPath);
      const activationRoot = deriveActivationRoot(repo);
      const statePath = path.join(activationRoot, STATE_FILE);
      const fingerprint = stableProfileFingerprint(config);
      const sha = await this._selectTarget({ targetSha, statePath, fingerprint, configPath: absoluteConfigPath });

      try { await this.activator._validateTarget(repo, sha); }
      catch (error) {
        const phase = error instanceof StableRuntimeActivationError ? (error.details?.phase || 'target_binding') : 'target_binding';
        throw new StableRuntimeRecoveryError(error?.message || 'target validation failed', { phase, cause: boundedCause(error) });
      }

      const before = await this.activator._probeLocal(baseUrl);
      const beforePids = await this.activator._listeningPids(config);
      let runtime;
      let prepared = null;

      if (before.health?.ok || before.ready?.ok) {
        if (!localExact(before, sha)) {
          throw new StableRuntimeRecoveryError('configured Stable Runtime endpoint is already serving a different or unproven revision', {
            phase: 'runtime_conflict', expectedSha: sha,
            healthRevision: before.health?.body?.revision || null,
            readyRevision: before.ready?.body?.revision || null,
            pids: beforePids,
          });
        }
        if (beforePids.length !== 1) {
          throw new StableRuntimeRecoveryError('exact Stable Runtime endpoint does not have one unambiguous listener PID', { phase: 'runtime_conflict', pids: beforePids });
        }
        runtime = { action: 'reused', pid: beforePids[0] };
      } else {
        if (beforePids.length !== 0) {
          throw new StableRuntimeRecoveryError('configured Stable Runtime endpoint has an unproven or ambiguous listener', { phase: 'runtime_conflict', pids: beforePids });
        }
        prepared = await this.activator._prepare({ repo, sha, configPath: absoluteConfigPath, activationRoot });
        const logPath = path.join(activationRoot, 'logs', `${sha}-recovery.log`);
        const started = await this.activator.spawnRuntime({ checkout: prepared.checkout, configPath: absoluteConfigPath, sha, logPath });
        if (!Number.isInteger(started?.pid) || started.pid <= 0) {
          throw new StableRuntimeRecoveryError('recovery runtime did not return a valid process id', { phase: 'runtime_start' });
        }
        startedRuntimePid = started.pid;
        await this._waitForLocalExact(config, baseUrl, sha, startedRuntimePid);
        runtime = { action: 'started', pid: startedRuntimePid };
      }

      const tunnelPreflight = {
        mode: 'external-readiness-only',
        checkedLocalMcpUrl: normalizeUrl(config.tunnel.localMcpUrl),
      };
      const tunnelBefore = await this.probeJson(config.tunnel.healthUrl);
      if (!tunnelBefore.ok) {
        throw new StableRuntimeRecoveryError('existing external Secure Tunnel is not ready', {
          phase: 'tunnel_readiness',
          status: tunnelBefore.status || 0,
        });
      }
      const tunnel = { action: 'reused', status: tunnelBefore.status };

      const finalLocal = await this.activator._probeLocal(baseUrl);
      const finalPids = await this.activator._listeningPids(config);
      if (!localExact(finalLocal, sha) || finalPids.length !== 1 || finalPids[0] !== runtime.pid) {
        throw new StableRuntimeRecoveryError('final Stable Runtime exact-revision proof failed', { phase: 'joint_readiness', sha, pids: finalPids });
      }
      const finalTunnel = await this.probeJson(config.tunnel.healthUrl);
      if (!finalTunnel.ok) {
        throw new StableRuntimeRecoveryError('final external Secure Tunnel readiness proof failed', { phase: 'joint_readiness', status: finalTunnel.status || 0 });
      }

      if (prepared && startedRuntimePid) {
        writeJsonAtomic(this.activator.fs, statePath, {
          version: 1, sha, checkout: prepared.checkout, pid: startedRuntimePid,
          configPath: absoluteConfigPath, profileFingerprint: fingerprint, activatedAt: this.now(),
        });
      }

      return {
        status: 'PASS', sha, repo, configPath: absoluteConfigPath, profileFingerprint: fingerprint,
        runtime, tunnel, tunnelPreflight,
        evidence: { healthz: finalLocal.health.body, readyz: finalLocal.ready.body, tunnel: { status: finalTunnel.status } },
        tunnelLifecycle: 'external-preserved', statePath,
      };
    } catch (error) {
      if (startedRuntimePid) { try { this.activator.stopPid(startedRuntimePid); } catch {} }
      if (error instanceof StableRuntimeRecoveryError) throw error;
      if (error instanceof StableRuntimeActivationError) {
        throw new StableRuntimeRecoveryError(error.message, { ...safeDetails(error.details), cause: boundedCause(error) });
      }
      throw new StableRuntimeRecoveryError(error?.message || String(error), { phase: 'recovery', cause: boundedCause(error) });
    }
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sha') out.targetSha = argv[++i];
    else if (arg === '--config') out.configPath = argv[++i];
    else if (arg === '--repo') out.repoPath = argv[++i];
    else if (arg === '--read-only-smoke-fixture') out.readOnlySmokeFixture = argv[++i];
    else if (arg === '--authorized-workspace-root') out.authorizedWorkspaceRoot = argv[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    'Stable Runtime deterministic reboot/login recovery', '', 'Usage:',
    '  node host/stable-runtime-recover.mjs --config <stable-v0.2-config.json> [--sha <exact-40-hex-commit>] [--repo <trusted-canonical-repo>]', 
    '  node host/stable-runtime-recover.mjs --config <stable-v0.2-config.json> --sha <exact-40-hex-commit> --read-only-smoke-fixture <exact-human-approved-directory> [--repo <trusted-canonical-repo>]',
    '  node host/stable-runtime-recover.mjs --config <stable-v0.2-config.json> --sha <exact-40-hex-commit> --authorized-workspace-root <exact-human-approved-directory> [--repo <trusted-canonical-repo>]', '',
    'When --sha is omitted, normal recovery uses only a validated same-profile/same-config exact last-active revision. It never guesses latest/main/newest.',
    'Host authorization mutations always require an explicit exact --sha and exact Human-approved path; they never discover or substitute a directory.',
    'Tunnel credentials remain in the existing profile reference (for example env:CONTROL_PLANE_API_KEY); this command has no raw-secret CLI argument.',
  ].join('\n');
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (args.help) { process.stdout.write(`${usage()}\n`); return; }
  args.configPath ||= process.env.STABLE_RUNTIME_CONFIG;
  args.repoPath ||= process.env.STABLE_RUNTIME_REPO || null;
  const hostMutationModes = Number(Boolean(args.readOnlySmokeFixture)) + Number(Boolean(args.authorizedWorkspaceRoot));
  if (!args.configPath || hostMutationModes > 1 || (hostMutationModes === 1 && !args.targetSha)) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const coordinator = new StableRuntimeRecoveryCoordinator();
    const result = args.readOnlySmokeFixture
      ? await coordinator.installReadOnlySmoke({
          fixturePath: args.readOnlySmokeFixture,
          targetSha: args.targetSha,
          configPath: args.configPath,
          repoPath: args.repoPath,
        })
      : args.authorizedWorkspaceRoot
        ? await coordinator.installAuthorizedWorkspaceRoot({
            workspaceRootPath: args.authorizedWorkspaceRoot,
            targetSha: args.targetSha,
            configPath: args.configPath,
            repoPath: args.repoPath,
          })
        : await coordinator.recover(args);
    process.stdout.write(`STABLE_RUNTIME_RECOVERY ${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`STABLE_RUNTIME_RECOVERY ${JSON.stringify(recoveryFailurePayload(error))}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) await main();
