import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { DeviceRelayAgent, HttpAgentTransport } from './agent.js';
import { RelayError } from './core.js';

const DEFAULT_POLL_HOLD_MS = 25_000;
const DEFAULT_RECONNECT_INITIAL_MS = 250;
const DEFAULT_RECONNECT_MAX_MS = 5_000;
const FATAL_AGENT_CODES = new Set(['DEVICE_REVOKED', 'INVALID_DEVICE_CREDENTIAL', 'DEVICE_AUTH_REQUIRED']);

function abortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function waitForDelay(ms, state) {
  return new Promise((resolve) => {
    if (state.stopping || ms <= 0) return resolve();
    const timer = setTimeout(() => {
      if (state.timer === timer) {
        state.timer = null;
        state.resolveDelay = null;
      }
      resolve();
    }, ms);
    state.timer = timer;
    state.resolveDelay = resolve;
  });
}

function requireEnabledConfig(config, env) {
  if (!config?.enabled) return null;
  const relayUrl = String(config.relayUrl || '').replace(/\/+$/u, '');
  const deviceId = String(config.deviceId || '').trim();
  const credentialEnv = String(config.credentialEnv || '').trim();
  if (!relayUrl) throw new Error('relayAgent.relayUrl is required when relayAgent.enabled=true');
  if (!deviceId) throw new Error('relayAgent.deviceId is required when relayAgent.enabled=true');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(credentialEnv)) {
    throw new Error('relayAgent.credentialEnv must name one environment variable');
  }
  const credential = env?.[credentialEnv];
  if (!credential) throw new Error('relayAgent credential environment variable is not set');
  return {
    relayUrl,
    deviceId,
    credential,
    pollHoldMs: Math.max(0, Math.min(Number(config.pollHoldMs) || DEFAULT_POLL_HOLD_MS, 25_000)),
    reconnectInitialMs: Math.max(10, Math.min(Number(config.reconnectInitialMs) || DEFAULT_RECONNECT_INITIAL_MS, 60_000)),
    reconnectMaxMs: Math.max(10, Math.min(Number(config.reconnectMaxMs) || DEFAULT_RECONNECT_MAX_MS, 60_000)),
  };
}

export class LocalMcpToolExecutor {
  constructor({ mcpUrl, clientFactory = null } = {}) {
    if (!mcpUrl) throw new TypeError('LocalMcpToolExecutor requires mcpUrl');
    this.mcpUrl = mcpUrl;
    this.clientFactory = clientFactory;
    this.client = null;
    this.transport = null;
  }

  async execute(payload) {
    const method = payload?.method || (payload?.tool ? 'tools/call' : null);
    const params = payload?.params || (payload?.tool ? { name: payload.tool, arguments: payload.arguments || {} } : null);
    if (method !== 'tools/call' || !params || typeof params.name !== 'string' || !params.name) {
      throw new RelayError('INVALID_LOCAL_RELAY_REQUEST', 'relay local execution accepts only internal tools/call payloads', 400);
    }
    const client = await this.#client();
    return client.callTool({ name: params.name, arguments: params.arguments || {} });
  }

  async #client() {
    if (this.client) return this.client;
    if (this.clientFactory) {
      this.client = await this.clientFactory(this.mcpUrl);
      return this.client;
    }
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl));
    const client = new Client(
      { name: 'stable-runtime-relay-agent', version: '0.2.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    this.transport = transport;
    this.client = client;
    return client;
  }

  async close() {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    try { await client?.close?.(); } catch {}
    try { await transport?.close?.(); } catch {}
  }
}

