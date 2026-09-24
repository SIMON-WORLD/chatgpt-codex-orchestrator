import { randomUUID } from 'node:crypto';
import { RELAY_PROTOCOL_VERSION, RelayError } from './core.js';

export async function readExecutorReadiness({ readyzUrl, fetchFn = fetch }) {
  let response;
  try {
    response = await fetchFn(readyzUrl, { method: 'GET' });
  } catch {
    return false;
  }
  if (!response?.ok) return false;
  let body;
  try {
    body = await response.json();
  } catch {
    return false;
  }
  return body?.status === 'ready'
    && body?.activationPreflight === false
    && body?.executorRequired === true
    && body?.executorReady === true
    && body?.localMcpListening === true;
}

async function readJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new RelayError(body?.error?.code || 'RELAY_HTTP_ERROR', body?.error?.message || 'relay request failed', response.status);
  }
  return body;
}

export class HttpAgentTransport {
  constructor({ relayBaseUrl, deviceId, credential, fetchFn = fetch }) {
    this.relayBaseUrl = String(relayBaseUrl || '').replace(/\/+$/u, '');
    this.deviceId = deviceId;
    this.credential = credential;
    this.fetchFn = fetchFn;
  }

  async #post(path, body, { signal } = {}) {
    const response = await this.fetchFn(this.relayBaseUrl + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Device ' + this.credential,
      },
      body: JSON.stringify(body),
      signal,
    });
    return readJson(response);
  }

  connect({ runtimeId, executorReady, protocolVersion, agentVersion }, { signal } = {}) {
    return this.#post('/agent/sessions', {
      deviceId: this.deviceId,
      runtimeId,
      executorReady,
      protocolVersion,
      agentVersion,
    }, { signal });
  }

  poll({ runtimeId, connectionEpoch, executorReady, protocolVersion, agentVersion, holdMs }, { signal } = {}) {
    return this.#post('/agent/poll', {
      deviceId: this.deviceId,
      runtimeId,
      connectionEpoch,
      executorReady,
      protocolVersion,
      agentVersion,
      holdMs,
    }, { signal });
  }

  respond({ runtimeId, connectionEpoch, requestId, response }, { signal } = {}) {
    return this.#post('/agent/respond', {
      deviceId: this.deviceId,
      runtimeId,
      connectionEpoch,
      requestId,
      response,
    }, { signal });
  }
}

export class DeviceRelayAgent {
  constructor({
    deviceId,
    credential,
    readyzUrl,
    transport,
    execute,
    runtimeId = randomUUID(),
    protocolVersion = RELAY_PROTOCOL_VERSION,
    agentVersion = '0.2',
    ledgerLimit = 128,
    now = () => Date.now(),
    fetchFn = fetch,
    logger = () => {},
  }) {
    if (!deviceId || !credential || !readyzUrl) throw new TypeError('deviceId, credential and readyzUrl are required');
    if (!transport || typeof transport.connect !== 'function' || typeof transport.poll !== 'function' || typeof transport.respond !== 'function') {
      throw new TypeError('relay agent transport is required');
    }
    if (typeof execute !== 'function') throw new TypeError('relay agent execute function is required');
    this.deviceId = deviceId;
    this.credential = credential;
    this.readyzUrl = readyzUrl;
    this.transport = transport;
    this.execute = execute;
    this.runtimeId = runtimeId;
    this.protocolVersion = protocolVersion;
    this.agentVersion = agentVersion;
    this.ledgerLimit = Math.max(1, Math.min(Number(ledgerLimit) || 128, 1024));
    this.now = now;
    this.fetchFn = fetchFn;
    this.logger = logger;
    this.connectionEpoch = null;
    this.ledger = new Map();
  }

  async executorReady() {
    return readExecutorReadiness({ readyzUrl: this.readyzUrl, fetchFn: this.fetchFn });
  }

  async connect({ signal } = {}) {
    const executorReady = await this.executorReady();
    const session = await this.transport.connect({
      runtimeId: this.runtimeId,
      executorReady,
      protocolVersion: this.protocolVersion,
      agentVersion: this.agentVersion,
    }, { signal });
    if (session.deviceId !== this.deviceId || session.runtimeId !== this.runtimeId) {
      throw new RelayError('SESSION_IDENTITY_MISMATCH', 'relay returned mismatched session identity', 409);
    }
    this.connectionEpoch = Number(session.connectionEpoch);
    this.logger({ event: 'relay_agent_connected', deviceId: this.deviceId, runtimeId: this.runtimeId, connectionEpoch: this.connectionEpoch });
    return session;
  }

  async pollOnce({ holdMs = 25_000, signal } = {}) {
    if (this.connectionEpoch == null) throw new RelayError('AGENT_NOT_CONNECTED', 'agent is not connected', 409);
    const executorReady = await this.executorReady();
    const envelope = await this.transport.poll({
      runtimeId: this.runtimeId,
      connectionEpoch: this.connectionEpoch,
      executorReady,
      protocolVersion: this.protocolVersion,
      agentVersion: this.agentVersion,
      holdMs,
    }, { signal });
    if (!envelope) return null;
    const terminal = await this.handleEnvelope(envelope);
    await this.transport.respond({
      runtimeId: this.runtimeId,
      connectionEpoch: this.connectionEpoch,
      requestId: envelope.requestId,
      response: terminal,
    }, { signal });
    return { envelope, terminal };
  }

  async handleEnvelope(envelope) {
    if (envelope?.deviceId !== this.deviceId) throw new RelayError('DEVICE_ID_MISMATCH', 'request targeted another device', 409);
    if (envelope?.runtimeId !== this.runtimeId) throw new RelayError('DEVICE_RUNTIME_CHANGED', 'request belongs to another runtime', 409);
    if (Number(envelope?.connectionEpoch) !== Number(this.connectionEpoch)) throw new RelayError('STALE_CONNECTION_EPOCH', 'request belongs to a stale connection', 409);
    if (!envelope?.requestId) throw new RelayError('INVALID_REQUEST_ENVELOPE');
    if (Number(envelope.deadline) <= this.now()) throw new RelayError('REQUEST_DEADLINE_EXCEEDED', 'request deadline exceeded', 504);

    const cached = this.ledger.get(envelope.requestId);
    if (cached) {
      this.logger({ event: 'relay_agent_dedupe_hit', deviceId: this.deviceId, requestId: envelope.requestId });
      return cached;
    }

    let terminal;
    try {
      terminal = { ok: true, value: await this.execute(envelope.payload) };
    } catch (error) {
      terminal = {
        ok: false,
        error: {
          code: typeof error?.code === 'string' ? error.code : 'LOCAL_EXECUTION_FAILED',
          message: typeof error?.message === 'string' ? error.message : 'local execution failed',
        },
      };
    }
    this.#remember(envelope.requestId, terminal);
    this.logger({ event: 'relay_agent_executed', deviceId: this.deviceId, requestId: envelope.requestId });
    return terminal;
  }

  #remember(requestId, terminal) {
    this.ledger.set(requestId, terminal);
    while (this.ledger.size > this.ledgerLimit) {
      const oldest = this.ledger.keys().next().value;
      this.ledger.delete(oldest);
    }
  }
}
