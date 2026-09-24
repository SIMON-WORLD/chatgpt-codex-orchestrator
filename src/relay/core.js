import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const RELAY_PROTOCOL_VERSION = '1';

export class RelayError extends Error {
  constructor(code, message = code, status = 400) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message = code, status = 400) {
  throw new RelayError(code, message, status);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function equalHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function normalizeIssuer(value) {
  const raw = String(value || '').trim();
  if (!raw) fail('INVALID_ACCOUNT_IDENTITY');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail('INVALID_ACCOUNT_IDENTITY');
  }
  parsed.hash = '';
  parsed.search = '';
  const text = parsed.toString();
  return text.length > parsed.origin.length + 1 && text.endsWith('/') ? text.slice(0, -1) : text;
}

export function normalizeAccountIdentity(identity) {
  const issuer = normalizeIssuer(identity?.issuer);
  const subject = String(identity?.subject || '').trim();
  if (!subject) fail('INVALID_ACCOUNT_IDENTITY');
  return { issuer, subject };
}

function cleanDisplayName(value) {
  const text = String(value || '').trim().replace(/[\u0000-\u001f\u007f]/gu, '');
  return text.slice(0, 120) || 'Device';
}

function parseCredential(value) {
  const text = String(value || '');
  const split = text.indexOf('.');
  if (split <= 0 || split === text.length - 1) fail('INVALID_DEVICE_CREDENTIAL', 'invalid device credential', 401);
  return { credentialId: text.slice(0, split), secret: text.slice(split + 1) };
}

function rowBoolean(value) {
  return Number(value) === 1;
}