export class StableRuntimeRelayAgentMode {
  constructor({
    config,
    readyzUrl,
    execute,
    env = process.env,
    fetchFn = fetch,
    runtimeId = randomUUID(),
    transportFactory = null,
    logger = () => {},
  } = {}) {
    const resolved = requireEnabledConfig(config, env);
    if (!resolved) throw new Error('StableRuntimeRelayAgentMode requires enabled relayAgent config');
    if (!readyzUrl) throw new TypeError('StableRuntimeRelayAgentMode requires readyzUrl');
    if (typeof execute !== 'function') throw new TypeError('StableRuntimeRelayAgentMode requires local execute seam');

    this.config = resolved;
    this.readyzUrl = readyzUrl;
    this.execute = execute;
    this.fetchFn = fetchFn;
    this.runtimeId = runtimeId;
    this.transportFactory = transportFactory;
    this.logger = logger;

    this.agent = null;
    this.loopPromise = null;
    this.operationAbort = null;
    this.delayState = { stopping: false, timer: null, resolveDelay: null };
    this.connectionEpoch = null;
    this.state = 'idle';
    this.lastErrorCode = null;
  }

  start() {
    if (this.loopPromise) return this;
    this.delayState.stopping = false;
    this.state = 'starting';
    this.loopPromise = this.#run().finally(() => {
      this.loopPromise = null;
      if (this.state !== 'revoked' && this.state !== 'failed') this.state = 'stopped';
    });
    return this;
  }

  status() {
    return {
      enabled: true,
      state: this.state,
      runtimeId: this.runtimeId,
      connectionEpoch: this.connectionEpoch,
      lastErrorCode: this.lastErrorCode,
    };
  }

  async stop() {
    this.delayState.stopping = true;
    if (this.delayState.timer) {
      clearTimeout(this.delayState.timer);
      this.delayState.timer = null;
      const resolveDelay = this.delayState.resolveDelay;
      this.delayState.resolveDelay = null;
      resolveDelay?.();
    }
    this.operationAbort?.abort();
    try { await this.loopPromise; } catch {}
    this.state = 'stopped';
  }

  async #run() {
    const transport = this.transportFactory
      ? this.transportFactory({
          relayUrl: this.config.relayUrl,
          deviceId: this.config.deviceId,
          credential: this.config.credential,
        })
      : new HttpAgentTransport({
          relayBaseUrl: this.config.relayUrl,
          deviceId: this.config.deviceId,
          credential: this.config.credential,
          fetchFn: this.fetchFn,
        });
    this.agent = new DeviceRelayAgent({
      deviceId: this.config.deviceId,
      credential: this.config.credential,
      readyzUrl: this.readyzUrl,
      transport,
      execute: this.execute,
      runtimeId: this.runtimeId,
      fetchFn: this.fetchFn,
      logger: this.logger,
    });

    let backoffMs = this.config.reconnectInitialMs;
    while (!this.delayState.stopping) {
      try {
        this.operationAbort = new AbortController();
        const session = await this.agent.connect({ signal: this.operationAbort.signal });
        this.connectionEpoch = Number(session.connectionEpoch);
        this.lastErrorCode = null;
        this.state = 'connected';
        backoffMs = this.config.reconnectInitialMs;

        while (!this.delayState.stopping) {
          this.operationAbort = new AbortController();
          await this.agent.pollOnce({
            holdMs: this.config.pollHoldMs,
            signal: this.operationAbort.signal,
          });
        }
      } catch (error) {
        if (this.delayState.stopping || abortError(error)) break;
        const code = typeof error?.code === 'string' ? error.code : 'RELAY_AGENT_TRANSPORT_FAILED';
        this.lastErrorCode = code;
        if (FATAL_AGENT_CODES.has(code)) {
          this.state = code === 'DEVICE_REVOKED' ? 'revoked' : 'failed';
          this.logger({ event: 'relay_agent_terminal', deviceId: this.config.deviceId, code });
          return;
        }
        this.state = 'reconnecting';
        this.logger({ event: 'relay_agent_reconnect', deviceId: this.config.deviceId, code, backoffMs });
        await waitForDelay(backoffMs, this.delayState);
        backoffMs = Math.min(this.config.reconnectMaxMs, Math.max(this.config.reconnectInitialMs, backoffMs * 2));
      } finally {
        this.operationAbort = null;
      }
    }
  }
}
