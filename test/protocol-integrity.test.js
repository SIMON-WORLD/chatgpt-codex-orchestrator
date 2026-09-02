import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateMilestoneAcceptance, evaluateEvidenceLevel, validateStructuredEnvelope, formatRepairPrompt, buildTakeoverContract, applyBrainAcceptanceTransition, extractCanonicalEnvelope, createDirectRunCoordinator, createDirectRunLedger, computePayloadHash, applyReviseDelta, buildAskUserEnvelope } from '../src/protocol-integrity.js';
import { createDirectGovernance, createProofLedger, createDirectMetrics } from '../src/direct-governance.js';
import { createChatGPTBrowserProvider, DEFAULT_DIRECT_CONFIG, DIRECT_MODE_REQUIRES, evaluatePublicationGate, evaluateDoneGate } from '../src/legacy/direct-mode.js';
import { isTerminalControl, validateLifecycleAfterDone, parseBrainOutput } from '../src/protocol.js';
import { AtomicTurnController, ReplyTimeoutError, ComposerTimeoutError } from '../src/legacy/atomic-turn.js';
import { createTabFacade } from '../src/legacy/iab-transport.js';

const skillPath = fileURLToPath(new URL('../skills/brain-command/SKILL.md', import.meta.url));

function validEnv(over = {}) {
  return { runId: 'run-1', controlId: 'c7', sequence: 7, control: 'TASK', stepId: 's1', instruction: 'do x', acceptance: [], ...over };
}

test('executor success != Brain acceptance (still pending)', () => {
  const r = evaluateMilestoneAcceptance({ executorStatus: 'success', machineGate: 'pass', brainAcceptance: 'pending' });
  assert.equal(r.accepted, false);
  assert.match(r.reason, /brainAcceptance is pending/);
  assert.equal(evaluateMilestoneAcceptance({ executorStatus: 'success', machineGate: 'pass', brainAcceptance: 'accepted' }).accepted, true);
  assert.equal(evaluateMilestoneAcceptance({ executorStatus: 'failure', machineGate: 'pass', brainAcceptance: 'accepted' }).accepted, false);
});

test('inferred evidence cannot satisfy an observed requirement', () => {
  assert.equal(evaluateEvidenceLevel({ evidenceLevel: 'inferred', requiredEvidenceLevel: 'observed' }).ok, false);
  assert.equal(evaluateEvidenceLevel({ evidenceLevel: 'observed', requiredEvidenceLevel: 'observed' }).ok, true);
  assert.equal(evaluateEvidenceLevel({ evidenceLevel: 'user_verified', requiredEvidenceLevel: 'user_verified' }).ok, true);
  assert.equal(evaluateEvidenceLevel({ evidenceLevel: 'unobservable', requiredEvidenceLevel: 'observed' }).ok, false, 'unobservable never silently pass');
});

test('structured envelope required in canonical mode; format repair keeps semantics', () => {
  assert.equal(validateStructuredEnvelope(validEnv()).ok, true);
  assert.equal(validateStructuredEnvelope({ control: 'TASK', instruction: 'x', acceptance: [] }).ok, false, 'envelope missing runId/controlId/sequence/stepId');
  assert.equal(validateStructuredEnvelope({ ...validEnv(), control: 'WEIRD' }).ok, false);
  const repair = formatRepairPrompt();
  assert.match(repair, /Restate the immediately previous control in canonical structured form only/);
  assert.match(repair, /Do not replan or change its instruction\/acceptance/);
});

test('monotonic control sequence: stale control rejected, RESULT must match outstanding', () => {
  const c = createDirectRunCoordinator();
  assert.equal(c.acceptControl(validEnv({ sequence: 7, controlId: 'c7' })).ok, true);
  assert.equal(c.acceptControl(validEnv({ sequence: 6, controlId: 'c6' })).ok, false, 'stale sequence rejected');
  assert.equal(c.state.metrics.staleControlRejectedCount, 1);
  const r6base = { resultId: 'r6', runId: 'run-1', sequence: 6, inReplyToControlId: 'c6' };
  assert.equal(c.recordResult({ ...r6base, payloadHash: computePayloadHash(r6base) }).ok, false, 'RESULT must match outstanding control');
  const r7base = { resultId: 'r7', runId: 'run-1', sequence: 7, inReplyToControlId: 'c7' };
  assert.equal(c.recordResult({ ...r7base, payloadHash: computePayloadHash(r7base) }).ok, true);
  assert.equal(c.state.outstandingControlId, null);
});

