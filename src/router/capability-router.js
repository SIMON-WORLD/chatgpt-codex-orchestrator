// chatgpt-codex-orchestrator: Capability Router (v0.2 M4).
// Deterministic executor-selection router. It only maps structured task facts to a
// routing target; it does not reason over natural language and never calls a model.
// It is the executor-selection layer that sits under Governance.

import { decideRoute, normalizeFacts, validateConsistency, RouterError, ROUTES, MUTATION_OWNERS, ACCESS_MODES, FACT_KEYS } from './decide.js';

export class CapabilityRouter {
  constructor({ decide = decideRoute } = {}) {
    this._decide = decide;
  }

  // Deterministic routing over structured task facts.
  decide(facts) {
    return this._decide(facts);
  }

  // Facade used by read-only MCP tools. Validates before deciding.
  decideStrict(facts) {
    const normalized = normalizeFacts(facts);
    return this._decide(normalized);
  }
}

export function createCapabilityRouter(opts) { return new CapabilityRouter(opts); }

export { decideRoute, normalizeFacts, validateConsistency, RouterError, ROUTES, MUTATION_OWNERS, ACCESS_MODES, FACT_KEYS };