export class RelayStore {
  constructor(filename) {
    if (!filename) throw new TypeError('RelayStore filename is required');
    this.filename = filename;
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON');
    const modeRow = this.db.prepare('PRAGMA journal_mode = WAL').get();
    this.journalMode = String(Object.values(modeRow || {})[0] || '').toLowerCase();
    if (filename !== ':memory:' && this.journalMode !== 'wal') throw new Error('relay SQLite database must use WAL mode');
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS accounts (account_id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (issuer, subject));',
      'CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE, display_name TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER, last_seen_at INTEGER, connection_epoch INTEGER NOT NULL DEFAULT 0, last_runtime_id TEXT, executor_ready INTEGER NOT NULL DEFAULT 0, protocol_version TEXT, agent_version TEXT);',
      'CREATE INDEX IF NOT EXISTS devices_account_idx ON devices(account_id);',
      'CREATE TABLE IF NOT EXISTS device_credentials (credential_id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE, secret_sha256 TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);',
      'CREATE UNIQUE INDEX IF NOT EXISTS active_device_credential_idx ON device_credentials(device_id) WHERE revoked_at IS NULL;',
      'CREATE TABLE IF NOT EXISTS pairing_approvals (pairing_id TEXT PRIMARY KEY, device_code_sha256 TEXT NOT NULL UNIQUE, user_code_sha256 TEXT NOT NULL UNIQUE, proposed_display_name TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, approved_account_id TEXT REFERENCES accounts(account_id), approved_at INTEGER, consumed_at INTEGER, consumed_device_id TEXT);',
      'CREATE TABLE IF NOT EXISTS consumed_pair_tokens (issuer TEXT NOT NULL, token_key TEXT NOT NULL, consumed_at INTEGER NOT NULL, device_id TEXT NOT NULL, PRIMARY KEY (issuer, token_key));',
      'CREATE TABLE IF NOT EXISTS workspace_affinity (relay_workspace_id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE, device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE, runtime_id TEXT NOT NULL, local_workspace_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, invalidated_at INTEGER);',
      'CREATE INDEX IF NOT EXISTS workspace_affinity_account_idx ON workspace_affinity(account_id);',
      'CREATE INDEX IF NOT EXISTS workspace_affinity_device_idx ON workspace_affinity(device_id);',
      'CREATE TABLE IF NOT EXISTS process_affinity (relay_process_handle TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE, device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE, runtime_id TEXT NOT NULL, relay_workspace_id TEXT NOT NULL REFERENCES workspace_affinity(relay_workspace_id) ON DELETE CASCADE, local_process_handle TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, invalidated_at INTEGER);',
      'CREATE INDEX IF NOT EXISTS process_affinity_account_idx ON process_affinity(account_id);',
      'CREATE INDEX IF NOT EXISTS process_affinity_device_idx ON process_affinity(device_id);',
    ].join('\n'));
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  getOrCreateAccount(identity, now) {
    const normalized = normalizeAccountIdentity(identity);
    const existing = this.db.prepare('SELECT * FROM accounts WHERE issuer = ? AND subject = ?').get(normalized.issuer, normalized.subject);
    if (existing) return existing;
    const accountId = randomUUID();
    this.db.prepare('INSERT INTO accounts (account_id, issuer, subject, created_at) VALUES (?, ?, ?, ?)').run(accountId, normalized.issuer, normalized.subject, now);
    return this.db.prepare('SELECT * FROM accounts WHERE account_id = ?').get(accountId);
  }

  createPairing({ displayName, now, expiresAt }) {
    const pairingId = randomUUID();
    const deviceCode = randomBytes(32).toString('base64url');
    const userCode = randomBytes(6).toString('hex').toUpperCase();
    this.db.prepare('INSERT INTO pairing_approvals (pairing_id, device_code_sha256, user_code_sha256, proposed_display_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      pairingId, sha256(deviceCode), sha256(userCode), cleanDisplayName(displayName), now, expiresAt
    );
    return { pairingId, deviceCode, userCode, expiresAt };
  }

  approvePairing({ userCode, accountId, now }) {
    const row = this.db.prepare('SELECT * FROM pairing_approvals WHERE user_code_sha256 = ?').get(sha256(String(userCode || '').trim().toUpperCase()));
    if (!row) fail('PAIRING_CODE_INVALID', 'pairing code invalid', 404);
    if (row.consumed_at) fail('PAIRING_ALREADY_CONSUMED', 'pairing approval already consumed', 409);
    if (row.expires_at <= now) fail('PAIRING_EXPIRED', 'pairing approval expired', 410);
    if (row.approved_account_id && row.approved_account_id !== accountId) fail('PAIRING_ALREADY_APPROVED', 'pairing approval already bound', 409);
    this.db.prepare('UPDATE pairing_approvals SET approved_account_id = ?, approved_at = ? WHERE pairing_id = ?').run(accountId, now, row.pairing_id);
    return { pairingId: row.pairing_id, expiresAt: row.expires_at };
  }

  completePairing({ deviceCode, displayName, now }) {
    return this.transaction(() => {
      const tokenHash = sha256(String(deviceCode || ''));
      const row = this.db.prepare('SELECT p.*, a.issuer FROM pairing_approvals p LEFT JOIN accounts a ON a.account_id = p.approved_account_id WHERE p.device_code_sha256 = ?').get(tokenHash);
      if (!row) fail('PAIRING_CODE_INVALID', 'pairing code invalid', 404);
      if (row.consumed_at) fail('PAIRING_ALREADY_CONSUMED', 'pairing approval already consumed', 409);
      if (row.expires_at <= now) fail('PAIRING_EXPIRED', 'pairing approval expired', 410);
      if (!row.approved_account_id) fail('AUTHORIZATION_PENDING', 'pairing authorization pending', 428);

      const deviceId = randomUUID();
      const credentialId = randomUUID();
      const secret = randomBytes(32).toString('base64url');
      const effectiveDisplayName = cleanDisplayName(displayName || row.proposed_display_name);

      this.db.prepare('INSERT INTO devices (device_id, account_id, display_name, created_at, revoked_at, last_seen_at, connection_epoch, last_runtime_id, executor_ready) VALUES (?, ?, ?, ?, NULL, NULL, 0, NULL, 0)').run(
        deviceId, row.approved_account_id, effectiveDisplayName, now
      );
      this.db.prepare('INSERT INTO device_credentials (credential_id, device_id, secret_sha256, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)').run(
        credentialId, deviceId, sha256(secret), now
      );
      const consumed = this.db.prepare('UPDATE pairing_approvals SET consumed_at = ?, consumed_device_id = ? WHERE pairing_id = ? AND consumed_at IS NULL').run(
        now, deviceId, row.pairing_id
      );
      if (Number(consumed.changes) !== 1) fail('PAIRING_ALREADY_CONSUMED', 'pairing approval already consumed', 409);
      this.db.prepare('INSERT INTO consumed_pair_tokens (issuer, token_key, consumed_at, device_id) VALUES (?, ?, ?, ?)').run(
        row.issuer, tokenHash, now, deviceId
      );
      return { deviceId, displayName: effectiveDisplayName, credential: credentialId + '.' + secret };
    });
  }

  deviceForAccount(accountId, deviceId) {
    return this.db.prepare('SELECT * FROM devices WHERE device_id = ? AND account_id = ?').get(deviceId, accountId) || null;
  }

  deviceById(deviceId) {
    return this.db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId) || null;
  }

  listDevices(accountId) {
    return this.db.prepare('SELECT * FROM devices WHERE account_id = ? ORDER BY created_at ASC, device_id ASC').all(accountId);
  }

  createWorkspaceAffinity({ accountId, deviceId, runtimeId, localWorkspaceId, now }) {
    const relayWorkspaceId = 'ws_' + randomBytes(24).toString('base64url');
    this.db.prepare('INSERT INTO workspace_affinity (relay_workspace_id, account_id, device_id, runtime_id, local_workspace_id, created_at, last_used_at, invalidated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)').run(
      relayWorkspaceId, accountId, deviceId, runtimeId, localWorkspaceId, now, now
    );
    return this.db.prepare('SELECT * FROM workspace_affinity WHERE relay_workspace_id = ?').get(relayWorkspaceId);
  }

  workspaceAffinity(accountId, relayWorkspaceId) {
    return this.db.prepare('SELECT * FROM workspace_affinity WHERE relay_workspace_id = ? AND account_id = ?').get(relayWorkspaceId, accountId) || null;
  }

  touchWorkspaceAffinity(relayWorkspaceId, now) {
    this.db.prepare('UPDATE workspace_affinity SET last_used_at = ? WHERE relay_workspace_id = ?').run(now, relayWorkspaceId);
  }

  createProcessAffinity({ accountId, deviceId, runtimeId, relayWorkspaceId, localProcessHandle, now }) {
    const relayProcessHandle = 'proc_' + randomBytes(24).toString('base64url');
    this.db.prepare('INSERT INTO process_affinity (relay_process_handle, account_id, device_id, runtime_id, relay_workspace_id, local_process_handle, created_at, last_used_at, invalidated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)').run(
      relayProcessHandle, accountId, deviceId, runtimeId, relayWorkspaceId, localProcessHandle, now, now
    );
    return this.db.prepare('SELECT * FROM process_affinity WHERE relay_process_handle = ?').get(relayProcessHandle);
  }

  processAffinity(accountId, relayProcessHandle) {
    return this.db.prepare('SELECT * FROM process_affinity WHERE relay_process_handle = ? AND account_id = ?').get(relayProcessHandle, accountId) || null;
  }

  touchProcessAffinity(relayProcessHandle, now) {
    this.db.prepare('UPDATE process_affinity SET last_used_at = ? WHERE relay_process_handle = ?').run(now, relayProcessHandle);
  }

  invalidateDeviceAffinities(deviceId, now) {
    this.db.prepare('UPDATE workspace_affinity SET invalidated_at = COALESCE(invalidated_at, ?) WHERE device_id = ?').run(now, deviceId);
    this.db.prepare('UPDATE process_affinity SET invalidated_at = COALESCE(invalidated_at, ?) WHERE device_id = ?').run(now, deviceId);
  }

  renameDevice(accountId, deviceId, displayName) {
    const result = this.db.prepare('UPDATE devices SET display_name = ? WHERE device_id = ? AND account_id = ? AND revoked_at IS NULL').run(
      cleanDisplayName(displayName), deviceId, accountId
    );
    if (Number(result.changes) !== 1) fail('DEVICE_NOT_FOUND', 'device not found', 404);
    return this.deviceForAccount(accountId, deviceId);
  }

  authenticateDevice(deviceId, credential) {
    const device = this.deviceById(deviceId);
    if (!device) fail('DEVICE_NOT_FOUND', 'device not found', 404);
    if (device.revoked_at) fail('DEVICE_REVOKED', 'device revoked', 403);
    const { credentialId, secret } = parseCredential(credential);
    const row = this.db.prepare('SELECT * FROM device_credentials WHERE credential_id = ? AND device_id = ? AND revoked_at IS NULL').get(credentialId, deviceId);
    if (!row || !equalHex(row.secret_sha256, sha256(secret))) fail('INVALID_DEVICE_CREDENTIAL', 'invalid device credential', 401);
    return device;
  }

  openSession({ deviceId, runtimeId, executorReady, protocolVersion, agentVersion, now }) {
    const row = this.db.prepare('UPDATE devices SET connection_epoch = connection_epoch + 1, last_runtime_id = ?, last_seen_at = ?, executor_ready = ?, protocol_version = ?, agent_version = ? WHERE device_id = ? AND revoked_at IS NULL RETURNING *').get(
      runtimeId, now, executorReady ? 1 : 0, protocolVersion, agentVersion || null, deviceId
    );
    if (!row) fail('DEVICE_REVOKED', 'device revoked', 403);
    return row;
  }

  touchSession({ deviceId, runtimeId, connectionEpoch, executorReady, protocolVersion, agentVersion, now }) {
    const row = this.deviceById(deviceId);
    if (!row) fail('DEVICE_NOT_FOUND', 'device not found', 404);
    if (row.revoked_at) fail('DEVICE_REVOKED', 'device revoked', 403);
    if (Number(row.connection_epoch) !== Number(connectionEpoch)) fail('STALE_CONNECTION_EPOCH', 'stale connection epoch', 409);
    if (row.last_runtime_id !== runtimeId) fail('DEVICE_RUNTIME_CHANGED', 'device runtime changed', 409);
    this.db.prepare('UPDATE devices SET last_seen_at = ?, executor_ready = ?, protocol_version = ?, agent_version = ? WHERE device_id = ?').run(
      now, executorReady ? 1 : 0, protocolVersion, agentVersion || row.agent_version || null, deviceId
    );
    return this.deviceById(deviceId);
  }

  revokeDevice(accountId, deviceId, now) {
    return this.transaction(() => {
      const row = this.deviceForAccount(accountId, deviceId);
      if (!row) fail('DEVICE_NOT_FOUND', 'device not found', 404);
      if (!row.revoked_at) {
        this.db.prepare('UPDATE devices SET revoked_at = ?, executor_ready = 0, connection_epoch = connection_epoch + 1 WHERE device_id = ? AND account_id = ?').run(now, deviceId, accountId);
        this.db.prepare('UPDATE device_credentials SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(now, deviceId);
        this.invalidateDeviceAffinities(deviceId, now);
      }
      return this.deviceForAccount(accountId, deviceId);
    });
  }

  revokeAll(accountId, now) {
    return this.transaction(() => {
      const ids = this.db.prepare('SELECT device_id FROM devices WHERE account_id = ? AND revoked_at IS NULL').all(accountId).map((row) => row.device_id);
      this.db.prepare('UPDATE devices SET revoked_at = ?, executor_ready = 0, connection_epoch = connection_epoch + 1 WHERE account_id = ? AND revoked_at IS NULL').run(now, accountId);
      for (const deviceId of ids) {
        this.db.prepare('UPDATE device_credentials SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(now, deviceId);
        this.invalidateDeviceAffinities(deviceId, now);
      }
      return ids;
    });
  }
}

export class RelayCore {
  constructor({ store, verifyBearer, now = () => Date.now(), presenceWindowMs = 60_000, supportedProtocolVersions = [RELAY_PROTOCOL_VERSION], logger = () => {} }) {
    if (!(store instanceof RelayStore)) throw new TypeError('RelayCore requires a RelayStore');
    if (typeof verifyBearer !== 'function') throw new TypeError('RelayCore requires verifyBearer');
    this.store = store;
    this.verifyBearer = verifyBearer;
    this.now = now;
    this.presenceWindowMs = presenceWindowMs;
    this.supportedProtocolVersions = new Set(supportedProtocolVersions);
    this.logger = logger;
    this.activeSessions = new Map();
    this.pending = new Map();
    this.queues = new Map();
    this.pollWaiters = new Map();
  }

  async accountForBearer(bearerToken) {
    const identity = await this.verifyBearer(String(bearerToken || ''));
    return this.store.getOrCreateAccount(normalizeAccountIdentity(identity), this.now());
  }

  beginPairing({ displayName = 'Device', expiresInMs = 600_000 } = {}) {
    const ttl = Math.max(60_000, Math.min(Number(expiresInMs) || 600_000, 900_000));
    const created = this.store.createPairing({ displayName, now: this.now(), expiresAt: this.now() + ttl });
    this.logger({ event: 'pairing_started', pairingId: created.pairingId });
    return { ...created, intervalSeconds: 5 };
  }

  async approvePairing({ bearerToken, userCode }) {
    const account = await this.accountForBearer(bearerToken);
    const approved = this.store.approvePairing({ userCode, accountId: account.account_id, now: this.now() });
    this.logger({ event: 'pairing_approved', pairingId: approved.pairingId, accountId: account.account_id });
    return approved;
  }

  completePairing({ deviceCode, displayName }) {
    const paired = this.store.completePairing({ deviceCode, displayName, now: this.now() });
    this.logger({ event: 'device_paired', deviceId: paired.deviceId });
    return paired;
  }

  summary(row) {
    const session = this.activeSessions.get(row.device_id);
    const recent = row.last_seen_at != null && (this.now() - Number(row.last_seen_at)) <= this.presenceWindowMs;
    const online = !row.revoked_at && !!session && recent;
    const protocolCompatible = this.supportedProtocolVersions.has(String(row.protocol_version || ''));
    const executorReady = rowBoolean(row.executor_ready);
    return {
      deviceId: row.device_id,
      displayName: row.display_name,
      revoked: !!row.revoked_at,
      online,
      executorReady,
      ready: online && executorReady && protocolCompatible,
      lastSeenAt: row.last_seen_at,
      connectionEpoch: Number(row.connection_epoch),
      runtimeId: row.last_runtime_id,
      protocolVersion: row.protocol_version,
      agentVersion: row.agent_version,
    };
  }

  async listDevices({ bearerToken }) {
    const account = await this.accountForBearer(bearerToken);
    return this.store.listDevices(account.account_id).map((row) => this.summary(row));
  }

  async getDevice({ bearerToken, deviceId }) {
    const account = await this.accountForBearer(bearerToken);
    const row = this.store.deviceForAccount(account.account_id, deviceId);
    if (!row) fail('DEVICE_NOT_FOUND', 'device not found', 404);
    return this.summary(row);
  }

  async renameDevice({ bearerToken, deviceId, displayName }) {
    const account = await this.accountForBearer(bearerToken);
    const row = this.store.renameDevice(account.account_id, deviceId, displayName);
    this.logger({ event: 'device_renamed', deviceId });
    return this.summary(row);
  }

  async revokeDevice({ bearerToken, deviceId }) {
    const account = await this.accountForBearer(bearerToken);
    const row = this.store.revokeDevice(account.account_id, deviceId, this.now());
    this.#fenceDevice(deviceId, new RelayError('DEVICE_REVOKED', 'device revoked', 403));
    this.logger({ event: 'device_revoked', deviceId });
    return this.summary(row);
  }

  async revokeAll({ bearerToken }) {
    const account = await this.accountForBearer(bearerToken);
    const ids = this.store.revokeAll(account.account_id, this.now());
    for (const deviceId of ids) this.#fenceDevice(deviceId, new RelayError('DEVICE_REVOKED', 'device revoked', 403));
    this.logger({ event: 'devices_revoked_all', accountId: account.account_id, count: ids.length });
    return { revokedCount: ids.length };
  }

  connectAgent({ deviceId, credential, runtimeId, executorReady, protocolVersion = RELAY_PROTOCOL_VERSION, agentVersion = null }) {
    const persistedBefore = this.store.authenticateDevice(deviceId, credential);
    if (!runtimeId) fail('INVALID_RUNTIME_ID');
    const previous = this.activeSessions.get(deviceId);
    const now = this.now();
    const row = this.store.openSession({
      deviceId,
      runtimeId,
      executorReady: executorReady === true,
      protocolVersion,
      agentVersion,
      now,
    });
    if (persistedBefore.last_runtime_id && persistedBefore.last_runtime_id !== runtimeId) {
      this.store.invalidateDeviceAffinities(deviceId, now);
    }
    const session = { deviceId, runtimeId, connectionEpoch: Number(row.connection_epoch), protocolVersion: String(protocolVersion), agentVersion };
    this.activeSessions.set(deviceId, session);
    this.#cancelPoll(deviceId, new RelayError('STALE_CONNECTION_EPOCH', 'newer connection established', 409));
    for (const item of [...this.pending.values()]) {
      if (item.deviceId !== deviceId) continue;
      if (item.runtimeId !== runtimeId) {
        this.#rejectPending(item.requestId, new RelayError('DEVICE_RUNTIME_CHANGED', 'device runtime changed', 409));
      } else {
        item.connectionEpoch = session.connectionEpoch;
        this.#queueRequest(item.requestId);
      }
    }
    this.logger({ event: 'agent_connected', deviceId, connectionEpoch: session.connectionEpoch, runtimeId });
    return { deviceId, runtimeId, connectionEpoch: session.connectionEpoch, state: this.summary(row), replacedEpoch: previous?.connectionEpoch ?? null };
  }

  #validateAgent({ deviceId, credential, runtimeId, connectionEpoch }) {
    this.store.authenticateDevice(deviceId, credential);
    const current = this.activeSessions.get(deviceId);
    if (!current) fail('DEVICE_OFFLINE', 'device has no active relay session', 409);
    if (current.runtimeId !== runtimeId) fail('DEVICE_RUNTIME_CHANGED', 'device runtime changed', 409);
    if (Number(current.connectionEpoch) !== Number(connectionEpoch)) fail('STALE_CONNECTION_EPOCH', 'stale connection epoch', 409);
    return current;
  }

  async pollAgent({ deviceId, credential, runtimeId, connectionEpoch, executorReady, protocolVersion = RELAY_PROTOCOL_VERSION, agentVersion = null, holdMs = 25_000 }) {
    this.#validateAgent({ deviceId, credential, runtimeId, connectionEpoch });
    this.store.touchSession({
      deviceId,
      runtimeId,
      connectionEpoch,
      executorReady: executorReady === true,
      protocolVersion,
      agentVersion,
      now: this.now(),
    });
    const immediate = this.#dequeueEnvelope(deviceId, connectionEpoch, runtimeId);
    if (immediate) return immediate;
    const wait = Math.max(0, Math.min(Number(holdMs) || 0, 25_000));
    if (wait === 0) return null;
    this.#cancelPoll(deviceId, new RelayError('POLL_REPLACED', 'poll replaced', 409));
    return await new Promise((resolve, reject) => {
      const waiterToken = {};
      const timer = setTimeout(() => {
        const current = this.pollWaiters.get(deviceId);
        if (current?.token === waiterToken) this.pollWaiters.delete(deviceId);
        resolve(null);
      }, wait);
      timer.unref?.();
      this.pollWaiters.set(deviceId, {
        token: waiterToken,
        epoch: Number(connectionEpoch),
        runtimeId,
        resolve: (value) => {
          clearTimeout(timer);
          this.pollWaiters.delete(deviceId);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.pollWaiters.delete(deviceId);
          reject(error);
        },
      });
    });
  }

  async dispatch({ bearerToken, deviceId, payload, deadlineMs = 30_000 }) {
    const account = await this.accountForBearer(bearerToken);
    return this.dispatchForAccount({ accountId: account.account_id, deviceId, payload, deadlineMs });
  }

  async dispatchForAccount({ accountId, deviceId, payload, deadlineMs = 30_000 }) {
    const row = this.store.deviceForAccount(accountId, deviceId);
    if (!row) fail('DEVICE_NOT_FOUND', 'device not found', 404);
    const state = this.summary(row);
    if (state.revoked) fail('DEVICE_REVOKED', 'device revoked', 403);
    if (!state.online) fail('DEVICE_OFFLINE', 'device offline', 409);
    if (!state.ready) fail('DEVICE_NOT_READY', 'device not ready', 409);
    const session = this.activeSessions.get(deviceId);
    const requestId = randomUUID();
    const deadline = this.now() + Math.max(1, Math.min(Number(deadlineMs) || 30_000, 120_000));
    const item = {
      requestId,
      accountId,
      deviceId,
      connectionEpoch: session.connectionEpoch,
      runtimeId: session.runtimeId,
      deadline,
      payload,
      resolve: null,
      reject: null,
      timer: null,
      queued: false,
    };
    const promise = new Promise((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
      item.timer = setTimeout(() => this.#rejectPending(requestId, new RelayError('REQUEST_DEADLINE_EXCEEDED', 'request deadline exceeded', 504)), Math.max(1, deadline - this.now()));
      item.timer.unref?.();
    });
    this.pending.set(requestId, item);
    this.#queueRequest(requestId);
    this.logger({ event: 'request_dispatched', deviceId, requestId });
    return await promise;
  }

  respondAgent({ deviceId, credential, runtimeId, connectionEpoch, requestId, response }) {
    this.#validateAgent({ deviceId, credential, runtimeId, connectionEpoch });
    const item = this.pending.get(requestId);
    if (!item) fail('REQUEST_NOT_PENDING', 'request is not pending', 409);
    if (item.deviceId !== deviceId || item.runtimeId !== runtimeId || Number(item.connectionEpoch) !== Number(connectionEpoch)) fail('REQUEST_FENCE_MISMATCH', 'request response fence mismatch', 409);
    clearTimeout(item.timer);
    this.pending.delete(requestId);
    if (response && typeof response === 'object' && typeof response.ok === 'boolean') {
      if (response.ok) {
        item.resolve(response.value);
      } else {
        const code = typeof response.error?.code === 'string' ? response.error.code : 'LOCAL_EXECUTION_FAILED';
        const message = typeof response.error?.message === 'string' ? response.error.message : 'local execution failed';
        item.reject(new RelayError(code, message, 502));
      }
    } else {
      // Backward-compatible seam for direct core tests/control callers that already
      // provide the device-local result rather than the DeviceRelayAgent terminal envelope.
      item.resolve(response);
    }
    this.logger({ event: 'request_completed', deviceId, requestId });
    return { accepted: true };
  }

  #queueRequest(requestId) {
    const item = this.pending.get(requestId);
    if (!item || item.queued) return;
    item.queued = true;
    const queue = this.queues.get(item.deviceId) || [];
    queue.push(requestId);
    this.queues.set(item.deviceId, queue);
    const waiter = this.pollWaiters.get(item.deviceId);
    if (waiter) {
      const envelope = this.#dequeueEnvelope(item.deviceId, waiter.epoch, waiter.runtimeId);
      if (envelope) waiter.resolve(envelope);
    }
  }

  #dequeueEnvelope(deviceId, connectionEpoch, runtimeId) {
    const queue = this.queues.get(deviceId) || [];
    while (queue.length) {
      const requestId = queue.shift();
      const item = this.pending.get(requestId);
      if (!item) continue;
      item.queued = false;
      if (item.runtimeId !== runtimeId || Number(item.connectionEpoch) !== Number(connectionEpoch)) continue;
      if (this.now() >= item.deadline) {
        this.#rejectPending(requestId, new RelayError('REQUEST_DEADLINE_EXCEEDED', 'request deadline exceeded', 504));
        continue;
      }
      return { requestId: item.requestId, deviceId: item.deviceId, connectionEpoch: item.connectionEpoch, runtimeId: item.runtimeId, deadline: item.deadline, payload: item.payload };
    }
    if (queue.length === 0) this.queues.delete(deviceId);
    return null;
  }

  #rejectPending(requestId, error) {
    const item = this.pending.get(requestId);
    if (!item) return;
    clearTimeout(item.timer);
    this.pending.delete(requestId);
    item.reject(error);
  }

  #cancelPoll(deviceId, error) {
    const waiter = this.pollWaiters.get(deviceId);
    if (waiter) waiter.reject(error);
  }

  #fenceDevice(deviceId, error) {
    this.activeSessions.delete(deviceId);
    this.#cancelPoll(deviceId, error);
    this.queues.delete(deviceId);
    for (const item of [...this.pending.values()]) if (item.deviceId === deviceId) this.#rejectPending(item.requestId, error);
  }

  close() {
    for (const deviceId of [...this.pollWaiters.keys()]) this.#cancelPoll(deviceId, new RelayError('RELAY_RESTARTED', 'relay stopped', 503));
    for (const item of [...this.pending.values()]) this.#rejectPending(item.requestId, new RelayError('RELAY_RESTARTED', 'relay stopped', 503));
    this.activeSessions.clear();
    this.queues.clear();
  }
}
