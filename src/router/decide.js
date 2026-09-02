// chatgpt-codex-orchestrator: deterministic Capability Router decision (v0.2 M4).
// Pure, model-free decision over structured task facts. It NEVER calls a model,
// NEVER reasons over natural language Brain text, and is fully deterministic.
//
// Routing targets (RFC v0.2 capability-routing §B):
//   CHATGPT_NATIVE        native ChatGPT product capability only
//   CHATGPT_DIRECT_LOCAL  local read / bounded exact mutation
//   CODEX_DELEGATE        multi-file / unknown-root-cause / iterative / long-running
//   HYBRID                both native AND local required (composition, not a fallback)
//
// HYBRID is never a mutation owner: ownership is always delegated to the local leg.

export const ROUTES = Object.freeze(['CHATGPT_NATIVE', 'CHATGPT_DIRECT_LOCAL', 'CODEX_DELEGATE', 'HYBRID']);
export const MUTATION_OWNERS = Object.freeze(['none', 'chatgpt', 'codex']);

// The full deterministic fact surface the router consumes.
export const FACT_KEYS = Object.freeze([
  'requiresNative', 'requiresLocal', 'readOnly', 'mutationRequired',
  'exactChangeKnown', 'boundedChange', 'multiFile', 'unknownRootCause',
  'iterative', 'longRunning',
]);

export class RouterError extends Error {
  constructor(msg) { super(msg); this.name = 'RouterError'; }
}

// Normalize / validate the fact surface. Unknown keys are ignored; missing booleans
// default to false; non-boolean values are rejected (fail closed, never guess).
export function normalizeFacts(facts) {
  const src = facts && typeof facts === 'object' ? facts : {};
  const out = {};
  for (const k of FACT_KEYS) {
    const v = src[k];
    if (v === undefined || v === null) out[k] = false;
    else if (typeof v === 'boolean') out[k] = v;
    else throw new RouterError(`routing fact '${k}' must be a boolean`);
  }
  return out;
}

// Route the local leg independently. Returns a READ-ONLY route name always.
function routeLocalLeg(facts) {
  const isReadOnly = facts.readOnly || !facts.mutationRequired;
  if (isReadOnly) return 'CHATGPT_DIRECT_LOCAL';

  const complex = facts.multiFile || facts.unknownRootCause || facts.iterative || facts.longRunning;
  if (complex) return 'CODEX_DELEGATE';

  if (facts.boundedChange && facts.exactChangeKnown) return 'CHATGPT_DIRECT_LOCAL';

  // Mutation required but not bounded/exactly known -> conservative local leg.
  return 'CODEX_DELEGATE';
}

function ownerForLocalLeg(leg, facts) {
  const mutation = facts.mutationRequired && !facts.readOnly;
  if (leg === 'CHATGPT_DIRECT_LOCAL') return mutation ? 'chatgpt' : 'none';
  if (leg === 'CODEX_DELEGATE') return mutation ? 'codex' : 'none';
  return 'none';
}

export function decideRoute(input) {
  const facts = normalizeFacts(input);
  const reasonCodes = [];

  let route;
  if (facts.requiresNative && !facts.requiresLocal) {
    route = 'CHATGPT_NATIVE';
    reasonCodes.push('native_only');
  } else if (!facts.requiresNative && !facts.requiresLocal) {
    route = 'CHATGPT_NATIVE';
    reasonCodes.push('no_capability_required');
  } else if (!facts.requiresNative && facts.requiresLocal) {
    route = routeLocalLeg(facts);
    reasonCodes.push('local_only');
  } else {
    route = 'HYBRID';
    reasonCodes.push('capability_both_then_compose');
  }

  let localRoute = null;
  if (route === 'HYBRID') {
    localRoute = routeLocalLeg(facts);
    reasonCodes.push(localRoute === 'CHATGPT_DIRECT_LOCAL' ? 'local_leg_direct_local' : 'local_leg_codex_delegate');
  }

  let mutationOwnerExpected;
  if (route === 'HYBRID') {
    // HYBRID is never a mutation owner; the local leg owns.
    mutationOwnerExpected = ownerForLocalLeg(localRoute, facts);
    reasonCodes.push('hybrid_not_mutation_owner');
  } else if (route === 'CHATGPT_NATIVE') {
    mutationOwnerExpected = 'none';
  } else {
    mutationOwnerExpected = ownerForLocalLeg(route, facts);
  }

  return { route, localRoute, reasonCodes, mutationOwnerExpected, facts };
}
