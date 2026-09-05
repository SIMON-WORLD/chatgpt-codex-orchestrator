import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityObservationLedger, requireCapabilityRediscovery, capabilityIsCurrent } from '../../src/governance/observation.js';
import { buildContextCapsule, deriveNextSafeAction, CAPSULE_BOUNDS } from '../../src/governance/capsule.js';

// ---- Capability observations are ephemeral, never timeless truth -------------
test('capability observations are scoped and available only within the current session', () => {
  const ledger = new CapabilityObservationLedger();
  ledger.record({ capability: 'github.write', provider: 'github', resourceScope: 'simon-world/repo', operation: 'mutation', status: 'available' });
  assert.equal(ledger.availableNow({ capability: 'github.write', resourceScope: 'simon-world/repo' }), true);
  // A different resource scope was never observed.
  assert.equal(ledger.availableNow({ capability: 'github.write', resourceScope: 'other/repo' }), false);
  // read availability does not imply write availability
  ledger.record({ capability: 'github.read', provider: 'github', resourceScope: 'simon-world/repo', operation: 'read', status: 'available' });
  assert.equal(ledger.availableNow({ capability: 'github.read' }), true);
});

test('re-entry discards prior-session capability availability (stale snapshot is not trusted)', () => {
  const sessionA = new CapabilityObservationLedger();
  sessionA.record({ capability: 'codex.exec', provider: 'codex', resourceScope: 'ws-a', operation: 'write', status: 'available' });
  assert.equal(sessionA.availableNow({ capability: 'codex.exec', resourceScope: 'ws-a' }), true);

  // Replacement Parent session / runtime restart => new session, observations cleared.
  const sessionB = new CapabilityObservationLedger();
  const discarded = sessionB.beginReentry();
  sessionB.loadSnapshot(sessionA.snapshot()); // a stale snapshot can be loaded for diagnostics
  assert.ok(discarded.epoch >= 0);
  // The loaded prior-session snapshot is NOT trusted as current availability.
  assert.equal(capabilityIsCurrent(sessionB, { capability: 'codex.exec', resourceScope: 'ws-a' }), false);
  assert.equal(sessionB.availableNow({ capability: 'codex.exec', resourceScope: 'ws-a' }), false);
  // Re-discovery is mandatory.
  assert.equal(requireCapabilityRediscovery().requiresRediscovery, true);
  // A fresh observation in the new session restores current availability.
  sessionB.record({ capability: 'codex.exec', provider: 'codex', resourceScope: 'ws-a', operation: 'write', status: 'available' });
  assert.equal(sessionB.availableNow({ capability: 'codex.exec', resourceScope: 'ws-a' }), true);
});

test('persisted/snapshot observations can never be replayed as timeless availability', () => {
  const a = new CapabilityObservationLedger();
  a.record({ capability: 'local.edit', status: 'available' });
  const snap = a.snapshot();
  const b = new CapabilityObservationLedger();
  b.loadSnapshot(snap);
  const entries = b.entries();
  assert.ok(entries.length >= 1);
  for (const e of entries) {
    assert.equal(e.ephemeral, true);
    assert.notEqual(e.status, 'available'); // restored snapshot availability downgraded
    assert.equal(b.availableNow({ capability: 'local.edit' }), false);
  }
});

// ---- Context Capsule is bounded, derived from durable structured state ---------
function sampleState(overrides = {}) {
  return {
    taskId: 't1',
    control: 'TASK',
    route: 'CHATGPT_DIRECT_LOCAL',
    localRoute: 'CHATGPT_DIRECT_LOCAL',
    planRevision: 1,
    currentStepId: 's1',
    previousStepId: null,
    steps: {
      s1: {
        stepId: 's1',
        acceptance: [{ id: 'a1', required: true, status: 'pass' }],
        evidence: [{ acceptanceId: 'a1', status: 'pass', kind: 'verify', summary: 'ok' }],
        executorStatus: 'success',
        machineGate: 'pass',
        brainAcceptance: 'pending',
        changed: ['src/a.js'],
      },
    },
    awaitingUser: false,
    askUser: null,
    ...overrides,
  };
}

