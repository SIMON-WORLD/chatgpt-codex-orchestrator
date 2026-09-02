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

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export async function startMcpServer({ workspaceRegistry, appServerExecutor = null, host = '127.0.0.1', port = 0, allowedRoots = null, mutationOwner = null, operationState = null, changeSetService = null, verifyService = null, verifyChecks = {} } = {}) {
  const factory = () => createToolsServer({ workspaceRegistry, appServerExecutor, mutationOwner, operationState, changeSetService, verifyService, verifyChecks });
  const handler = createMcpHandler(factory);
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const httpServer = http.createServer(async (req, res) => {
    const url = (req.url || '').split('?')[0];

    if (req.method === 'GET' && url === '/healthz') return sendJson(res, 200, { status: 'ok' });
    if (req.method === 'GET' && url === '/readyz') {
      return sendJson(res, 200, { status: 'ready', loopback: host === '127.0.0.1' || host === '::1', hasAllowedRoots: !!workspaceRegistry && workspaceRegistry.hasAllowedRoots });
    }

    if (url === '/mcp' || url === '/mcp/') {
      // DNS-rebinding protection: invalid Host or non-local Origin -> 403.
      if (!validateHost(req, res)) return;
      if (!validateOrigin(req, res)) return;
      try {
        await nodeHandler(req, res);
      } catch (e) {
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      }
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
