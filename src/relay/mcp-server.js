import http from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { RelayError } from './core.js';
import { RelayMcpFacade, createRelayToolsServer } from './mcp-facade.js';

function sendJson(res, status, value) {
  if (res.headersSent) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function accountBearer(req) {
  const value = String(req.headers.authorization || '');
  if (!value.startsWith('Bearer ') || value.length <= 7) {
    throw new RelayError('ACCOUNT_AUTH_REQUIRED', 'bearer account authentication required', 401);
  }
  return value.slice(7);
}

export async function startRelayMcpServer({ core, host = '127.0.0.1', port = 0 } = {}) {
  if (!core) throw new TypeError('relay core is required');
  const facade = new RelayMcpFacade({ core });
  const handler = createMcpHandler(({ authInfo }) => {
    const accountId = String(authInfo?.clientId || '');
    if (!accountId) throw new RelayError('ACCOUNT_AUTH_REQUIRED', 'authenticated account context required', 401);
    return createRelayToolsServer({ facade, accountId });
  }, { responseMode: 'json' });
  const nodeHandler = toNodeHandler(handler);

  const httpServer = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://relay.invalid').pathname;
    if (req.method === 'GET' && pathname === '/healthz') {
      return sendJson(res, 200, { status: 'ok' });
    }
    if (pathname !== '/mcp' && pathname !== '/mcp/') {
      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    }

    try {
      const bearerToken = accountBearer(req);
      const account = await core.accountForBearer(bearerToken);
      // The raw bearer token is consumed only by the injected verifier seam above.
      // MCP tool factories receive the stable opaque relay account id, never the token.
      req.auth = {
        token: 'relay-account-context',
        clientId: account.account_id,
        scopes: ['local_connector.use'],
      };
      await nodeHandler(req, res);
    } catch (error) {
      const safe = error instanceof RelayError
        ? error
        : new RelayError('INTERNAL_ERROR', 'internal relay MCP error', 500);
      sendJson(res, safe.status || 500, { error: { code: safe.code, message: safe.message } });
    }
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  return {
    httpServer,
    facade,
    host,
    port: boundPort,
    url: 'http://' + host + ':' + boundPort + '/mcp',
    close: async () => {
      await new Promise((resolve) => {
        if (!httpServer.listening) return resolve();
        httpServer.close(() => resolve());
      });
    },
  };
}
