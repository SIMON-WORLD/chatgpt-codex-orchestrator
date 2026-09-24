// chatgpt-codex-orchestrator: local MCP server (v0.2 M2).
// Uses the MCP TypeScript SDK v2 stable packages (@modelcontextprotocol/server +
// @modelcontextprotocol/node). Serving model is the canonical stateless,
// per-request streamable HTTP transport (GET/DELETE session operations are
// answered with 405 as the official stateless example does). No hand-rolled
// session registry, so no forever-growing transports Map.
//
//   GET  /healthz
//   GET  /readyz
//   POST /mcp      (Streamable HTTP MCP)
//
// Loopback-only by default, DNS-rebinding protected via the official v2 Node
// localhost Host + Origin validation guards. No OAuth in M2.

import http from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { createToolsServer } from './tools.js';
import { registerCodexDiagnosticsTool } from './codex-diagnostics-tool.js';
import { createCapabilityRouter } from '../router/capability-router.js';
import { createGovernanceService } from '../governance/index.js';
import { createDesktopCommanderChild } from '../local/desktop-commander-child.js';
import { createProcessService } from '../local/process.js';

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function runtimeRevision() {
  const value = String(process.env.V02_BUILD_REVISION || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(value) ? value : null;
}

const EXECUTOR_READY_TIMEOUT_MS = 5000;
const EXECUTOR_READY_TIMEOUT = 'EXECUTOR_READY_TIMEOUT';

async function runExecutorProbe(child) {
  let timer = null;
  try {
    const proof = await Promise.race([
      Promise.resolve().then(() => {
        if (typeof child.probeReady === 'function') return child.probeReady();
        if (typeof child.ensureReady === 'function') return child.ensureReady();
        throw new Error('executor readiness probe unavailable');
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('executor readiness timeout'), { code: EXECUTOR_READY_TIMEOUT })), EXECUTOR_READY_TIMEOUT_MS);
      }),
    ]);
    const health = typeof child.health === 'function' ? child.health() : proof;
    return { ready: health?.state === 'ready' || proof?.state === 'ready', health };
  } catch (error) {
    if (error?.code === EXECUTOR_READY_TIMEOUT) {
      try { await child.recoverAfterTimeout?.(); } catch {}
    }
    return { ready: false, health: typeof child.health === 'function' ? child.health() : null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeCompositeExecutor(child) {
  if (!child) return { ready: false, health: null };
  const before = typeof child.health === 'function' ? child.health() : null;
  if (before && (before.state === 'dead' || before.state === 'failed')) {
    void runExecutorProbe(child);
    return { ready: false, health: before };
  }
  return runExecutorProbe(child);
}

export async function startMcpServer({ workspaceRegistry, appServerExecutor = null, host = '127.0.0.1', port = 0, allowedRoots = null, mutationOwner = null, operationState = null, changeSetService = null, filesystemMutationService = null, verifyService = null, verifyChecks = {}, capabilityRouter = null, governanceService = null, worktreeService = null, codexDiagnosticsService = null, activationPreflight = false, desktopCommanderChild = null, processService = null } = {}) {
  // Normal serving mode keeps the canonical MCP tools surface. Activation preflight
  // intentionally creates no MCP handler at all: only /healthz and /readyz exist as
  // narrow startup evidence, so no Governance/Codex/worktree/generic MCP operation can
  // be authorized through this temporary ephemeral listener.
  let nodeHandler = null;
  const compositeChild = activationPreflight ? null : (desktopCommanderChild || createDesktopCommanderChild());
  const ownsCompositeChild = !!compositeChild && !desktopCommanderChild;
  const publicProcessService = activationPreflight
    ? null
    : (processService || createProcessService({ workspaceRegistry, desktopCommanderChild: compositeChild }));
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  if (!activationPreflight) {
    const router = capabilityRouter || createCapabilityRouter();
    const gov = governanceService || createGovernanceService();
    const factory = () => {
      const server = createToolsServer({ workspaceRegistry, appServerExecutor, mutationOwner, operationState, changeSetService, filesystemMutationService, verifyService, verifyChecks, capabilityRouter: router, governanceService: gov, worktreeService, desktopCommanderChild: compositeChild, processService: publicProcessService });
      if (codexDiagnosticsService) registerCodexDiagnosticsTool(server, codexDiagnosticsService);
      return server;
    };
    const handler = createMcpHandler(factory);
    nodeHandler = toNodeHandler(handler);
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = (req.url || '').split('?')[0];
    const revision = runtimeRevision();

    if (req.method === 'GET' && url === '/healthz') return sendJson(res, 200, { status: 'ok', revision, activationPreflight: !!activationPreflight, processLive: true, ...(compositeChild ? { compositeDesktopCommander: compositeChild.health() } : {}) });
    if (req.method === 'GET' && url === '/readyz') {
      const localMcpListening = httpServer.listening;
      if (activationPreflight) {
        return sendJson(res, 200, { status: 'ready', revision, activationPreflight: true, processLive: true, localMcpListening, executorRequired: false, executorReady: null, loopback: host === '127.0.0.1' || host === '::1', hasAllowedRoots: !!workspaceRegistry && workspaceRegistry.hasAllowedRoots });
      }
      const executor = await probeCompositeExecutor(compositeChild);
      const ready = localMcpListening && executor.ready;
      return sendJson(res, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready', revision, activationPreflight: false, processLive: true, localMcpListening, executorRequired: true, executorReady: executor.ready, loopback: host === '127.0.0.1' || host === '::1', hasAllowedRoots: !!workspaceRegistry && workspaceRegistry.hasAllowedRoots, ...(executor.health ? { compositeDesktopCommander: executor.health } : {}) });
    }

    if (url === '/mcp' || url === '/mcp/') {
      if (activationPreflight) return sendJson(res, 403, { error: 'activation_preflight_mcp_disabled' });
      if (!validateHost(req, res)) return;
      if (!validateOrigin(req, res)) return;
      try { await nodeHandler(req, res); }
      catch { if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    return sendJson(res, 404, { error: 'not_found' });
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => resolve());
  });
  const addr = httpServer.address();
  const port2 = typeof addr === 'object' && addr ? addr.port : port;
  const close = async () => {
    await new Promise((resolve) => {
      if (!httpServer.listening) return resolve();
      httpServer.close(() => resolve());
    });
    if (publicProcessService && typeof publicProcessService.close === 'function') {
      try { await publicProcessService.close(); } catch {}
    }
    if (ownsCompositeChild) await compositeChild.close();
  };
  return { httpServer, close, host, port: port2, url: `http://${host}:${port2}/mcp` };
}
