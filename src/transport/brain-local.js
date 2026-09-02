// chatgpt-codex-orchestrator: v0.2 production runtime assembly + Brain-local
// transport (M5). Assembles the MCP runtime once and coordinates the local MCP
// server with the OpenAI tunnel-client. Direct Local and Codex Delegate share a
// single MutationOwner. No auth token / API key is stored or printed here.
//
// The config is externalized (see config.js loadV02Config) so no absolute machine
// path is hard-coded; the tunnel client executable, profile and local MCP URL are
// supplied via config.

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
import { createGovernanceService } from '../governance/index.js';
import { loadV02Config } from '../config.js';

export class BrainLocalRuntime {
  constructor({ config = loadV02Config() } = {}) {
    this.config = config;
    this.registry = null;
    this.mutationOwner = new MutationOwner();
    this.operationState = new OperationState({ dataRoot: config.dataRoot });
    this.changeSetService = null;
    this.verifyService = null;
    this.capabilityRouter = createCapabilityRouter();
    this.governanceService = createGovernanceService();
    this.appServerExecutor = null;
    this.mcp = null;
    this.tunnelProcess = null;
    this.started = false;
  }

  get workspaceRoots() { return this.config.workspaceRoots; }

  _codexEnv() {
    const env = { ...process.env };
    // Isolated user-level CODEX_HOME runtime profile (never touches ~/.codex/config.toml).
    if (this.config.codex.runtimeProfile) env.CODEX_HOME = this.config.codex.runtimeProfile;
    return env;
  }

  async start() {
    const c = this.config;
    const allowedRoots = c.workspaceRoots.length ? c.workspaceRoots : (c.workspaceRoot ? [c.workspaceRoot] : []);
    if (!allowedRoots.length) throw new Error('v0.2 runtime requires a workspaceRoot / workspaceRoots');
    this.registry = new WorkspaceRegistry({ allowedRoots });

    // AppServer executor (Codex Delegate) shares the SAME MutationOwner as Direct Local.
    this.appServerExecutor = new AppServerExecutor({
      dataRoot: c.dataRoot,
      client: new AppServerClient({ codexBin: c.codex.bin, listen: c.codex.listen, spawnArgs: c.codex.spawnArgs || null, extraArgs: c.codex.extraArgs || [], cwd: c.codex.cwd || undefined, env: this._codexEnv() }),
      mutationOwner: this.mutationOwner,
    });
    this.changeSetService = new ChangeSetService({ workspaceRegistry: this.registry, operationState: this.operationState, mutationOwner: this.mutationOwner });
    this.verifyService = new VerifyService({ workspaceRegistry: this.registry, mutationOwner: this.mutationOwner, verifyChecks: c.verify || {} });

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
      host: c.host,
      port: c.port,
      allowedRoots,
    });
    this.started = true;
    // Tunnel is not started automatically unless an executable is configured AND ready.
    if (this._tunnelExecutablePresent()) await this._startTunnel();
    return this;
  }

  _tunnelExecutablePresent() {
    const exe = this.config.tunnel.clientExecutable;
    return !!(exe && fs.existsSync(exe));
  }

  async _startTunnel() {
    const t = this.config.tunnel;
    const profile = t.profile ? (t.profileDir ? `${t.profileDir}/${t.profile}` : t.profile) : null;
    const args = [];
    if (profile) args.push('-config', profile);
    if (t.localMcpUrl) args.push('--local-mcp-url', t.localMcpUrl);
    const child = spawn(t.clientExecutable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.tunnelProcess = child;
    child.stdout && child.stdout.on('data', () => {});
    child.stderr && child.stderr.on('data', () => {});
    child.on('error', () => { this.tunnelProcess = null; });
    child.on('close', () => { if (this.tunnelProcess === child) this.tunnelProcess = null; });
  }

  // Local MCP readiness probe.
  async _localReady() {
    if (!this.mcp) return false;
    // Primary: the in-process HTTP server is listening (no outbound network required).
    if (this.mcp.httpServer && this.mcp.httpServer.listening) return true;
    // Fallback: probe /readyz over loopback.
    try {
      const host = this.mcp.host === '0.0.0.0' ? '127.0.0.1' : this.mcp.host;
      const res = await fetch(`${host}:${this.mcp.port}/readyz`);
      return res.ok;
    } catch { return false; }
  }

  async status() {
    const c = this.config;
    const localMcpUp = await this._localReady();
    const appLive = !!(this.appServerExecutor && this.appServerExecutor.client && this.appServerExecutor.client.isRunning);
    const tunnelPresent = this._tunnelExecutablePresent();
    const tunnelReady = tunnelPresent && !!this.tunnelProcess && this.tunnelProcess.exitCode === null;
    const tunnelRequired = !!(c.tunnel.clientExecutable || c.tunnel.profile);
    return {
      localMcp: { up: localMcpUp, url: this.mcp ? `${c.host === '0.0.0.0' ? '127.0.0.1' : c.host}:${this.mcp.port}/mcp` : null },
      appServer: { configured: !!this.appServerExecutor, live: appLive, codixBin: c.codex.bin },
      tunnel: { present: tunnelPresent, ready: tunnelReady, required: tunnelRequired, profile: c.tunnel.profile || null, reason: tunnelPresent ? (tunnelReady ? null : 'not-connected') : 'tunnel-client executable not found' },
      workspace: { roots: c.workspaceRoots },
      readyForChatGPT: localMcpUp && (!tunnelRequired || tunnelReady),
    };
  }

  async close() {
    if (this.appServerExecutor) { try { await this.appServerExecutor.shutdown(); } catch {} }
    if (this.mcp) { try { await this.mcp.close(); } catch {} }
    if (this.tunnelProcess && this.tunnelProcess.exitCode === null) { try { this.tunnelProcess.kill('SIGTERM'); } catch {} }
    this.started = false;
  }
}

export function createBrainLocalRuntime(config) { return new BrainLocalRuntime(config ? { config } : {}); }
// Non-sensitive doctor/status: reports localMcp / appServer / tunnel / workspace / readyForChatGPT.
export function v02Doctor(runtime) { return runtime.status(); }
export { loadV02Config };
