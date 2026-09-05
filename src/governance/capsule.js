// chatgpt-codex-orchestrator: bounded Context Capsule for Brain re-entry
// (Brain Continuity core). A replacement Parent session receives a bounded capsule
// derived from durable structured Governance state + freshly reacquired evidence -
// never a giant transcript handoff.
//
// Bounding contract: the bound is UNCONDITIONAL for every valid input. All
// variable-length fields (ids, statuses, summaries, ASK_USER strings, caller-supplied
// execution) are clamped, collection cardinalities are capped, and the final
// serialized capsule is deterministically enforced to stay <= maxSerializedBytes.
// Truncation/count/reference metadata is always attached so a Parent knows the
// authoritative durable state contains more content. Truncation NEVER fabricates
// acceptance: statuses and references are only copied from the durable state for the
// included items.

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
  // Caller-supplied execution object bound (serialized) and per-node clamp caps
  maxExecutionBytes: 1024,
  maxExecutionNodesPerLevel: 40,
  maxExecutionDepth: 4,
});

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

function clampJsonNode(node, B, marks, depth) {
  if (node === null || node === undefined) return null;
  const t = typeof node;
  if (t === 'string') return truncText(node, B.maxTextLength, 'execution', marks);
  if (t === 'number' || t === 'boolean') return node;
  if (Array.isArray(node)) {
    if (depth > B.maxExecutionDepth) return '[max-depth]';
    return node.slice(0, B.maxExecutionNodesPerLevel).map((x) => clampJsonNode(x, B, marks, depth + 1));
  }
  if (t === 'object') {
    if (depth > B.maxExecutionDepth) return '[max-depth]';
    const out = {};
    for (const k of Object.keys(node).slice(0, B.maxExecutionNodesPerLevel)) {
      const key = truncText(k, B.maxTextLength, 'execution', marks);
      out[key] = clampJsonNode(node[k], B, marks, depth + 1);
    }
    return out;
  }
  return null;
}

// Bound a caller-supplied execution object. Over-large executions are replaced with a
// deterministic marker (never passed through unbounded); otherwise every string and
// collection inside the object is clamped.
function sanitizeExecution(execution, B, marks) {
  if (execution === null || execution === undefined) return null;
  if (typeof execution !== 'object') {
    return { value: truncText(String(execution), B.maxTextLength, 'execution', marks) };
  }
  let raw = null;
  try { raw = JSON.stringify(execution); } catch { raw = null; }
  if (raw != null && raw.length > B.maxExecutionBytes) {
    if (!marks.includes('execution')) marks.push('execution');
    return { truncated: true, reason: 'caller execution object exceeded the capsule execution bound', serializedBytes: raw.length };
  }
  return clampJsonNode(execution, B, marks, 0);
}

