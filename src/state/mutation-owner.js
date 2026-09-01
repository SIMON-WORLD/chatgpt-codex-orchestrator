// chatgpt-codex-orchestrator: mutation ownership (v0.2 M1).
// Single-process / single-session. owner = none | chatgpt | codex.
// A mutation unit is a stable unit identity (unitId, e.g. jobId#turn) that the
// owner currently holds. Only ONE unit may be active at a time per workspace for
// a given owner. No distributed locking.
//
// Safety boundary is execution ownership, not a blanket write prohibition.
// Rules:
//   - acquire(owner, unitId): different owner fails; same owner + same unitId
//     (running) is idempotent; same owner + different unitId fails unless the
//     current unit is reconciled; a new unit may begin only after the previous
//     unit is reconciled / explicitly released.

export const MUTATION_OWNERS = ['none', 'chatgpt', 'codex'];
export const UNIT_STATES = ['running', 'reconciled', 'interrupted', 'unknown'];

export class MutationOwnerError extends Error {
  constructor(msg) { super(msg); this.name = 'MutationOwnerError'; }
}

export class MutationOwner {
  constructor({ owner = 'none' } = {}) {
    if (!MUTATION_OWNERS.includes(owner)) throw new MutationOwnerError(`invalid owner: ${owner}`);
    this._owner = owner;
    this._unitId = null;
    this._unitState = null;
  }

  get owner() { return this._owner; }
  get unitId() { return this._unitId; }
  get unitState() { return this._unitState; }
  isNone() { return this._owner === 'none'; }

  // Acquire ownership bound to a mutation unit. unitId is required.
  acquire(owner, unitId) {
    if (!MUTATION_OWNERS.includes(owner) || owner === 'none') {
      throw new MutationOwnerError(`invalid acquire owner: ${owner}`);
    }
    if (unitId == null || String(unitId) === '') {
      throw new MutationOwnerError('acquire requires a non-empty unitId');
    }
    const u = String(unitId);

    if (this._owner !== 'none' && this._owner !== owner) {
      throw new MutationOwnerError(`cannot acquire ${owner}: workspace already owned by ${this._owner}`);
    }

    if (this._owner === 'none') {
      this._owner = owner;
      this._unitId = u;
      this._unitState = 'running';
      return { acquired: true, owner, unitId: u, unitState: 'running' };
    }

    // Same owner.
    if (this._unitId === u) {
      this._unitState = 'running';
      return { acquired: true, owner, unitId: u, unitState: 'running' };
    }

    // Different unitId: only allowed if the current unit is reconciled.
    if (this._unitState !== 'reconciled') {
      throw new MutationOwnerError(`cannot acquire ${u}: active unit ${this._unitId} not reconciled (state=${this._unitState})`);
    }
    this._unitId = u;
    this._unitState = 'running';
    return { acquired: true, owner, unitId: u, unitState: 'running' };
  }

  markUnitState(state) {
    if (!UNIT_STATES.includes(state)) throw new MutationOwnerError(`invalid unit state: ${state}`);
    this._unitState = state;
    return this._unitState;
  }

  // Release ownership. Only after the unit reaches a reconciled terminal state
  // (unless force=true passed after explicit reconciliation).
  release({ force = false } = {}) {
    if (this._owner === 'none') return { released: false, owner: 'none', unitId: null, unitState: null };
    if (!force && this._unitState !== 'reconciled') {
      throw new MutationOwnerError(`cannot release ownership: unit not reconciled (state=${this._unitState}); reconcile first`);
    }
    this._owner = 'none';
    this._unitId = null;
    this._unitState = null;
    return { released: true, owner: 'none', unitId: null, unitState: null };
  }

  assertCanWrite(owner) {
    if (this._owner !== 'none' && this._owner !== owner) {
      throw new MutationOwnerError(`write by ${owner} denied: workspace owned by ${this._owner}`);
    }
    return true;
  }
}
