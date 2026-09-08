// chatgpt-codex-orchestrator: v0.2 production runtime assembly + Brain-local
// transport (M5 r1). Assembles the MCP runtime once and coordinates the local MCP
// server with the OpenAI tunnel-client. Direct Local and Codex Delegate share a
// single MutationOwner. No auth token / API key is stored or printed here.
//
// Readiness semantics (M5 r1):
//   readyForLocalMcp  = local v0.2 MCP server is up
//   readyForTunnel    = Secure Tunnel is real-ready (probes its /readyz)
//   readyForChatGPT   = readyForLocalMcp AND readyForTunnel
//
// The config is externalized; the tunnel client executable, profile, profile dir and
// health URL are supplied via config (never hard-coded).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { WorkspaceRegistry } from '../local/workspace.js';
import { MutationOwner } from '../state/mutation-owner.js';
import { OperationState } from '../state/operation-state.js';
import { ChangeSetService } from '../local/change-set.js';
import { VerifyService } from '../local/verify.js';
import { AppServerExecutor } from '../executor/app-server-executor.js';
import { AppServerClient } from '../executor/app-server-client.js';
import { startMcpServer } from '../mcp/server.js';
import { createCapabilityRouter } from '../router/capability-router.js';
import { createDurableGovernanceService } from '../governance/durable.js';
import { loadV02Config } from '../config.js';
import { resolveCodexAppServer } from './codex.js';
import { WorktreeService } from '../local/worktree.js';

const RUNTIME_MODES = new Set(['serving', 'activation-preflight']);

export class BrainLocalRuntime {
  constructor({ config = loadV02Config(), mode = 'serving' } = {}) {
    if (!RUNTIME_MODES.has(mode)) throw new Error(`unsupported BrainLocalRuntime mode: ${mode}`);
    this.config = config;
    this.mode = mode;
    this.activationPreflight = mode === 'activation-preflight';
    this.registry = null;
    this.mutationOwner = this.activationPreflight ? null : new MutationOwner();
    this.operationState = this.activationPreflight ? null : new OperationState({ dataRoot: config.dataRoot });
    this.changeSetService = null;
    this.verifyService = null;
    this.capabilityRouter = createCapabilityRouter();
    // Brain Continuity core: canonical Governance is durable under the configured
    // dataRoot/namespace with one canonical writer, authority fencing, bounded
    // semantic recovery and takeover. Normal serving runtimes always acquire that
    // canonical writer. The internal activation-preflight mode is deliberately
    // non-authoritative: it constructs the real profile with autoWriter:false so a
    // live serving writer remains fenced and untouched during pre-cutover sanity.
    this.governanceService = createDurableGovernanceService({
      dataRoot: config.dataRoot,
      namespace: config.governanceNamespace || 'default',
      autoWriter: !this.activationPreflight,
    });
    this.worktreeService = !this.activationPreflight && config.worktree && config.worktree.poolRoot && Array.isArray(config.worktree.trustedRepos) && config.worktree.trustedRepos.length > 0
      ? new WorktreeService({ poolRoot: config.worktree.poolRoot, trustedRepos: config.worktree.trustedRepos })
      : null;
    this.appServerExecutor = null;
    this.mcp = null;
    this.tunnelProcess = null;
    this.started = false;
  }

  get workspaceRoots() { return this.config.workspaceRoots; }

  _codexEnv() {
    const env = { ...process.env };
    if (this.config.codex.runtimeProfile) env.CODEX_HOME = this.config.codex.runtimeProfile;
    // Inject a trusted CA bundle / proxy into the Codex App Server env (presence-only).
    if (this.config.codex.caBundle) env.CODEX_CA_CERTIFICATE = this.config.codex.caBundle;
    if (this.config.codex.sslCertFile) env.SSL_CERT_FILE = this.config.codex.sslCertFile;
    return env;
  }

  async start() {
    const c = this.config;
    const allowedRoots = c.workspaceRoots.length ? c.workspaceRoots : (c.workspaceRoot ? [c.workspaceRoot] : []);
    if (!allowedRoots.length) throw new Error('v0.2 runtime requires a workspaceRoot / workspaceRoots');
    this.registry = new WorkspaceRegistry({ allowedRoots });

    if (!this.activationPreflight) {
      const codex = resolveCodexAppServer({ codexBin: c.codex.bin, listen: c.codex.listen, spawnArgs: c.codex.spawnArgs });
      this.appServerExecutor = new AppServerExecutor({
        dataRoot: c.dataRoot,
        client: new AppServerClient({ codexBin: codex.bin, listen: c.codex.listen, spawnArgs: codex.argv, extraArgs: c.codex.extraArgs || [], cwd: c.codex.cwd || undefined, env: this._codexEnv() }),
        mutationOwner: this.mutationOwner,
      });
      this.changeSetService = new ChangeSetService({ workspaceRegistry: this.registry, operationState: this.operationState, mutationOwner: this.mutationOwner });
      this.verifyService = new VerifyService({ workspaceRegistry: this.registry, mutationOwner: this.mutationOwner, verifyChecks: c.verify || {} });
    }

    this.mcp = await startMcpServer({
      workspaceRegistry: this.registry,
      appServerExecutor: this.appServerExecutor,
      mutationOwner: this.mutationOwner,
      operationState: this.operationState,
      changeSetService: this.changeSetService,
      verifyService: this.verifyService,
      verifyChecks: c.verify || {},
      capabilityRouter: this.capabilityRouter,
      governanceService: this.governanceService,
      worktreeService: this.worktreeService,
      host: c.host,
      port: c.port,
      allowedRoots,
      activationPreflight: this.activationPreflight,
    });
    this.started = true;
    if (!this.activationPreflight && this._tunnelExecutablePresent() && this.config.tunnel.external !== true) await this._startTunnel();
    return this;
  }

