// chatgpt-codex-orchestrator: durable canonical Governance store (Brain Continuity core).
// Namespace-scoped, versioned, atomic-write + known-good-backup persistence under the
// existing runtime dataRoot (runtime/governance/<namespace>/). This file only owns the
// storage contract (write/load/scan/migration); lifecycle semantics stay in
// GovernanceService and the durable wrapper (durable.js).
//
// Fail-closed load contract:
//   - primary valid                   -> hydrate primary
//   - primary corrupt + backup valid  -> hydrate backup
//   - primary + backup corrupt        -> named GovernanceStoreError(corrupt)
//   - future/unknown schema           -> named GovernanceStoreError(schema_unsupported)
//   - known older schema              -> explicit deterministic migration
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runtimePaths } from '../runtime-paths.js';

export const GOVERNANCE_SCHEMA_VERSION = 2;
export const GOVERNANCE_STATE_KIND = 'brain-continuity.governance-task';

export class GovernanceStoreError extends Error {
  constructor(message, { code = 'error', taskId = null } = {}) {
    super(message);
    this.name = 'GovernanceStoreError';
    this.code = code;
    this.taskId = taskId;
  }
}

// Windows reserved device-name bases (case-insensitive, extension-independent).
const WIN_RESERVED_BASE = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

// Stable, named fail-closed error for an unsafe filesystem component (namespace or
// task id). Invalid configuration is never silently remapped to another namespace
// (which could create fresh Governance state).
function invalidComponentError(value, kind, reason) {
  return new GovernanceStoreError(
    `invalid governance ${kind} ${JSON.stringify(String(value == null ? '' : value))}: ${reason}; refusing to map it to a filesystem path`,
    { code: 'invalid_component' },
  );
}

// Validate and deterministically encode ONE semantic component (namespace or taskId)
// into a single strict filesystem component while PRESERVING the historical
// byte-for-byte mapping for ordinary components:
//   - the historical mapping (encodeURIComponent(value).replace(/%20/g, ' ')) is kept,
//     so ordinary spaces and previously percent-encoded separators/control bytes map
//     exactly as before (no silent remap that could lose/recreate existing state);
//   - empty values keep the historical safe '_' component;
//   - only genuinely unsafe/aliased/collapsing values fail closed: exact '.' / '..',
//     Windows reserved device names (CON/PRN/AUX/NUL/COMx/LPTx, any case, including
//     extension aliases such as CON.txt), trailing dot / trailing space, the literal
//     '*' character (illegal in Windows filename components and left unencoded by
//     encodeURIComponent, so it is rejected rather than remapped), and - for task ids
//     only - reserved governance internal filename stems ('writer' / '.writer*' that
//     would collide with the canonical writer slot or scan-excluded internal files).
// Slash/backslash/control bytes remain allowed because they are deterministically
// percent-encoded into ONE component (regressions prove strict-child containment).
export function encodeGovernanceComponent(value, kind = 'component') {
  const s = String(value == null ? '' : value);
  if (s === '') return '_'; // historical safe single-component mapping
  if (s === '.' || s === '..') throw invalidComponentError(value, kind, `component '${s}' would collapse the parent path`);
  if (/[ .]$/.test(s)) throw invalidComponentError(value, kind, 'component must not end with a dot or space (Windows alias)');
  if (s.includes('*')) throw invalidComponentError(value, kind, "component contains the Windows-illegal '*' character");
  const base = s.split('.')[0].toUpperCase();
  if (WIN_RESERVED_BASE.has(base)) throw invalidComponentError(value, kind, `component uses the reserved Windows device name '${base}'`);
  let encoded;
  try {
    encoded = encodeURIComponent(s);
  } catch {
    throw invalidComponentError(value, kind, 'component cannot be percent-encoded');
  }
  // Historical mapping: percent-encoded spaces map back to literal spaces on disk.
  encoded = encoded.replace(/%20/g, ' ');
  if (encoded === '' || encoded === '.' || encoded === '..') throw invalidComponentError(value, kind, 'component encodes to an unsafe path segment');
  if (kind === 'taskId' && (encoded === 'writer' || encoded.startsWith('.writer'))) {
    // Collides with internal governance filenames: writer.json (canonical writer
    // slot), writer.json.elect / *.tmp, and '.writer*' internal/scan-excluded files.
    throw invalidComponentError(value, kind, `task id maps to reserved governance internal filename stem '${encoded}'`);
  }
  return encoded;
}