function buildBoundedCapsule(state, { authority = null, projectKey = null, identity = null, execution = null, taskId = null }, B, marks) {
  const s = state || {};
  const cur = s.steps && s.currentStepId ? s.steps[s.currentStepId] : null;

  const acceptance = boundedSlice(cur ? cur.acceptance : [], B.acceptanceItems);
  const evidence = boundedSlice(cur ? cur.evidence : [], B.evidenceItems);
  const changed = boundedSlice(cur ? cur.changed : [], B.changedItems);

  const acceptanceItems = acceptance.included.map((a) => ({
    id: truncText(String(a.id), B.maxTextLength, 'acceptance.id', marks),
    required: a.required !== false,
    status: truncText(String(a.status || 'missing'), B.maxTextLength, 'acceptance.status', marks),
  }));
  const evidenceItems = evidence.included.map((e) => ({
    acceptanceId: truncText(String(e.acceptanceId), B.maxTextLength, 'evidence.acceptanceId', marks),
    status: truncText(String(e.status), B.maxTextLength, 'evidence.status', marks),
    kind: truncText(String(e.kind || 'verify'), B.maxTextLength, 'evidence.kind', marks),
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
    taskId: taskId || s.taskId ? truncText(String(taskId || s.taskId), B.maxTextLength, 'taskId', marks) : null,
    identity: identity == null ? null : truncText(String(identity), B.maxTextLength, 'identity', marks),
    control: s.control ? truncText(String(s.control), 64, 'control', marks) : null,
    route: s.route ? truncText(String(s.route), 64, 'route', marks) : null,
    localRoute: s.localRoute ? truncText(String(s.localRoute), 64, 'localRoute', marks) : null,
    planRevision: typeof s.planRevision === 'number' ? s.planRevision : 0,
    planned: (s.planRevision || 0) > 0,
    currentStepId: s.currentStepId ? truncText(String(s.currentStepId), B.maxTextLength, 'currentStepId', marks) : null,
    previousStepId: s.previousStepId ? truncText(String(s.previousStepId), B.maxTextLength, 'previousStepId', marks) : null,
    terminal: s.control === 'DONE',
    awaitingUser: !!s.awaitingUser,
    authority: authority ? { generation: authority.generation } : (s.authority ? { generation: s.authority.generation } : null),
    step: cur ? {
      stepId: truncText(String(cur.stepId || s.currentStepId), B.maxTextLength, 'step.stepId', marks),
      executorStatus: truncText(String(cur.executorStatus || 'unknown'), 64, 'executorStatus', marks),
      machineGate: truncText(String(cur.machineGate || 'pending'), 64, 'machineGate', marks),
      brainAcceptance: truncText(String(cur.brainAcceptance || 'pending'), 64, 'brainAcceptance', marks),
      acceptance: acceptanceItems,
      evidence: evidenceItems,
      changed: changedItems,
    } : null,
    nextSafeAction: deriveNextSafeAction(s),
    execution: sanitizeExecution(execution || buildExecutionSummary(s, { taskId: taskId || s.taskId || null, identity }), B, marks),
    capabilityFreshness: {
      requiresRediscovery: true,
      reason: 'capability availability is an ephemeral runtime observation; re-entry requires rediscovery before a new execution is authorized',
    },
    truncation: {
      bounded: true,
      boundsUsed: 'normal',
      maxSerializedBytes: B.maxSerializedBytes,
      // Placeholder occupying the same digit count as the final self-size so size
      // enforcement accounts for the metadata field itself; replaced by fixed point.
      serializedBytes: B.maxSerializedBytes,
      text: marks.slice(),
      ...trunc,
    },
  };
  if (askUser) capsule.askUser = askUser;
  return capsule;
}

function measuredBytes(capsule) { return JSON.stringify(capsule).length; }

// Set serializedBytes to the capsule's own serialized length (fixed point so the
// stored value reflects the JSON that includes the field itself).
function finalizeSerializedBytes(capsule) {
  let last = null;
  for (let i = 0; i < 8; i++) {
    const n = measuredBytes(capsule);
    capsule.truncation.serializedBytes = n;
    if (n === last) break;
    last = n;
  }
  return capsule.truncation.serializedBytes;
}

function refreshTruncation(capsule) {
  const t = capsule.truncation;
  const step = capsule.step || {};
  const arr = step.acceptance || [];
  t.acceptance.included = arr.length;
  t.acceptance.dropped = Math.max(0, t.acceptance.total - arr.length);
  const ev = step.evidence || [];
  t.evidence.included = ev.length;
  t.evidence.dropped = Math.max(0, t.evidence.total - ev.length);
  const ch = step.changed || [];
  t.changed.included = ch.length;
  t.changed.dropped = Math.max(0, t.changed.total - ch.length);
}

// Deterministic hard enforcement of the serialized-size bound. Reduces optional
// variable content (evidence summaries -> arrays -> askUser -> execution) until the
// serialized capsule is guaranteed to fit. Only references/statuses from durable state
// are retained; nothing is fabricated. The placeholder serializedBytes field means the
// measured size already accounts for the self-size metadata.
function enforceSerializedBound(capsule, B) {
  let len = measuredBytes(capsule);
  let shrank = false;
  const step = capsule.step;
  let guard = 0;
  while (len > B.maxSerializedBytes && guard++ < 64) {
    shrank = true;
    let changed = false;
    if (step && step.evidence && step.evidence.some((e) => e.summary != null)) {
      for (const e of step.evidence) e.summary = null;
      changed = true;
    } else if (step && step.evidence && step.evidence.length > 1) {
      step.evidence = step.evidence.slice(0, Math.max(1, Math.ceil(step.evidence.length / 2)));
      changed = true;
    } else if (step && step.changed && step.changed.length > 1) {
      step.changed = step.changed.slice(0, Math.max(1, Math.ceil(step.changed.length / 2)));
      changed = true;
    } else if (step && step.acceptance && step.acceptance.length > 1) {
      step.acceptance = step.acceptance.slice(0, Math.max(1, Math.ceil(step.acceptance.length / 2)));
      changed = true;
    } else if (capsule.askUser) {
      capsule.askUser = null;
      changed = true;
    } else if (capsule.execution && typeof capsule.execution === 'object' && capsule.execution.truncated !== true) {
      capsule.execution = { truncated: true, reason: 'execution dropped to satisfy capsule serialized bound' };
      changed = true;
    } else {
      break;
    }
    if (!changed) break;
    len = measuredBytes(capsule);
  }
  refreshTruncation(capsule);
  capsule.truncation.hardTrimmed = shrank;
  finalizeSerializedBytes(capsule);
  return capsule;
}

export function buildContextCapsule(state, opts = {}) {
  const B = CAPSULE_BOUNDS;
  const marks = [];
  const capsule = buildBoundedCapsule(state, opts, B, marks);
  if (measuredBytes(capsule) <= B.maxSerializedBytes) {
    capsule.truncation.hardTrimmed = false;
    finalizeSerializedBytes(capsule);
    return capsule;
  }
  // Deterministic fallback tier: reduce cardinality and text further.
  const FB = {
    acceptanceItems: B.fallbackAcceptanceItems,
    evidenceItems: B.fallbackEvidenceItems,
    changedItems: B.fallbackChangedItems,
    maxTextLength: B.fallbackMaxTextLength,
    maxSerializedBytes: B.maxSerializedBytes,
    maxExecutionBytes: B.maxExecutionBytes,
    maxExecutionNodesPerLevel: B.maxExecutionNodesPerLevel,
    maxExecutionDepth: B.maxExecutionDepth,
  };
  const marks2 = [];
  const reduced = buildBoundedCapsule(state, opts, FB, marks2);
  reduced.truncation.boundsUsed = 'fallback';
  reduced.truncation.text = marks2.slice();
  return enforceSerializedBound(reduced, B);
}
