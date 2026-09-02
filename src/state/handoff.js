// chatgpt-codex-orchestrator: compact route/governance handoff blob (v0.2 M4).
// A stable, minimal handoff across routes — never the whole Brain transcript.
// Fields are the canonical governance handoff contract.

export const HANDOFF_FIELDS = Object.freeze([
  'taskId', 'stepId', 'control', 'route', 'localRoute', 'acceptance',
  'evidenceSummary', 'changed', 'machineGate', 'brainAcceptance', 'nextAction',
]);

export class HandoffError extends Error {
  constructor(msg) { super(msg); this.name = 'HandoffError'; }
}

function compactList(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => x !== undefined && x !== null);
}

// Build a compact handoff. Core status fields are always present; detail fields are
// omitted when empty so downstream routes receive only the bounded contract.
export function buildHandoff(input = {}) {
  const {
    taskId = null, stepId = null, control = null, route = null, localRoute = null,
    acceptance = [], evidenceSummary = [], changed = [], machineGate = 'pending',
    brainAcceptance = 'pending', nextAction = null,
  } = input;

  if (machineGate !== 'pending' && !['pass', 'fail'].includes(machineGate)) throw new HandoffError('machineGate must be pending|pass|fail');
  if (brainAcceptance !== 'pending' && !['accepted', 'rejected', 'revise'].includes(brainAcceptance)) throw new HandoffError('brainAcceptance must be pending|accepted|rejected|revise');

  const handoff = { machineGate, brainAcceptance };
  if (taskId) handoff.taskId = taskId;
  if (stepId) handoff.stepId = stepId;
  if (control) handoff.control = control;
  if (route) handoff.route = route;
  if (localRoute) handoff.localRoute = localRoute;
  const acc = compactList(acceptance);
  if (acc.length) handoff.acceptance = acc;
  const ev = compactList(evidenceSummary);
  if (ev.length) handoff.evidenceSummary = ev;
  const ch = compactList(changed);
  if (ch.length) handoff.changed = ch;
  if (nextAction) handoff.nextAction = nextAction;
  return handoff;
}

// Validate that a blob conforms to the handoff contract field set (unknown keys ok,
// but core keys are type-checked loosely). Returns true / throws.
export function validateHandoff(handoff) {
  if (!handoff || typeof handoff !== 'object') throw new HandoffError('handoff must be an object');
  const known = new Set(HANDOFF_FIELDS);
  for (const k of Object.keys(handoff)) {
    if (!known.has(k)) throw new HandoffError('unexpected handoff field: ' + k);
  }
  if (handoff.machineGate !== undefined && !['pending', 'pass', 'fail'].includes(handoff.machineGate)) throw new HandoffError('invalid machineGate');
  if (handoff.brainAcceptance !== undefined && !['pending', 'accepted', 'rejected', 'revise'].includes(handoff.brainAcceptance)) throw new HandoffError('invalid brainAcceptance');
  return true;
}