// Namespace directory is always a STRICT CHILD of the dedicated runtime/governance
// root. Invalid namespace configuration fails closed with a named error instead of
// collapsing/escaping the boundary.
export function governanceNamespaceDir(dataRoot, namespace = 'default') {
  const governanceRoot = path.join(runtimePaths(dataRoot).runtime, 'governance');
  const component = encodeGovernanceComponent(namespace, 'namespace');
  const dir = path.join(governanceRoot, component);
  const rel = path.relative(governanceRoot, dir);
  if (rel === '' || rel === '.' || path.isAbsolute(rel) || rel.split(path.sep).includes('..')) {
    throw invalidComponentError(namespace, 'namespace', 'resolved directory is not a strict child of the dedicated governance root');
  }
  return dir;
}

function taskFileName(taskId) { return encodeGovernanceComponent(taskId, 'taskId') + '.json'; }

// Atomic write + known-good backup:
// 1) write temp JSON;
// 2) atomically rename temp -> primary (the single commit point);
// 3) mirror the freshly committed primary into `.bak` so the backup always equals the
//    last good state.
// A corrupt/unvalidated primary is NEVER copied over the last known-good backup
// before commit: if the commit rename fails, the previous committed snapshot (primary
// or `.bak`) is preserved and the store remains recoverable/fail-closed.
export function atomicWriteJsonWithBackup(file, obj, { rename = fs.renameSync } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  rename(tmp, file);
  try { fs.copyFileSync(file, file + '.bak'); } catch {}
}

function syncAdmissionDirectory(dir) {
  if (process.platform === 'win32') {
    // libuv's read-only directory descriptor returns EPERM for fsync on NTFS.
    // Use a write-capable native directory handle, never a volume flush or skip.
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    if (!path.isAbsolute(systemRoot)) {
      throw new GovernanceStoreError('Windows system root is not absolute', { code: 'admission_storage_unverified' });
    }
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const helper = fileURLToPath(new URL('./windows-directory-flush.ps1', import.meta.url));
    // Keep only the OS locations needed by Windows PowerShell and its .NET compiler.
    // Avoid inheriting application or connector credentials into the helper.
    const env = {
      SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(),
      Path: path.join(systemRoot, 'System32'),
    };
    for (const key of ['SystemDrive', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    let output;
    try {
      output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-File', helper, '-Directory', dir], {
        windowsHide: true, timeout: 15000, maxBuffer: 65536,
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env,
      });
    } catch (error) {
      const phase = /^governance-flush:(validate|compile|flush)\r?$/gm;
      const lastPhase = Array.from(String(error.stderr ?? '').matchAll(phase)).at(-1)?.[1] ?? 'launch';
      const reason = error.code === 'ETIMEDOUT' ? 'timed out' : 'failed';
      throw new GovernanceStoreError(`Windows checked directory flush ${reason} (${lastPhase})`,
        { code: 'admission_storage_unverified' });
    }
    if (output.trim() !== 'directory-flush-ok') {
      throw new GovernanceStoreError('Windows directory flush was not confirmed', { code: 'admission_storage_unverified' });
    }
    return;
  }
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeFlushedJson(file, value) {
  const tmp = file + '.admission.tmp';
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function tryReadEnvelope(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not an object');
    return obj;
  } catch (e) {
    throw new GovernanceStoreError(`corrupt governance state at ${file}: ${e.message}`, { code: 'corrupt' });
  }
}

// Explicit tested migrations. Each step transforms a persisted envelope from one
// schema version to the next. Unknown/future versions are never auto-hydrated.
const MIGRATIONS = {
  // 0 -> 1: pre-continuity snapshot gained the envelope fields (kind/authority).
  0: (env) => ({
    ...env,
    schemaVersion: 1,
    kind: env.kind || GOVERNANCE_STATE_KIND,
    authority: env.authority && typeof env.authority === 'object' ? env.authority : null,
    projectKey: env.projectKey ?? null,
    identity: env.identity ?? null,
  }),
  1: (env) => ({ ...env, schemaVersion: 2, authorizationRevision: 0, relayCodex: null }),
};

function migrateEnvelope(env) {
  const current = GOVERNANCE_SCHEMA_VERSION;
  const v = env.schemaVersion;
  if (v === current) return env;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new GovernanceStoreError(`governance state has an invalid schema version (${String(v)}); refusing to hydrate`, { code: 'schema_unsupported' });
  }
  if (v > current) {
    throw new GovernanceStoreError(`governance state schema version ${v} is newer than supported version ${current}; refusing to hydrate as a trusted task`, { code: 'schema_unsupported' });
  }
  let out = env;
  for (let step = v; step < current; step++) {
    const migration = MIGRATIONS[step];
    if (!migration) throw new GovernanceStoreError(`no explicit migration exists from governance schema version ${step}; refusing to hydrate`, { code: 'schema_unsupported' });
    out = migration(out);
  }
  return out;
}

