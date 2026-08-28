import { test } from 'node:test';
import assert from 'node:assert';
import {
  normalizeBrainOutput, validateControl, repairControl, parseBrainOutput, buildResult, resultToText,
  checkAcceptanceGate, registerAcceptances, applyEvidence, ProtocolError,
} from '../src/protocol.js';

test('parseBrainOutput: pure JSON TASK with acceptance', () => {
  const out = '{"control":"TASK","instruction":"create x.js","acceptance":[{"id":"a1","required":true,"text":"x works"}]}';
  const c = parseBrainOutput(out).control;
  assert.strictEqual(c.control, 'TASK');
  assert.strictEqual(c.instruction, 'create x.js');
  assert.strictEqual(c.acceptance.length, 1);
  assert.strictEqual(c.acceptance[0].id, 'a1');
});

test('parseBrainOutput: JSON embedded in prose', () => {
  const out = 'Planning done. {"control":"REVISE","instruction":"fix y","acceptance":[]}';
  const c = parseBrainOutput(out).control;
  assert.strictEqual(c.control, 'REVISE');
  assert.strictEqual(c.instruction, 'fix y');
});

test('parseBrainOutput: legacy text fallback', () => {
  const c = parseBrainOutput('TASK: create foo.js').control;
  assert.strictEqual(c.control, 'TASK');
  assert.strictEqual(c.instruction, 'create foo.js');
  assert.deepStrictEqual(c.acceptance, []);
});

test('auto-repair fills missing instruction/acceptance', () => {
  const c = parseBrainOutput('{"control":"TASK","text":"do it"}').control;
  assert.strictEqual(c.instruction, 'do it');
  assert.deepStrictEqual(c.acceptance, []);
});

test('invalid control after repair -> ProtocolError', () => {
  assert.throws(() => parseBrainOutput('{"control":"FOO"}'), ProtocolError);
});

test('buildResult/resultToText roundtrip fields', () => {
  const r = buildResult({ stepId: 'step-1', status: 'success', summary: 'did', filesChanged: ['a.js'], tests: [{ name: 't', passed: true }], evidence: [{ acceptanceId: 'a1', status: 'pass' }], blockers: [] });
  const txt = resultToText(r);
  assert.ok(txt.includes('step-1'));
  assert.ok(txt.includes('a.js'));
  assert.ok(txt.includes('a1=pass'));
});

test('acceptance gate: required all pass -> allPass; missing/fail -> blocked', () => {
  assert.strictEqual(checkAcceptanceGate([{ id: 'a1', required: true, status: 'pass' }]).allPass, true);
  assert.strictEqual(checkAcceptanceGate([{ id: 'a1', required: true, status: 'missing' }]).allPass, false);
  assert.strictEqual(checkAcceptanceGate([{ id: 'a1', required: true, status: 'fail' }]).allPass, false);
  // optional not required
  assert.strictEqual(checkAcceptanceGate([{ id: 'a1', required: false, status: 'missing' }]).allPass, true);
});

test('registerAcceptances + applyEvidence update registry', () => {
  const state = { acceptanceRegistry: [] };
  registerAcceptances(state, { control: 'TASK', acceptance: [{ id: 'a1', required: true, text: 'x' }] });
  assert.strictEqual(state.acceptanceRegistry[0].status, 'missing');
  applyEvidence(state, { evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  assert.strictEqual(state.acceptanceRegistry[0].status, 'pass');
});
import { normalizeEvidence, parseEvidenceBlock } from '../src/protocol.js';

test('evidence aliases: passed->pass, failed->fail; array parsed itemwise', () => {
  assert.strictEqual(normalizeEvidence({ acceptanceId: 'a', status: 'passed' }).status, 'pass');
  assert.strictEqual(normalizeEvidence({ acceptanceId: 'a', status: 'failed' }).status, 'fail');
  const line = 'EVIDENCE: [' + JSON.stringify({ acceptanceId: 'a', status: 'passed', kind: 'test', summary: 'ok' }) + ']';
  const out = parseEvidenceBlock(line);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].acceptanceId, 'a');
  assert.strictEqual(out[0].status, 'pass');
});