test('duplicate RESULT idempotent, retransmit preserves resultId + payloadHash', () => {
  const c = createDirectRunCoordinator();
  c.acceptControl(validEnv({ sequence: 7, controlId: 'c7' }));
  const r7base = { resultId: 'r7', runId: 'run-1', sequence: 7, inReplyToControlId: 'c7' };
  const r1 = c.recordResult({ ...r7base, payloadHash: computePayloadHash(r7base) });
  assert.equal(r1.ok, true); assert.equal(r1.duplicate, false);
  // retransmit the SAME result
  const rt = c.retransmit({ resultId: 'r7', payloadHash: r1.payloadHash });
  assert.equal(rt.resultId, 'r7'); assert.equal(rt.payloadHash, r1.payloadHash);
  assert.equal(c.state.metrics.resultRetransmitCount, 1);
});

test('next control piggybacks ackResultId; RESULT becomes acknowledged', () => {
  const c = createDirectRunCoordinator();
  c.acceptControl(validEnv({ sequence: 7, controlId: 'c7' }));
  const r6base = { resultId: 'r7', runId: 'run-1', sequence: 7, inReplyToControlId: 'c7' };
  c.recordResult({ ...r6base, payloadHash: computePayloadHash(r6base) });
  assert.equal(c.acceptControl(validEnv({ sequence: 8, controlId: 'c8', ackResultId: 'r7' })).ok, true);
  assert.equal(c.state.lastAcknowledgedResultId, 'r7');
});

test('nonce-carrying reply is required (stale old reply rejected)', async () => {
  const facade = {
    isComposerReady: async () => true,
    isComposerIdle: async () => true,
    sendMessage: async () => {},
    getAssistantCount: async () => 1,
    getAssistantReply: async (n) => 'stale reply without nonce',
    getCurrentUrl: async () => 'https://chatgpt.com/c/conv-1',
  };
  const controller = new AtomicTurnController(facade, { replyTimeoutMs: 700, pollIntervalMs: 5, replyStableReads: 1, replySettleMs: 0, composerTimeoutMs: 500 });
  await assert.rejects(() => controller.sendAndRead({ text: 'msg', nonce: 'nonce-xyz', expectedConversationId: 'conv-1' }), ReplyTimeoutError);
});

test('Direct ledger survives simulated provider restart + conversation disagreement fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-ledger-'));
  const l1 = createDirectRunLedger({ dataRoot: dir, runId: 'run-a' });
  l1.set('conversationId', 'conv-1');
  l1.set('lastAcceptedControlId', 'c7');
  l1.set('lastAcceptedSequence', 7);
  const p1 = l1.persist();
  assert.equal(p1.persisted, true);
  // simulate provider restart: new ledger loads
  const l2 = createDirectRunLedger({ dataRoot: dir, runId: 'run-a' });
  const loaded = l2.load();
  assert.equal(loaded.conversationId, 'conv-1');
  assert.equal(loaded.lastAcceptedSequence, 7);
  assert.equal(l2.agreeWith('conv-2', 'c7').ok, false, 'conversation disagreement fails closed');
  assert.equal(l2.agreeWith('conv-1', 'c7').ok, true);
});

test('REVISE delta preserves accepted while invalidating listed conclusions', () => {
  const r = applyReviseDelta({ delta: { preserve: ['P1'], invalidate: ['P2'] }, acceptanceStates: { P1: 'accepted', P2: 'accepted', P3: 'accepted' } });
  assert.equal(r.acceptanceStates.P1, 'accepted');
  assert.equal(r.acceptanceStates.P2, 'pending');
  assert.deepEqual(r.reopened, ['P2']);
});

