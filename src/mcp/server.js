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
import { createCapabilityRouter } from '../router/capability-router.js';
import { createGovernanceService } from '../governance/index.js';

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function runtimeRevision() {
  const value = String(process.env.V02_BUILD_REVISION || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(value) ? value : null;
}

export async function startMcpServer({ workspaceRegistry, appServerExecutor = null, host = '127.0.0.1', port = 0, allowedRoots = null, mutationOwner = null, operationState = null, changeSetService = null, verifyService = null, verifyChecks = {}, capabilityRouter = null, governanceService = null, worktreeService = null, activationPreflight = false } = {}) {
  // Normal serving mode keeps the canonical MCP tools surface. Activation preflight
  // intentionally creates no MCP handler at all: only /healthz and /readyz exist as
  // narrow startup evidence, so no Governance/Codex/worktree/generic MCP operation can
  // be authorized through this temporary ephemeral listener.
  let nodeHandler = null;
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  if (!activationPreflight) {
    const router = capabilityRouter || createCapabilityRouter();
    const gov = governanceService || createGovernanceService();
    const factory = () => createToolsServer({ workspaceRegistry, appServerExecutor, mutationOwner, operationState, changeSetService, verifyService, verifyChecks, capabilityRouter: router, governanceService: gov, worktreeService });
    const handler = createMcpHandler(factory);
    nodeHandler = toNodeHandler(handler);
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = (req.url || '').split('?')[0];
    const revision = runtimeRevision();

    if (req.method === 'GET' && url === '/healthz') return sendJson(res, 200, { status: 'ok', revision, activationPreflight: !!activationPreflight });
    if (req.method === 'GET' && url === '/readyz') {
      return sendJson(res, 200, { status: 'ready', revision, activationPreflight: !!activationPreflight, loopback: host === '127.0.0.1' || host === '::1', hasAllowedRoots: !!workspaceRegistry && workspaceRegistry.hasAllowedRoots });
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
  const close = () => new Promise((resolve) => httpServer.close(() => resolve()));
  return { httpServer, close, host, port: port2, url: `http://${host}:${port2}/mcp` };
}
