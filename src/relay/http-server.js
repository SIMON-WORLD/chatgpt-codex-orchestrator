import http from 'node:http';
import { RelayError } from './core.js';

function sendJson(res, status, value) {
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
  if (!value.startsWith('Bearer ') || value.length <= 7) throw new RelayError('ACCOUNT_AUTH_REQUIRED', 'bearer account authentication required', 401);
  return value.slice(7);
}

function deviceCredential(req) {
  const value = String(req.headers.authorization || '');
  if (!value.startsWith('Device ') || value.length <= 7) throw new RelayError('DEVICE_AUTH_REQUIRED', 'device authentication required', 401);
  return value.slice(7);
}

async function readJson(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new RelayError('REQUEST_TOO_LARGE', 'request body too large', 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RelayError('INVALID_JSON', 'invalid JSON', 400);
  }
}

function pathParts(req) {
  const pathname = new URL(req.url || '/', 'http://relay.invalid').pathname;
  return pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
}

export async function startRelayHttpServer({ core, host = '127.0.0.1', port = 0, maxBodyBytes = 1024 * 1024 } = {}) {
  if (!core) throw new TypeError('relay core is required');

  const server = http.createServer(async (req, res) => {
    try {
      const parts = pathParts(req);
      const method = String(req.method || 'GET').toUpperCase();

      if (method === 'GET' && parts.length === 1 && parts[0] === 'healthz') {
        return sendJson(res, 200, { status: 'ok' });
      }

      if (method === 'POST' && parts.join('/') === 'pairing/start') {
        return sendJson(res, 200, core.beginPairing(await readJson(req, maxBodyBytes)));
      }
      if (method === 'POST' && parts.join('/') === 'pairing/approve') {
        const body = await readJson(req, maxBodyBytes);
        return sendJson(res, 200, await core.approvePairing({ bearerToken: accountBearer(req), userCode: body.userCode }));
      }
      if (method === 'POST' && parts.join('/') === 'pairing/complete') {
        return sendJson(res, 200, core.completePairing(await readJson(req, maxBodyBytes)));
      }

      if (method === 'GET' && parts.length === 1 && parts[0] === 'devices') {
        return sendJson(res, 200, { devices: await core.listDevices({ bearerToken: accountBearer(req) }) });
      }
      if (method === 'POST' && parts.join('/') === 'devices/revoke-all') {
        return sendJson(res, 200, await core.revokeAll({ bearerToken: accountBearer(req) }));
      }
      if (parts[0] === 'devices' && parts.length >= 2) {
        const deviceId = parts[1];
        if (method === 'GET' && parts.length === 2) {
          return sendJson(res, 200, await core.getDevice({ bearerToken: accountBearer(req), deviceId }));
        }
        if (method === 'POST' && parts.length === 3 && parts[2] === 'rename') {
          const body = await readJson(req, maxBodyBytes);
          return sendJson(res, 200, await core.renameDevice({ bearerToken: accountBearer(req), deviceId, displayName: body.displayName }));
        }
        if (method === 'POST' && parts.length === 3 && parts[2] === 'revoke') {
          return sendJson(res, 200, await core.revokeDevice({ bearerToken: accountBearer(req), deviceId }));
        }
      }

      if (method === 'POST' && parts.join('/') === 'agent/sessions') {
        const body = await readJson(req, maxBodyBytes);
        return sendJson(res, 200, core.connectAgent({ ...body, credential: deviceCredential(req) }));
      }
      if (method === 'POST' && parts.join('/') === 'agent/poll') {
        const body = await readJson(req, maxBodyBytes);
        const envelope = await core.pollAgent({ ...body, credential: deviceCredential(req) });
        return sendJson(res, 200, envelope);
      }
      if (method === 'POST' && parts.join('/') === 'agent/respond') {
        const body = await readJson(req, maxBodyBytes);
        return sendJson(res, 200, core.respondAgent({ ...body, credential: deviceCredential(req) }));
      }

      if (method === 'POST' && parts.length === 3 && parts[0] === 'internal' && parts[1] === 'dispatch') {
        const body = await readJson(req, maxBodyBytes);
        const response = await core.dispatch({
          bearerToken: accountBearer(req),
          deviceId: parts[2],
          payload: body.payload,
          deadlineMs: body.deadlineMs,
        });
        return sendJson(res, 200, response);
      }

      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    } catch (error) {
      const safe = error instanceof RelayError
        ? error
        : new RelayError('INTERNAL_ERROR', 'internal relay error', 500);
      return sendJson(res, safe.status || 500, { error: { code: safe.code, message: safe.message } });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const url = 'http://' + host + ':' + address.port;
  return {
    server,
    host,
    port: address.port,
    url,
    close: async () => {
      core.close();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