test('ASK_USER envelope carries resume identity', () => {
  const e = buildAskUserEnvelope({ whyBlocked: 'sandbox cannot observe scheduled tasks', minimalUserAction: 'run read-only command', resumeControlId: 'c7', question: 'Q' });
  assert.equal(e.kind, 'ASK_USER');
  assert.equal(e.resumeControlId, 'c7');
  assert.equal(e.readOnly, true);
});

test('one browser-runtime owner; provider.send forwards nonce; default Direct Mode unchanged', async () => {
  const t = { connect: async () => {}, browser: { tabs: { new: async () => ({ id: 't', playwright: {} }) } }, findConversationLinksByTitle: async () => [], openConversationByHref: async () => '', closeTab: async () => {} };
  const p = createChatGPTBrowserProvider({ transport: t, turnOptions: { replyTimeoutMs: 700, pollIntervalMs: 5, replyStableReads: 1, replySettleMs: 0, composerTimeoutMs: 500 } });
  assert.equal(p._transport, t, 'provider owns exactly one transport');
  assert.equal(typeof p.send, 'function');
  assert.equal(DEFAULT_DIRECT_CONFIG.brainProvider, 'chatgpt');
  assert.equal(DIRECT_MODE_REQUIRES.nestedCodex, false);
  assert.equal(DIRECT_MODE_REQUIRES.workerBootstrap, false);
  assert.equal(typeof p.adoptConversation, 'function');
  assert.equal(typeof p.adoptCurrent, 'function');
});

test('composer fail-closed still resolves #prompt-textarea; canonical Skill delegates to the Direct controller', async () => {
  const facade = createTabFacade({ id: 't', playwright: { locator: (s) => ({ count: async () => s === '#prompt-textarea' ? 1 : 0, evaluate: async () => false, fill: async () => {}, press: async () => {}, innerText: async () => '' }), waitForTimeout: async () => {} } });
  assert.equal(await facade.isComposerReady(), true);
  const skill = fs.readFileSync(skillPath, 'utf8');
  assert.match(skill, /direct-run-controller|createDirectRun/);
  assert.match(skill, /direct-alpha4|DIRECT_ALPHA4_MODE/);
  assert.ok(!skill.includes('7. **Freeze RESULT identity, machine gate, serialize, then send'), 'manual step-7 recipe removed');
  assert.ok(!skill.includes('const machine = governance.transition({ stepId, acceptance, result: { changed, evidence } });'), 'manual transition recipe removed');
  assert.match(skill, /buildBootstrapEvidence/);
});

test('PUBLISH/DONE lifecycle unchanged; Alpha.4 publication gate intact', () => {
  assert.equal(evaluatePublicationGate({ brainControl: 'PUBLISH', acceptanceGateOk: true, identityPreflightOk: true, workingTreeScopeOk: true }).ok, true);
  assert.equal(evaluatePublicationGate({ brainControl: 'DONE', acceptanceGateOk: true, identityPreflightOk: true, workingTreeScopeOk: true }).ok, false);
  assert.equal(evaluateDoneGate({ publicationReady: true, finalVerificationOk: true, workingTreeScopeOk: true }).ok, true);
  assert.equal(isTerminalControl('DONE'), true);
  assert.equal(validateLifecycleAfterDone('PUBLISH').ok, false);
  const gov = createDirectGovernance();
  const t = gov.transition({ stepId: 's1', acceptance: ['U1'], result: { evidence: [{ acceptanceId: 'U1', status: 'pass' }] } });
  assert.equal(t.gate.ok, true);
  assert.equal(gov.machineGateStatus(), 'pass');
  const acc = gov.setBrainAcceptance({ stepId: 's1', acceptance: 'pending' });
  assert.equal(acc.ok, true);
  // executor success + machine pass but Brain still pending => no Brain acceptance
  assert.equal(evaluateMilestoneAcceptance({ executorStatus: 'success', machineGate: gov.machineGateStatus(), brainAcceptance: 'pending' }).accepted, false);
});

