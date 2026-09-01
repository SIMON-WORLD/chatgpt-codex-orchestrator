// chatgpt-codex-orchestrator: local MCP server (v0.2 M2).
// Streamable HTTP MCP endpoint bound to LOOPBACK ONLY by default.
//   GET  /healthz
//   GET  /readyz
//   POST /mcp      (Streamable HTTP MCP)
// No OAuth in M2; loopback-only, intentionally no-auth. Secure Tunnel is M5.
// Graceful shutdown; bounded request/output handling; no secrets in diagnostics.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createToolsServer } from './tools.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export async function startMcpServer({ workspaceRegistry, appServerExecutor = null, host = '127.0.0.1', port = 0, allowedRoots = null } = {}) {
  const transports = new Map();
  const makeServer = () => createToolsServer({ workspaceRegistry, appServerExecutor });

  const httpServer = http.createServer(async (req, res) => {
    const url = (req.url || '').split('?')[0];

    if (req.method === 'GET' && url === '/healthz') return sendJson(res, 200, { status: 'ok' });
    if (req.method === 'GET' && url === '/readyz') {
      return sendJson(res, 200, { status: 'ready', loopback: host === '127.0.0.1' || host === '::1', hasAllowedRoots: !!workspaceRegistry && workspaceRegistry.hasAllowedRoots });
    }

    if (req.method === 'GET' && (url === '/mcp' || url === '/mcp/')) {
      res.writeHead(405, { Allow: 'POST', 'content-type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    if (req.method === 'POST' && (url === '/mcp' || url === '/mcp/')) {
      let body;
      try { body = await readBody(req); }
      catch { return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'invalid JSON body' }, id: null }); }

      const sessionId = req.headers['mcp-session-id'];
      let transport;
      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId);
      } else if (!sessionId && isInitializeRequest(body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid) => { transports.set(sid, transport); },
        });
        const server = makeServer();
        await server.connect(transport);
        try { await transport.handleRequest(req, res, body); } catch (e) { if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null }); }
        return;
      } else {
        return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session id' }, id: null });
      }
      try { await transport.handleRequest(req, res, body); } catch (e) { if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null }); }
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

  const close = () => new Promise((resolve) => { for (const t of transports.values()) { try { t.close ? t.close() : null; } catch {} } httpServer.close(() => resolve()); });

  return { httpServer, close, host, port: port2, url: `http://${host}:${port2}/mcp`, transports };
}