test('capsule is a bounded structured derivation, never a transcript dump', () => {
  const cap = buildContextCapsule(sampleState(), { projectKey: 'simon-world/repo', identity: 'issue-23', authority: { generation: 1 } });
  assert.equal(cap.kind, 'brain-continuity.context-capsule');
  assert.equal(cap.version, 1);
  assert.equal(cap.projectKey, 'simon-world/repo');
  assert.equal(cap.identity, 'issue-23');
  assert.equal(cap.taskId, 't1');
  assert.equal(cap.currentStepId, 's1');
  assert.equal(cap.step.executorStatus, 'success');
  assert.equal(cap.step.machineGate, 'pass');
  assert.equal(cap.nextSafeAction, 'brain_review');
  assert.equal(cap.authority.generation, 1);
  assert.equal(cap.capabilityFreshness.requiresRediscovery, true);
  assert.equal('authorityToken' in cap, false, 'capsule never carries the fencing token');
  assert.ok(JSON.stringify(cap).length < 4000, 'capsule is compact');
});

test('capsule nextSafeAction is deterministic across durable states', () => {
  const none = sampleState({ taskId: null });
  assert.equal(deriveNextSafeAction(none), 'plan');
  const done = sampleState({ control: 'DONE' });
  assert.equal(buildContextCapsule(done).nextSafeAction, 'done');
  const ask = sampleState({ awaitingUser: true, control: 'ASK_USER' });
  assert.equal(buildContextCapsule(ask).nextSafeAction, 'await_user_decision');
  const noStep = sampleState({ currentStepId: null, steps: {} });
  assert.equal(buildContextCapsule(noStep).nextSafeAction, 'task');
  const delegated = sampleState({ route: 'CODEX_DELEGATE', localRoute: 'CODEX_DELEGATE', steps: { s1: { stepId: 's1', acceptance: [], evidence: [], executorStatus: 'unknown', machineGate: 'pending', changed: [] } } });
  assert.equal(buildContextCapsule(delegated).nextSafeAction, 'reconcile');
  const failing = sampleState({ steps: { s1: { stepId: 's1', acceptance: [], evidence: [], executorStatus: 'failure', machineGate: 'fail', changed: [] } } });
  assert.equal(buildContextCapsule(failing).nextSafeAction, 'revise');
});


test('capsule stays bounded on large durable state (cardinality + text caps, counts/references preserved)', () => {
  const bigAcceptance = [];
  const bigEvidence = [];
  const bigChanged = [];
  const longText = 'x'.repeat(3000);
  for (let i = 0; i < 300; i++) {
    bigAcceptance.push({ id: 'acc-' + i, required: true, status: i % 2 === 0 ? 'pass' : 'missing' });
    bigEvidence.push({ acceptanceId: 'acc-' + i, status: i % 2 === 0 ? 'pass' : 'missing', kind: 'verify', summary: longText });
    bigChanged.push('src/file-' + i + '.js/' + longText);
  }
  const state = sampleState({
    control: 'ASK_USER',
    awaitingUser: true,
    askUser: { whyBlocked: longText, minimalUserAction: longText, question: longText + 'q' },
    steps: { s1: {
      stepId: 's1',
      acceptance: bigAcceptance,
      evidence: bigEvidence,
      changed: bigChanged,
      executorStatus: 'success',
      machineGate: 'pass',
      brainAcceptance: 'pending',
    } },
  });
  const cap = buildContextCapsule(state, { projectKey: 'simon-world/repo', identity: 'issue-large', authority: { generation: 3 } });
  const size = JSON.stringify(cap).length;
  assert.ok(size <= CAPSULE_BOUNDS.maxSerializedBytes, 'capsule must stay within the enforced serialized bound, got ' + size);
  // Count/reference metadata tells the Parent the authoritative state has more content.
  assert.equal(cap.truncation.acceptance.total, 300);
  assert.equal(cap.truncation.evidence.total, 300);
  assert.equal(cap.truncation.changed.total, 300);
  assert.ok(cap.truncation.acceptance.dropped > 0);
  assert.ok(cap.truncation.evidence.dropped > 0);
  assert.ok(cap.truncation.changed.dropped > 0);
  assert.ok(cap.step.acceptance.length <= CAPSULE_BOUNDS.fallbackAcceptanceItems || cap.truncation.boundsUsed === 'normal');
  assert.ok(cap.step.acceptance.length <= CAPSULE_BOUNDS.acceptanceItems);
  // Truncation never fabricates acceptance: included statuses match durable input order.
  assert.equal(cap.step.acceptance[0].status, 'pass');
  assert.equal(cap.step.acceptance[1].status, 'missing');
  // No full-size variable text survived.
  const raw = JSON.stringify(cap);
  assert.equal(raw.includes(longText), false);
  assert.ok(raw.includes('capability availability is an ephemeral runtime observation'), 'freshness contract remains present');
});