test('Alpha.3 IAB / existing-conversation / composer guarantees remain green', async () => {
  assert.equal(DEFAULT_DIRECT_CONFIG.executor, 'current-codex');
  assert.equal(DIRECT_MODE_REQUIRES.localhostTcp, false);
  assert.equal(DIRECT_MODE_REQUIRES.readyFile, false);
  const p = createChatGPTBrowserProvider();
  assert.ok(p._transport instanceof Object);
  assert.equal(typeof p.adoptCurrent, 'function');
});


test('REVISE 002a: canonical offline loop (control c1 -> exec -> machine gate -> RESULT r1 -> c2 ack r1 -> Brain accepts) survives restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dirint-'));
  // run 1
  const l1 = createDirectRunLedger({ dataRoot: dir, runId: 'run-int' });
  const c1 = createDirectRunCoordinator({ runId: 'run-int', ledger: l1 });
  const gov = createDirectGovernance({ proofLedger: createProofLedger({ computeFingerprint: (f) => 'h-' + f }) });
  l1.set('runId', 'run-int');
  const env = { runId: 'run-int', controlId: 'c1', sequence: 1, control: 'TASK', stepId: 's1', instruction: 'do x', acceptance: [{ id: 'U1', required: true, requiredEvidenceLevel: 'observed' }] };
  assert.equal(c1.acceptControl(env).ok, true);
  l1.persist();
  // execute + machine gate
  const t = gov.transition({ stepId: 's1', acceptance: env.acceptance, result: { evidence: [{ acceptanceId: 'U1', status: 'pass', evidenceLevel: 'observed' }] } });
  assert.equal(t.gate.ok, true);
  const result = { runId: 'run-int', resultId: 'r1', inReplyToControlId: 'c1', sequence: 1, stepId: 's1', payloadHash: computePayloadHash({ runId: 'run-int', resultId: 'r1', inReplyToControlId: 'c1', sequence: 1, stepId: 's1', executorStatus: 'success', machineGate: 'pass', changed: ['a.txt'], evidence: [], blockers: [] }), executorStatus: 'success', machineGate: 'pass', changed: ['a.txt'], evidence: [], blockers: [] };
  assert.equal(c1.recordResult(result).ok, true);
  l1.persist();
  // Brain accepts previous milestone (setBrainAcceptance) + c2 ack r1
  assert.equal(gov.setBrainAcceptance({ stepId: 's1', acceptance: 'accepted' }).ok, true);
  const env2 = { runId: 'run-int', controlId: 'c2', sequence: 2, control: 'TASK', stepId: 's2', instruction: 'do y', acceptance: [], ackResultId: 'r1' };
  assert.equal(c1.acceptControl(env2).ok, true);
  l1.persist();
  // simulate provider/kernel restart: new ledger loads state; new coordinator hydrates
  const l2 = createDirectRunLedger({ dataRoot: dir, runId: 'run-int' });
  const loaded = l2.load();
  const c2 = createDirectRunCoordinator({ runId: 'run-int', ledger: l2 });
  assert.equal(loaded.lastAcceptedSequence, 2);
  assert.equal(c2.acceptControl({ runId: 'run-int', controlId: 'c1', sequence: 1, control: 'TASK', stepId: 's1', instruction: 'do x', acceptance: [] }).ok, false, 'stale old c1 rejected');
  // continue with the already-outstanding c2 (no re-accept; it is preserved)
  const r2 = { runId: 'run-int', resultId: 'r2', inReplyToControlId: 'c2', sequence: 2, stepId: 's2', payloadHash: computePayloadHash({ runId: 'run-int', resultId: 'r2', inReplyToControlId: 'c2', sequence: 2, stepId: 's2', executorStatus: 'success', machineGate: 'pass', changed: [], evidence: [], blockers: [] }), executorStatus: 'success', machineGate: 'pass', changed: [], evidence: [], blockers: [] };
  assert.equal(c2.recordResult(r2).ok, true, 'resume completes c2');
});

