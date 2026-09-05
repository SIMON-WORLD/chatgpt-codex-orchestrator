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
import { runtimePaths } from '../runtime-paths.js';

export const GOVERNANCE_SCHEMA_VERSION = 1;
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
//     extension aliases such as CON.txt), trailing dot / trailing space, and the
//     literal '*' character (illegal in Windows filename components and left
//     unencoded by encodeURIComponent, so it is rejected rather than remapped).
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

// Atomic write + known-good backup (same proven pattern as src/task-state.js):
// 1) write temp, 2) copy current primary to .bak, 3) rename temp -> primary,
// 4) mirror the fresh primary into .bak so the backup always equals the last good state.
export function atomicWriteJsonWithBackup(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  if (fs.existsSync(file)) { try { fs.copyFileSync(file, file + '.bak'); } catch {} }
  fs.renameSync(tmp, file);
  try { fs.copyFileSync(file, file + '.bak'); } catch {}
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
  return obj;
}

function defaultAuthorityMeta() {
  return { generation: 0, token: null, createdAt: null, lastTakeoverAt: null };
}

export function makeGovernanceEnvelope({ state, projectKey = null, identity = null, authority = null, taskId = null, savedAt = null }) {
  const tid = taskId || (state && state.taskId) || null;
  if (!tid) throw new GovernanceStoreError('cannot persist governance state without a taskId', { code: 'bad_request' });
  return {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    kind: GOVERNANCE_STATE_KIND,
    taskId: tid,
    projectKey: projectKey ?? null,
    identity: identity ?? null,
    authority: authority && typeof authority === 'object' ? { ...defaultAuthorityMeta(), ...authority } : null,
    state,
    savedAt: savedAt || new Date().toISOString(),
  };
}

export class GovernanceStore {
  constructor({ dataRoot, namespace = 'default' } = {}) {
    if (!dataRoot) throw new GovernanceStoreError('GovernanceStore requires a dataRoot', { code: 'bad_request' });
    this.dataRoot = path.resolve(dataRoot);
    this.namespace = String(namespace);
    this.dir = governanceNamespaceDir(this.dataRoot, this.namespace);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  _taskFile(taskId) { return path.join(this.dir, taskFileName(taskId)); }

  hasTask(taskId) {
    const file = this._taskFile(taskId);
    return fs.existsSync(file) || fs.existsSync(file + '.bak');
  }

  saveTask(taskId, envelope) {
    const env = makeGovernanceEnvelope({ ...envelope, taskId });
    atomicWriteJsonWithBackup(this._taskFile(taskId), env);
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
