// chatgpt-codex-orchestrator: minimal mutation ownership (v0.2 M1).
// Single-process / single-session. owner = none | chatgpt | codex.
// No distributed locking. CHATGPT_DIRECT_LOCAL mutation is NOT implemented yet.
//
// The safety boundary is execution ownership, not a blanket write prohibition:
// a writer must be the current mutation_owner; a non-owner attempting a mutation
// fails closed. Read is always allowed.

export const MUTATION_OWNERS = ['none', 'chatgpt', 'codex'];
export const UNIT_STATES = ['running', 'reconciled', 'interrupted', 'unknown'];

export class MutationOwnerError extends Error {
  constructor(msg) { super(msg); this.name = 'MutationOwnerError'; }
}

export class MutationOwner {
  constructor({ owner = 'none' } = {}) {
    if (!MUTATION_OWNERS.includes(owner)) throw new MutationOwnerError(`invalid owner: ${owner}`);
    this._owner = owner;
    this._unit = null; // running | reconciled | interrupted | unknown
  }

  get owner() { return this._owner; }
  get unitState() { return this._unit; }
  isNone() { return this._owner === 'none'; }

  // Acquire ownership for a mutating unit. Fails closed if another owner holds it.
  acquire(desired) {
    if (!MUTATION_OWNERS.includes(desired) || desired === 'none') {
      throw new MutationOwnerError(`invalid acquire: ${desired}`);
    }
    if (this._owner !== 'none' && this._owner !== desired) {
      throw new MutationOwnerError(`cannot acquire ${desired}: workspace already owned by ${this._owner}`);
    }
    if (this._owner === desired && this._unit === 'running') {
      // idempotent re-acquire of an already-running unit is allowed.
      return { acquired: true, owner: this._owner, unit: this._unit };
    }
    this._owner = desired;
    this._unit = 'running';
    return { acquired: true, owner: this._owner, unit: this._unit };
  }

  // Mark the current unit state. 'unknown' / 'interrupted' block silent release.
  markUnitState(state) {
    if (!UNIT_STATES.includes(state)) throw new MutationOwnerError(`invalid unit state: ${state}`);
    this._unit = state;
    return this._unit;
  }

  // Release ownership. Only after the mutating unit reaches a reconciled terminal
  // state unless force=true is passed after explicit reconciliation.
  release({ force = false } = {}) {
    if (this._owner === 'none') return { released: false, owner: 'none', unit: null };
    if (!force && this._unit !== 'reconciled') {
      throw new MutationOwnerError(`cannot release ownership: unit not reconciled (state=${this._unit}); reconcile first`);
    }
    this._owner = 'none';
    this._unit = null;
    return { released: true, owner: 'none', unit: null };
  }

  // Guard: can `owner` mutate now? Throws if a different owner holds the workspace.
  assertCanWrite(owner) {
    if (this._owner !== 'none' && this._owner !== owner) {
      throw new MutationOwnerError(`write by ${owner} denied: workspace owned by ${this._owner}`);
    }
    return true;
  }
}