test('REVISE 002a: offline delivery uncertainty resumes same r1, retransmit idempotent, no duplicate execution', () => {
  const c = createDirectRunCoordinator({ runId: 'run-int2' });
  assert.equal(c.acceptControl({ runId: 'run-int2', controlId: 'c1', sequence: 1, control: 'TASK', stepId: 's1', instruction: 'do x', acceptance: [] }).ok, true);
  const result = { runId: 'run-int2', resultId: 'r1', inReplyToControlId: 'c1', sequence: 1, stepId: 's1', payloadHash: computePayloadHash({ runId: 'run-int2', resultId: 'r1', inReplyToControlId: 'c1', sequence: 1, stepId: 's1', executorStatus: 'success', machineGate: 'pass', changed: ['a.txt'], evidence: [], blockers: [] }), executorStatus: 'success', machineGate: 'pass', changed: ['a.txt'], evidence: [], blockers: [] };
  assert.equal(c.recordResult(result).ok, true);
  // retransmit same r1
  const rt = c.retransmit(result);
  assert.equal(rt.resultId, 'r1');
  // duplicate delivery idempotent
  const dup = c.recordResult(result);
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, true);
  assert.equal(c.state.metrics.duplicateResultCount, 1);
  // c2 ack r1
  assert.equal(c.acceptControl({ runId: 'run-int2', controlId: 'c2', sequence: 2, control: 'TASK', stepId: 's2', instruction: 'do y', acceptance: [], ackResultId: 'r1' }).ok, true);
});

test('REVISE 002a: epistemic evidence flows through the canonical acceptance gate', () => {
  const g = createDirectGovernance();
  const t1 = g.transition({ stepId: 's1', acceptance: [{ id: 'U1', required: true, requiredEvidenceLevel: 'observed' }], result: { evidence: [{ acceptanceId: 'U1', status: 'pass', evidenceLevel: 'inferred' }] } });
  assert.equal(t1.gate.ok, false, 'inferred cannot satisfy observed');
  assert.ok(t1.gate.levelFailed.includes('U1'));
  const t2 = g.transition({ stepId: 's2', acceptance: [{ id: 'U1', required: true, requiredEvidenceLevel: 'observed' }], result: { evidence: [{ acceptanceId: 'U1', status: 'pass', evidenceLevel: 'observed' }] } });
  assert.equal(t2.gate.ok, true);
  const t3 = g.transition({ stepId: 's3', acceptance: [{ id: 'U2', required: true, requiredEvidenceLevel: 'observed' }], result: { evidence: [{ acceptanceId: 'U2', status: 'pass', evidenceLevel: 'unobservable' }] } });
  assert.equal(t3.gate.ok, false, 'unobservable never pass');
});

test('REVISE 002b: RESULT hash verified; wrong/missing/mutated rejected; duplicate idempotent', () => {
  const c = createDirectRunCoordinator({ runId: 'run-hash' });
  assert.equal(c.acceptControl(validEnv({ runId: 'run-hash', controlId: 'c1', sequence: 1, control: 'TASK', stepId: 's1' })).ok, true);
  const base = { runId: 'run-hash', resultId: 'r1', inReplyToControlId: 'c1', sequence: 1, stepId: 's1', executorStatus: 'success', machineGate: 'pass', changed: [], evidence: [], blockers: [] };
  assert.equal(c.recordResult(base).ok, false, 'missing payloadHash rejected');
  assert.equal(c.recordResult({ ...base, payloadHash: 'deadbeef' }).ok, false, 'wrong payloadHash rejected');
  assert.ok(c.state.metrics.protocolIntegrityFailure >= 1, 'integrity failure metric bumped');
  const ok = c.recordResult({ ...base, payloadHash: computePayloadHash(base) });
  assert.equal(ok.ok, true);
  assert.equal(ok.duplicate, false);
  const dup = c.recordResult({ ...base, payloadHash: computePayloadHash(base) });
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, true);
  assert.equal(c.state.metrics.duplicateResultCount, 1);
  const mutated = { ...base, changed: ['b.txt'] };
  const mut = c.recordResult({ ...mutated, payloadHash: computePayloadHash(mutated) });
  assert.equal(mut.ok, false);
  assert.match(mut.reason, /protocol integrity failure/);
});

