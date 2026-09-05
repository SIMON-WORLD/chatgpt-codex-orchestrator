// chatgpt-codex-orchestrator: bounded Context Capsule for Brain re-entry
// (Brain Continuity core). A replacement Parent session receives a bounded capsule
// derived from durable structured Governance state + freshly reacquired evidence —
// never a giant transcript handoff. Internal low-level ids may appear for debug but
// are not required for normal handoff.

export const CAPSULE_VERSION = 1;

function compactStatusList(acceptance = []) {
  return (acceptance || []).map((a) => ({ id: a.id, required: a.required !== false, status: a.status || 'missing' }));
}

function compactEvidence(evidence = []) {
  return (evidence || []).map((e) => ({ acceptanceId: e.acceptanceId, status: e.status, kind: e.kind || 'verify', summary: e.summary || null }));
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

export function buildContextCapsule(state, { authority = null, projectKey = null, identity = null, execution = null, taskId = null } = {}) {
  const s = state || {};
  const cur = s.steps && s.currentStepId ? s.steps[s.currentStepId] : null;
  const capsule = {
    kind: 'brain-continuity.context-capsule',
    version: CAPSULE_VERSION,
    projectKey: projectKey || null,
    taskId: taskId || s.taskId || null,
    identity: identity || null,
    control: s.control || null,
    route: s.route || null,
    localRoute: s.localRoute || null,
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
      acceptance: compactStatusList(cur.acceptance),
      evidence: compactEvidence(cur.evidence),
      changed: Array.isArray(cur.changed) ? cur.changed.slice() : [],
    } : null,
    nextSafeAction: deriveNextSafeAction(s),
    execution: execution || buildExecutionSummary(s, { taskId: taskId || s.taskId || null, identity }),
    capabilityFreshness: {
      requiresRediscovery: true,
      reason: 'capability availability is an ephemeral runtime observation; re-entry requires rediscovery before a new execution is authorized',
    },
  };
  if (s.askUser && typeof s.askUser === 'object') {
    capsule.askUser = {
      whyBlocked: s.askUser.whyBlocked || null,
      minimalUserAction: s.askUser.minimalUserAction || null,
      question: s.askUser.question || null,
    };
  }
  return capsule;
}