  _tunnelExecutablePresent() {
    const exe = this.config.tunnel.clientExecutable;
    return !!(exe && fs.existsSync(exe));
  }

  _tunnelHealthUrl() {
    return this.config.tunnel.healthUrl || null;
  }

  async _startTunnel() {
    const t = this.config.tunnel;
    const args = (Array.isArray(t.spawnArgs) && t.spawnArgs.length) ? t.spawnArgs.slice() : ['run'];
    if (t.profileFile) args.push('--profile-file', t.profileFile);
    else if (t.profile && t.profileDir) args.push('--profile', t.profile, '--profile-dir', t.profileDir);
    else if (t.profile) args.push('--profile', t.profile);
    try {
      const child = spawn(t.clientExecutable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.tunnelProcess = child;
      child.stdout && child.stdout.on('data', () => {});
      child.stderr && child.stderr.on('data', () => {});
      child.on('error', () => { this.tunnelProcess = null; });
      child.on('close', () => { if (this.tunnelProcess === child) this.tunnelProcess = null; });
    } catch { this.tunnelProcess = null; }
  }

  // Local MCP readiness (in-process listening + optional loopback probe).
  async _localReady() {
    if (!this.mcp) return false;
    if (this.mcp.httpServer && this.mcp.httpServer.listening) return true;
    try {
      const host = this.mcp.host === '0.0.0.0' ? '127.0.0.1' : this.mcp.host;
      const res = await fetch(`http://${host}:${this.mcp.port}/readyz`);
      return res.ok;
    } catch { return false; }
  }

  async _tunnelReady() {
    const url = this._tunnelHealthUrl();
    // readyForTunnel requires REAL /readyz proof. Without a configured health URL we
    // cannot prove the tunnel is ready, so it is NOT ready (process-alive is not a
    // substitute for readiness).
    if (!url) return false;
    try {
      const res = await fetch(url);
      return res.ok;
    } catch { return false; }
  }

  _mcpUrl() {
    if (!this.mcp) return null;
    const host = this.mcp.host === '0.0.0.0' ? '127.0.0.1' : this.mcp.host;
    return `http://${host}:${this.mcp.port}/mcp`;
  }

  async status() {
    const c = this.config;
    const localMcpUp = await this._localReady();
    const appLive = !!(this.appServerExecutor && this.appServerExecutor.client && this.appServerExecutor.client.isRunning);
    const tunnelPresent = this._tunnelExecutablePresent();
    const tunnelProcessAlive = !this.activationPreflight && tunnelPresent && !!this.tunnelProcess && this.tunnelProcess.exitCode === null;
    const tunnelReady = this.activationPreflight ? false : await this._tunnelReady();
    const readyForLocalMcp = localMcpUp;
    const readyForTunnel = tunnelReady;
    const readyForChatGPT = readyForLocalMcp && readyForTunnel;
    return {
      localMcp: { up: localMcpUp, url: this._mcpUrl() },
      appServer: { configured: !!this.appServerExecutor, live: appLive },
      tunnel: {
        present: tunnelPresent,
        external: c.tunnel.external === true,
        processAlive: tunnelProcessAlive,
        ready: tunnelReady,
        profile: c.tunnel.profile || c.tunnel.profileFile || null,
        healthUrl: this._tunnelHealthUrl(),
        reason: this.activationPreflight
          ? 'activation preflight preserves but does not probe or manage the external tunnel'
          : (tunnelPresent ? (tunnelReady ? null : 'tunnel not ready (probe failed or child not ready)') : 'tunnel-client executable not found'),
      },
      workspace: { roots: c.workspaceRoots },
      readyForLocalMcp,
      readyForTunnel,
      readyForChatGPT,
    };
  }

  async close() {
    if (this.appServerExecutor) { try { await this.appServerExecutor.shutdown(); } catch {} }
    if (this.mcp) { try { await this.mcp.close(); } catch {} }
    if (!this.activationPreflight && this.config.tunnel.external !== true && this.tunnelProcess && this.tunnelProcess.exitCode === null) { try { this.tunnelProcess.kill('SIGTERM'); } catch {} }
    if (this.governanceService && typeof this.governanceService.close === 'function') { try { this.governanceService.close(); } catch {} }
    this.started = false;
  }
}

export function createBrainLocalRuntime(config, options = {}) { return new BrainLocalRuntime(config ? { config, ...options } : options); }
export function v02Doctor(runtime) { return runtime.status(); }
export { loadV02Config };