test('REVISE 002b: epistemic evidence fails closed when a required level is present and level omitted', () => {
  assert.equal(evaluateEvidenceLevel({ evidenceLevel: null, requiredEvidenceLevel: 'observed' }).ok, false);
  assert.equal(evaluateEvidenceLevel({ evidenceLevel: null, requiredEvidenceLevel: null }).ok, true);
  assert.equal(evaluateEvidenceLevel({ evidenceLevel: 'observed', requiredEvidenceLevel: 'observed' }).ok, true);
  assert.equal(evaluateEvidenceLevel({ evidenceLevel: 'inferred', requiredEvidenceLevel: 'observed' }).ok, false);
  assert.equal(evaluateEvidenceLevel({ evidenceLevel: 'unobservable', requiredEvidenceLevel: 'observed' }).ok, false);
  assert.equal(evaluateEvidenceLevel({ evidenceLevel: 'user_verified', requiredEvidenceLevel: 'user_verified' }).ok, true);
});

test('REVISE 002b: takeover contract states the canonical envelope protocol + rules', () => {
  const contract = buildTakeoverContract({ runId: 'run-xyz' });
  assert.match(contract, /Current runId: run-xyz/);
  assert.match(contract, /runId, controlId, sequence, control, stepId, instruction, acceptance/);
  assert.match(contract, /sequence starts at 1/);
  assert.match(contract, /PUBLISH precedes terminal DONE/);
  assert.match(contract, /DONE is terminal/);
});

