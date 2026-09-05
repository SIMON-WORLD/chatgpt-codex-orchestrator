// chatgpt-codex-orchestrator: bounded Context Capsule for Brain re-entry
// (Brain Continuity core). A replacement Parent session receives a bounded capsule
// derived from durable structured Governance state + freshly reacquired evidence -
// never a giant transcript handoff.
//
// Bounding contract: the capsule enforces deterministic structural/serialized limits
// on collection cardinality (acceptance/evidence/changed) and variable-length text
// (summaries, ASK_USER strings, ids). Truncation/count/reference metadata is always
// attached so a Parent knows the authoritative durable state contains more content.
// Truncation NEVER fabricates acceptance: statuses and references are only copied
// from the durable state for the included items.

export const CAPSULE_VERSION = 1;

export const CAPSULE_BOUNDS = Object.freeze({
  // Primary tier
  acceptanceItems: 50,
  evidenceItems: 40,
  changedItems: 40,
  maxTextLength: 200,
  maxSerializedBytes: 16 * 1024,
  // Deterministic fallback tier used when the primary tier still exceeds the bound
  fallbackAcceptanceItems: 20,
  fallbackEvidenceItems: 20,
  fallbackChangedItems: 20,
  fallbackMaxTextLength: 120,
});

function compactStatusList(acceptance = []) {
  return acceptance.map((a) => ({ id: a.id, required: a.required !== false, status: a.status || 'missing' }));
}

function truncText(value, max, field, marks) {
  if (typeof value !== 'string') return value;
  if (value.length <= max) return value;
  if (!marks.includes(field)) marks.push(field);
  return value.slice(0, max);
}

function boundedSlice(list, max) {
  const arr = Array.isArray(list) ? list : [];
  return { all: arr, included: arr.slice(0, max), total: arr.length };
}

// Deterministic next-safe-action derivation from durable state. This never authorizes
// an execution: it only names the next governance-safe step for the Parent to review.
export function deriveNextSafeAction(state) {
  if (!state || !state.taskId) return 'plan';
  if (state.control === 'DONE') return 'done';
  if (state.awaitingUser) return 'await_user_decision';
  const cur = state.steps && state.currentStepId ? state.steps[state.currentStepId] : null;
  if (!state.currentStepId || !cur) return 'task';
  const delegated = state.route === 'CODEX_DELEGATE' || state.localRoute === 'CODEX_DELEGATE';
  if (cur.executorStatus === 'unknown' && cur.machineGate === 'pending' && (!cur.evidence || cur.evidence.length === 0) && (!cur.changed || cur.changed.length === 0)) {
    // A delegated Codex step with no recorded RESULT may still be live after a restart:
    // reconcile the existing durable binding first; never silently re-execute.
    return delegated ? 'reconcile' : 'execute';
  }
  if (cur.executorStatus === 'success' && cur.machineGate === 'pass') return 'brain_review';
  if (cur.executorStatus === 'success' && cur.machineGate === 'fail') return 'revise';
  if (cur.executorStatus === 'failure') return 'revise';
  if (cur.executorStatus === 'unknown') return 'reconcile';
  return 'review';
}

// Execution summary is derived from durable state + the semantic binding. It is a
// hint for the runtime to reconcile (never cancel) a still-valid delegated execution.
export function buildExecutionSummary(state, { taskId = null, identity = null } = {}) {
  const cur = state && state.steps && state.currentStepId ? state.steps[state.currentStepId] : null;
  const route = state ? state.route : null;
  const localRoute = state ? state.localRoute : null;
  const delegated = route === 'CODEX_DELEGATE' || localRoute === 'CODEX_DELEGATE';
  const activeStep = !!(delegated && cur && cur.executorStatus === 'unknown' && cur.machineGate === 'pending');
  return {
    route,
    delegated,
    activeStep,
    requiresReconcile: activeStep,
    binding: {
      taskId: taskId || (state ? state.taskId : null) || null,
      stepId: state ? state.currentStepId : null,
      identity: identity || null,
    },
  };
}

