// chatgpt-codex-orchestrator: ephemeral capability observations (Brain Continuity core).
// A capability observation is scoped evidence (capability/provider/resource/operation/
// observedAt) recorded for diagnostics. It is deliberately NOT durable control truth:
// observations live in an in-memory ledger bound to the current session/runtime, a
// re-entry clears the session epoch, and a persisted snapshot can never be replayed as
// current availability. Prior-session availability must never become timeless proof.

export function makeObservationSessionId() {
  return 'session-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
}

export class CapabilityObservationError extends Error {
  constructor(msg) { super(msg); this.name = 'CapabilityObservationError'; }
}

const VALID_STATUSES = ['available', 'unavailable', 'unknown', 'error'];

export class CapabilityObservationLedger {
  constructor({ now = () => Date.now(), maxAgeMs = 5 * 60 * 1000 } = {}) {
    this._now = now;
    this._maxAgeMs = maxAgeMs;
    this._sessionId = makeObservationSessionId();
    this._epoch = 0;
    this._entries = [];
  }

  get sessionId() { return this._sessionId; }
  get epoch() { return this._epoch; }

  // Record a scoped observation for the CURRENT session/epoch only.
  record({ capability, provider = null, resourceScope = null, operation = null, status = 'available' }) {
    if (!capability) throw new CapabilityObservationError('capability observation requires a capability');
    if (!VALID_STATUSES.includes(status)) throw new CapabilityObservationError(`invalid capability observation status: ${status}`);
    const entry = {
      capability,
      provider: provider || null,
      resourceScope: resourceScope || null,
      operation: operation || null,
      status,
      observedAt: this._now(),
      sessionId: this._sessionId,
      epoch: this._epoch,
      ephemeral: true,
    };
    this._entries.push(entry);
    return entry;
  }

  entries() { return this._entries.slice(); }

  // Re-entry boundary: a replacement Parent session must not inherit observations.
  // Prior entries are kept only as diagnostics (never trusted as current availability).
  beginReentry() {
    this._epoch += 1;
    this._sessionId = makeObservationSessionId();
    const prior = this._entries.slice();
    this._entries = [];
    return { epoch: this._epoch, sessionId: this._sessionId, discardedObservations: prior.length };
  }

  // Availability is only current when observed in THIS session/epoch and fresh.
  availableNow({ capability, provider = null, resourceScope = null, operation = null } = {}) {
    const now = this._now();
    return this._entries.some((e) => {
      if (e.sessionId !== this._sessionId || e.epoch !== this._epoch) return false;
      if (e.capability !== capability) return false;
      if (provider != null && e.provider !== provider) return false;
      if (resourceScope != null && e.resourceScope !== resourceScope) return false;
      if (operation != null && e.operation !== operation) return false;
      if (e.status !== 'available') return false;
      if (now - e.observedAt > this._maxAgeMs) return false;
      return true;
    });
  }

  // Snapshot/load are diagnostics-only. Loading never marks entries current.
  snapshot() {
    return { sessionId: this._sessionId, epoch: this._epoch, entries: this._entries.slice() };
  }

  loadSnapshot(snap) {
    // Persisted/prior observations are diagnostics. They are replayed under the
    // CURRENT session only as non-authoritative history and are never treated as proof.
    const prior = (snap && Array.isArray(snap.entries) ? snap.entries : []).map((e) => ({
      ...e,
      sessionId: this._sessionId,
      epoch: this._epoch,
      status: e.status === 'available' ? 'unknown' : e.status, // never timelessly available
      ephemeral: true,
      restoredFromSnapshot: true,
    }));
    this._entries.push(...prior);
    return prior.length;
  }
}

// Re-entry gate: capability availability must be rediscovered, never inferred from a
// prior session. This is the single choke point used by continuity orchestration.
export function requireCapabilityRediscovery() {
  return {
    ok: false,
    requiresRediscovery: true,
    reason: 'capability availability is an ephemeral runtime observation; rediscover required capabilities before authorizing a new execution',
  };
}

export function capabilityIsCurrent(ledger, scope = {}) {
  if (!ledger) return false;
  return ledger.availableNow(scope);
}
