import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHandoff, validateHandoff, HANDOFF_FIELDS, HandoffError } from '../../src/state/handoff.js';

test('handoff fields are stable and canonical', () => {
  assert.deepEqual([...HANDOFF_FIELDS], ['taskId', 'stepId', 'control', 'route', 'localRoute', 'acceptance', 'evidenceSummary', 'changed', 'machineGate', 'brainAcceptance', 'nextAction']);
});

test('buildHandoff produces a compact blob', () => {
  const h = buildHandoff({
    taskId: 't1', stepId: 's1', control: 'TASK', route: 'CODEX_DELEGATE',
    localRoute: null, acceptance: [{ id: 'a1' }], evidenceSummary: [{ acceptanceId: 'a1', status: 'pass' }],
    changed: ['src/x.js'], machineGate: 'pass', brainAcceptance: 'pending', nextAction: 'execute',
  });
  assert.equal(h.taskId, 't1');
  assert.equal(h.stepId, 's1');
  assert.equal(h.control, 'TASK');
  assert.equal(h.route, 'CODEX_DELEGATE');
  assert.equal(h.machineGate, 'pass');
  assert.equal(h.brainAcceptance, 'pending');
  assert.equal(h.nextAction, 'execute');
  assert.deepEqual(h.acceptance, [{ id: 'a1' }]);
  assert.equal(h.localRoute, undefined); // omitted when null
  assert.ok(validateHandoff(h));
});

test('buildHandoff omits empty detail fields but keeps status fields', () => {
  const h = buildHandoff({ machineGate: 'pending', brainAcceptance: 'pending' });
  assert.equal(h.machineGate, 'pending');
  assert.equal(h.brainAcceptance, 'pending');
  assert.equal(h.taskId, undefined);
  assert.equal(h.acceptance, undefined);
});

test('invalid machineGate / brainAcceptance are rejected', () => {
  assert.throws(() => buildHandoff({ machineGate: 'bogus' }), HandoffError);
  assert.throws(() => buildHandoff({ brainAcceptance: 'bogus' }), HandoffError);
});

test('validateHandoff rejects unknown fields', () => {
  assert.throws(() => validateHandoff({ machineGate: 'pass', brainAcceptance: 'accepted', unknownField: 1 }), HandoffError);
});