// Structural validation that the object is a canonical governance task envelope.
function validateEnvelope(obj, { taskId = null } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new GovernanceStoreError('invalid governance envelope: not an object', { code: 'corrupt', taskId });
  }
  if (obj.kind && obj.kind !== GOVERNANCE_STATE_KIND) {
    throw new GovernanceStoreError(`invalid governance envelope kind: ${String(obj.kind)}`, { code: 'corrupt', taskId });
  }
  if (!obj.taskId || typeof obj.taskId !== 'string') {
    throw new GovernanceStoreError('invalid governance envelope: missing taskId', { code: 'corrupt', taskId });
  }
  if (taskId != null && obj.taskId !== taskId) {
    throw new GovernanceStoreError(`governance envelope taskId mismatch: expected ${taskId}, got ${obj.taskId}`, { code: 'corrupt', taskId });
  }
  if (!obj.state || typeof obj.state !== 'object' || Array.isArray(obj.state)) {
    throw new GovernanceStoreError('invalid governance envelope: missing structured state', { code: 'corrupt', taskId });
  }
  if (obj.state.taskId !== obj.taskId) {
    throw new GovernanceStoreError('invalid governance envelope: state.taskId does not match envelope taskId', { code: 'corrupt', taskId });
  }
  if (obj.schemaVersion === 2 && (!Number.isSafeInteger(obj.authorizationRevision) ||
      obj.authorizationRevision < 0 || !validRelayCodexLedger(obj.relayCodex, obj.authorizationRevision))) {
    throw new GovernanceStoreError('invalid authorization revision or admission ledger', { code: 'corrupt', taskId });
  }
  return obj;
}

const digest = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
function validRelayCodexLedger(ledger, revision) {
  if (ledger === null) return true;
  if (!ledger || typeof ledger.blocked !== 'boolean' || !Array.isArray(ledger.records) ||
      ledger.records.length > 4096 || (!ledger.blocked && !digest(ledger.bootId))) return false;
  const keys = new Set(), permits = new Set();
  for (const r of ledger.records) {
    if (!r || ![r.key, r.tokenHash, r.operationDigest, r.authorityHash, r.contextDigest, r.bootId].every(digest) ||
        !Number.isSafeInteger(r.revision) || r.revision < 1 || r.revision > revision ||
        !Number.isSafeInteger(r.parentGeneration) || r.parentGeneration < 0 ||
        !Number.isFinite(r.expiresAt) || typeof r.governanceStep !== 'string' || !r.governanceStep ||
        !['issued','revoked','reserved','dispatched','acknowledged'].includes(r.state) ||
        keys.has(r.key) || permits.has(r.tokenHash)) return false;
    keys.add(r.key);
    permits.add(r.tokenHash);
  }
  return true;
}

function defaultAuthorityMeta() {
  return { generation: 0, token: null, createdAt: null, lastTakeoverAt: null };
}