function buildBoundedCapsule(state, { authority = null, projectKey = null, identity = null, execution = null, taskId = null }, B, marks) {
  const s = state || {};
  const cur = s.steps && s.currentStepId ? s.steps[s.currentStepId] : null;

  const acceptance = boundedSlice(cur ? cur.acceptance : [], B.acceptanceItems);
  const evidence = boundedSlice(cur ? cur.evidence : [], B.evidenceItems);
  const changed = boundedSlice(cur ? cur.changed : [], B.changedItems);

  const acceptanceItems = acceptance.included.map((a) => ({ id: a.id, required: a.required !== false, status: a.status || 'missing' }));
  const evidenceItems = evidence.included.map((e) => ({
    acceptanceId: e.acceptanceId,
    status: e.status,
    kind: e.kind || 'verify',
    summary: e.summary == null ? null : truncText(String(e.summary), B.maxTextLength, 'evidence.summary', marks),
  }));
  const changedItems = changed.included.map((c) => truncText(String(c), B.maxTextLength, 'changed', marks));

  const trunc = {
    acceptance: { total: acceptance.total, included: acceptanceItems.length, dropped: Math.max(0, acceptance.total - acceptanceItems.length) },
    evidence: { total: evidence.total, included: evidenceItems.length, dropped: Math.max(0, evidence.total - evidenceItems.length) },
    changed: { total: changed.total, included: changedItems.length, dropped: Math.max(0, changed.total - changedItems.length) },
  };

  const askUser = s.askUser && typeof s.askUser === 'object' ? {
    whyBlocked: s.askUser.whyBlocked == null ? null : truncText(String(s.askUser.whyBlocked), B.maxTextLength, 'askUser.whyBlocked', marks),
    minimalUserAction: s.askUser.minimalUserAction == null ? null : truncText(String(s.askUser.minimalUserAction), B.maxTextLength, 'askUser.minimalUserAction', marks),
    question: s.askUser.question == null ? null : truncText(String(s.askUser.question), B.maxTextLength, 'askUser.question', marks),
  } : undefined;

  const capsule = {
    kind: 'brain-continuity.context-capsule',
    version: CAPSULE_VERSION,
    projectKey: projectKey == null ? null : truncText(String(projectKey), B.maxTextLength, 'projectKey', marks),
    taskId: taskId || s.taskId || null,
    identity: identity == null ? null : truncText(String(identity), B.maxTextLength, 'identity', marks),
    control: s.control ? truncText(String(s.control), 64, 'control', marks) : null,
    route: s.route ? truncText(String(s.route), 64, 'route', marks) : null,
    localRoute: s.localRoute ? truncText(String(s.localRoute), 64, 'localRoute', marks) : null,
    planRevision: typeof s.planRevision === 'number' ? s.planRevision : 0,
    planned: (s.planRevision || 0) > 0,
    currentStepId: s.currentStepId || null,
    previousStepId: s.previousStepId || null,
    terminal: s.control === 'DONE',
    awaitingUser: !!s.awaitingUser,
    authority: authority ? { generation: authority.generation } : (s.authority ? { generation: s.authority.generation } : null),
    step: cur ? {
      stepId: cur.stepId || s.currentStepId,
      executorStatus: cur.executorStatus || 'unknown',
      machineGate: cur.machineGate || 'pending',
      brainAcceptance: cur.brainAcceptance || 'pending',
      acceptance: acceptanceItems,
      evidence: evidenceItems,
      changed: changedItems,
    } : null,
    nextSafeAction: deriveNextSafeAction(s),
    execution: execution || buildExecutionSummary(s, { taskId: taskId || s.taskId || null, identity }),
    capabilityFreshness: {
      requiresRediscovery: true,
      reason: 'capability availability is an ephemeral runtime observation; re-entry requires rediscovery before a new execution is authorized',
    },
    truncation: {
      bounded: true,
      boundsUsed: 'normal',
      maxSerializedBytes: B.maxSerializedBytes,
      text: marks.slice(),
      ...trunc,
    },
  };
  if (askUser) capsule.askUser = askUser;
  capsule.truncation.serializedBytes = JSON.stringify(capsule).length;
  return capsule;
}

export function buildContextCapsule(state, opts = {}) {
  const B = CAPSULE_BOUNDS;
  const marks = [];
  const capsule = buildBoundedCapsule(state, opts, B, marks);
  if (capsule.truncation.serializedBytes <= B.maxSerializedBytes) return capsule;

  // Deterministic fallback: reduce cardinality and text further so the serialized
  // capsule always stays within the enforced bound.
  const FB = {
    acceptanceItems: B.fallbackAcceptanceItems,
    evidenceItems: B.fallbackEvidenceItems,
    changedItems: B.fallbackChangedItems,
    maxTextLength: B.fallbackMaxTextLength,
    maxSerializedBytes: B.maxSerializedBytes,
  };
  const marks2 = [];
  const reduced = buildBoundedCapsule(state, opts, FB, marks2);
  reduced.truncation.boundsUsed = 'fallback';
  reduced.truncation.text = marks2.slice();
  reduced.truncation.serializedBytes = JSON.stringify(reduced).length;
  return reduced;
}