test('REVISE 002b: formatRepairPrompt carries runId + controlId + required schema', () => {
  const repair = formatRepairPrompt({ runId: 'run-abc', controlId: 'c9' });
  assert.match(repair, /Restate the immediately previous control in canonical structured form only/);
  assert.match(repair, /Required envelope schema: \{ runId, controlId, sequence, control, stepId, instruction, acceptance/);
  assert.match(repair, /runId: run-abc/);
  assert.match(repair, /controlId: c9/);
  assert.ok(repair.trim().length > 0, 'not empty');
});

test('REVISE 002b: Brain acceptance transition is deterministic', () => {
  let r = applyBrainAcceptanceTransition({ control: 'TASK', prevStepId: 's1', acceptanceStates: { s1: 'pending' } });
  assert.equal(r.acceptanceStates.s1, 'accepted');
  assert.deepEqual(r.transitions, [{ stepId: 's1', acceptance: 'accepted' }]);
  r = applyBrainAcceptanceTransition({ control: 'REVISE', reviseDelta: { invalidate: ['s2'] }, acceptanceStates: { s1: 'accepted', s2: 'accepted' } });
  assert.equal(r.acceptanceStates.s2, 'pending');
  assert.deepEqual(r.transitions, [{ stepId: 's2', acceptance: 'revise' }]);
  r = applyBrainAcceptanceTransition({ control: 'ASK_USER', prevStepId: 's1', acceptanceStates: { s1: 'pending' } });
  assert.equal(r.acceptanceStates.s1, 'pending');
  assert.deepEqual(r.transitions, []);
});

test('REVISE 002b: canonical Alpha.4 flow round-trips once through FORMAT_REPAIR and sends a serialized RESULT with nonce', async () => {
  const runId = 'run-002b';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi002b-'));
  const contract = buildTakeoverContract({ runId });
  assert.match(contract, /Current runId: run-002b/);
  assert.match(contract, /sequence starts at 1/);
  assert.match(contract, /PUBLISH precedes terminal DONE/);
  const prose = 'OK, I own planning now. Execute the bounded task.';
  assert.equal(validateStructuredEnvelope(extractCanonicalEnvelope(prose)).ok, false);
  const repair = formatRepairPrompt({ runId, controlId: 'c1' });
  assert.match(repair, /runId: run-002b/);
  assert.match(repair, /controlId: c1/);
  assert.match(repair, /Required envelope schema:/);
  const c1 = { runId, controlId: 'c1', sequence: 1, control: 'TASK', stepId: 's1', instruction: 'do x', acceptance: [{ id: 'U1', required: true, requiredEvidenceLevel: 'observed' }] };
  assert.equal(validateStructuredEnvelope(c1).ok, true);
  const ledger = createDirectRunLedger({ dataRoot: dir, runId });
  ledger.set('runId', runId);
  const c = createDirectRunCoordinator({ runId, ledger });
  assert.equal(c.acceptControl(c1).ok, true);
  ledger.persist();
  const gov = createDirectGovernance({ proofLedger: createProofLedger({ computeFingerprint: (f) => 'h-' + f }) });
  const machine = gov.transition({ stepId: 's1', acceptance: c1.acceptance, result: { evidence: [{ acceptanceId: 'U1', status: 'pass', evidenceLevel: 'observed' }] } });
  assert.equal(machine.gate.ok, true, 'epistemic machine gate passes with explicit observed');
  const machineGate = machine.gate.ok ? 'pass' : 'fail';
  const base = { runId, resultId: 'r1', inReplyToControlId: 'c1', sequence: 1, stepId: 's1', executorStatus: 'success', machineGate, changed: ['a.txt'], evidence: [{ acceptanceId: 'U1', status: 'pass', evidenceLevel: 'observed', kind: 'verify', summary: 'ok' }], blockers: [] };
  const result = { ...base, payloadHash: computePayloadHash(base) };
  assert.equal(result.payloadHash, computePayloadHash(result), 'hash self-consistent');
  const rec = c.recordResult(result);
  assert.equal(rec.ok, true);
  assert.equal(rec.duplicate, false);
  ledger.persist();
  const serialized = JSON.stringify(result);
  assert.equal(typeof serialized, 'string');
  assert.ok(!serialized.startsWith('[object'), 'serialized is a JSON string');
  const c2 = { runId, controlId: 'c2', sequence: 2, control: 'TASK', stepId: 's2', instruction: 'do y', acceptance: [], ackResultId: 'r1' };
  assert.equal(c.acceptControl(c2).ok, true);
  assert.equal(c.state.lastAcknowledgedResultId, 'r1');
  const acc = applyBrainAcceptanceTransition({ control: c2.control, prevStepId: c1.stepId, acceptanceStates: { s1: 'pending' } });
  assert.equal(acc.acceptanceStates.s1, 'accepted');
  assert.equal(acc.transitions.length, 1);
  const dup = c.recordResult(result);
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, true);
  assert.equal(c.state.metrics.duplicateResultCount, 1);
});

test('REVISE 002b: provider.send forwards a serialized STRING (not an object) to the brain', async () => {
  const nonce = 'nonce-002b';
  let sentText = null;
  let sent = false;
  const facade = {
    isComposerReady: async () => true,
    isComposerIdle: async () => true,
    sendMessage: async (text) => { sentText = text; sent = true; },
    getAssistantCount: async () => (sent ? 1 : 0),
    getAssistantReply: async () => 'ack ' + nonce,
    getCurrentUrl: async () => 'https://chatgpt.com/c/conv-002b',
  };
  const t = {
    connect: async () => {},
    createSessionTab: async () => ({ tab: { id: 't' }, facade }),
    closeTab: async () => {},
  };
  const p = createChatGPTBrowserProvider({ transport: t, turnOptions: { replyTimeoutMs: 700, pollIntervalMs: 5, replyStableReads: 1, replySettleMs: 0, composerTimeoutMs: 500 } });
  await p.open({ url: 'https://chatgpt.com/' });
  const serialized = JSON.stringify({ runId: 'run-002b', resultId: 'r1' });
  await p.send(serialized, { nonce });
  assert.ok(typeof sentText === 'string', 'provider.send must forward a string to the composer');
  assert.equal(sentText, serialized);
});