export function makeGovernanceEnvelope({ state, projectKey = null, identity = null, authority = null, taskId = null, workspaceRoot = null, savedAt = null, authorizationRevision = 0, relayCodex = null }) {
  const tid = taskId || (state && state.taskId) || null;
  if (!tid) throw new GovernanceStoreError('cannot persist governance state without a taskId', { code: 'bad_request' });
  return {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    kind: GOVERNANCE_STATE_KIND,
    taskId: tid,
    projectKey: projectKey ?? null,
    identity: identity ?? null,
    workspaceRoot: workspaceRoot ?? null,
    authority: authority && typeof authority === 'object' ? { ...defaultAuthorityMeta(), ...authority } : null,
    authorizationRevision,
    relayCodex,
    state,
    savedAt: savedAt || new Date().toISOString(),
  };
}

export class GovernanceStore {
  constructor({ dataRoot, namespace = 'default', syncDirectory = syncAdmissionDirectory } = {}) {
    if (!dataRoot) throw new GovernanceStoreError('GovernanceStore requires a dataRoot', { code: 'bad_request' });
    this.dataRoot = path.resolve(dataRoot);
    this.namespace = String(namespace);
    this.dir = governanceNamespaceDir(this.dataRoot, this.namespace);
    this.syncDirectory = syncDirectory;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  _taskFile(taskId) { return path.join(this.dir, taskFileName(taskId)); }

  hasTask(taskId) {
    const file = this._taskFile(taskId);
    return fs.existsSync(file) || fs.existsSync(file + '.bak');
  }

  _matchingSnapshot(taskId) {
    const file = this._taskFile(taskId);
    const primary = fs.readFileSync(file, 'utf8');
    if (primary !== fs.readFileSync(file + '.bak', 'utf8')) {
      throw new GovernanceStoreError('task primary/backup do not match', { code: 'admission_storage_unverified', taskId });
    }
    return migrateEnvelope(validateEnvelope(JSON.parse(primary), { taskId }));
  }

  loadAdmissionTask(taskId) {
    const env = this._matchingSnapshot(taskId);
    if (env.relayCodex?.blocked) {
      throw new GovernanceStoreError('admission history is quarantined', { code: 'admission_storage_unverified', taskId });
    }
    return env;
  }

  saveTask(taskId, envelope, { expectedRevision, updateAdmission = null } = {}) {
    const file = this._taskFile(taskId);
    const prior = this.hasTask(taskId) ? this.loadTask(taskId) : null;
    const revision = prior?.authorizationRevision ?? 0;
    if ((expectedRevision !== undefined && revision !== expectedRevision) || revision === Number.MAX_SAFE_INTEGER) {
      throw new GovernanceStoreError('task authorization revision conflict', { code: 'authorization_revision_conflict', taskId });
    }
    let relayCodex = prior?.relayCodex ?? null;
    const strict = !!updateAdmission || (!!relayCodex && !relayCodex.blocked);
    if (strict) {
      if (!prior || this.loadAdmissionTask(taskId).authorizationRevision !== revision) {
        throw new GovernanceStoreError('admission has no verified predecessor', { code: 'admission_storage_unverified', taskId });
      }
      if (updateAdmission) relayCodex = updateAdmission(structuredClone(relayCodex), revision + 1);
    } else if (prior && !relayCodex) {
      // Ordinary recovery is not proof that an admission never dispatched.
      try { this._matchingSnapshot(taskId); }
      catch { relayCodex = { blocked: true, bootId: null, records: [] }; }
    }
    const env = validateEnvelope(makeGovernanceEnvelope({
      ...envelope, taskId, authorizationRevision: revision + 1, relayCodex,
    }), { taskId });
    if (strict) {
      // Probe before altering a verified snapshot. An unavailable flush fails closed.
      // The task/namespace directories may have been created by the first PLAN.
      // Flush the ancestor entries too before issuing authority from this history.
      if (!prior.relayCodex) {
        for (let dir = path.dirname(this.dir); ; dir = path.dirname(dir)) {
          this.syncDirectory(dir);
          if (path.dirname(dir) === dir) break;
        }
      }
      this.syncDirectory(this.dir);
      writeFlushedJson(file, env);
      this.syncDirectory(this.dir);
      writeFlushedJson(file + '.bak', env);
      this.syncDirectory(this.dir);
      if (JSON.stringify(this.loadAdmissionTask(taskId)) !== JSON.stringify(env)) {
        throw new GovernanceStoreError('admission commit readback mismatch', { code: 'admission_storage_unverified', taskId });
      }
    } else {
      atomicWriteJsonWithBackup(file, env);
    }
    return env;
  }

  // Read one candidate file: parse + schema-precheck + validate + migrate.
  // A future/unknown schema is a HARD fail (schema_unsupported) and is never silently
  // downgraded to a backup; parse/structural corruption returns the error so the caller
  // may try the known-good backup.
  _loadCandidate(file, taskId) {
    if (!fs.existsSync(file)) return { env: null, error: null };
    let obj = null;
    try {
      obj = tryReadEnvelope(file);
    } catch (e) {
      return { env: null, error: e };
    }
    if (obj && typeof obj.schemaVersion === 'number' && obj.schemaVersion > GOVERNANCE_SCHEMA_VERSION) {
      return {
        env: null,
        error: new GovernanceStoreError(`governance state schema version ${obj.schemaVersion} is newer than supported version ${GOVERNANCE_SCHEMA_VERSION}; refusing to hydrate as a trusted task`, { code: 'schema_unsupported', taskId }),
      };
    }
    try {
      const env = migrateEnvelope(validateEnvelope(obj, { taskId }));
      return { env, error: null };
    } catch (e) {
      return { env: null, error: e };
    }
  }

  // Shared primary -> backup -> named fail-closed resolution. Both loadTask() and the
  // bounded semantic enumeration reuse EXACTLY the same semantics so a recoverable
  // candidate (corrupt primary + valid backup, or backup-only after primary loss) is
  // never treated as corruption, while primary+backup corruption and future/unknown
  // schema stay fail-closed.
  _resolveStateFile(primaryPath, backupPath, { taskId = null } = {}) {
    const primary = this._loadCandidate(primaryPath, taskId);
    if (primary.env) return primary.env;
    if (primary.error && primary.error.code === 'schema_unsupported') throw primary.error;
    const bak = this._loadCandidate(backupPath, taskId);
    if (bak.env) return bak.env;
    if (bak.error && bak.error.code === 'schema_unsupported') throw bak.error;
    const detail = (primary.error && primary.error.message) || (bak.error && bak.error.message) || 'no primary or backup file';
    throw new GovernanceStoreError(`governance state corrupt (primary and backup) for ${taskId || path.basename(primaryPath)}: ${detail}`, { code: 'corrupt', taskId });
  }

  // Primary -> backup -> named fail-closed error. Migrations run for known older
  // schema versions; future/unknown schema throws schema_unsupported (never falls back).
  loadTask(taskId) {
    const file = this._taskFile(taskId);
    return this._resolveStateFile(file, file + '.bak', { taskId });
  }

  // Strict namespace scan used only by bounded recovery. Corruption is never treated
  // as absence. Each candidate (identified by a .json primary and/or its .json.bak)
  // is resolved with the SAME primary -> backup -> schema semantics as loadTask, so a
  // candidate with a corrupt primary + valid backup (or only a backup) is enumerated
  // normally. Only candidates where primary AND backup are corrupt/unreadable, or
  // whose primary carries a future/unknown schema, fail closed as corrupt.
  scanStrict() {
    if (!fs.existsSync(this.dir)) return { tasks: [], corruptCount: 0 };
    const names = fs.readdirSync(this.dir);
    const keys = new Set();
    for (const name of names) {
      if (name === 'writer.json' || name.startsWith('.writer') || name.endsWith('.tmp')) continue;
      if (name.endsWith('.json.bak')) { keys.add(name.slice(0, -9)); continue; }
      if (name.endsWith('.json')) { keys.add(name.slice(0, -5)); continue; }
    }
    const tasks = [];
    let corruptCount = 0;
    for (const key of keys) {
      try {
        const env = this._resolveStateFile(path.join(this.dir, key + '.json'), path.join(this.dir, key + '.json.bak'), { taskId: null });
        tasks.push(env);
      } catch {
        corruptCount += 1;
      }
    }
    return { tasks, corruptCount };
  }

  listTaskIds() {
    return this.scanStrict().tasks.map((e) => e.taskId);
  }
}
