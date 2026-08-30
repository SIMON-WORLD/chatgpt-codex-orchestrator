import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateMilestoneAcceptance, evaluateEvidenceLevel, validateStructuredEnvelope, formatRepairPrompt, createDirectRunCoordinator, createDirectRunLedger, applyReviseDelta, buildAskUserEnvelope } from '../src/protocol-integrity.js';
import { createDirectGovernance, createProofLedger, createDirectMetrics } from '../src/direct-governance.js';
import { createChatGPTBrowserProvider, DEFAULT_DIRECT_CONFIG, DIRECT_MODE_REQUIRES, evaluatePublicationGate, evaluateDoneGate } from '../src/direct-mode.js';
import { isTerminalControl, validateLifecycleAfterDone, parseBrainOutput } from '../src/protocol.js';
import { AtomicTurnController, ReplyTimeoutError, ComposerTimeoutError } from '../src/atomic-turn.js';
import { createTabFacade } from '../src/iab-transport.js';

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
  assert.equal(c.recordResult({ resultId: 'r6', inReplyToControlId: 'c6', payloadHash: 'h' }).ok, false, 'RESULT must match outstanding control');
  assert.equal(c.recordResult({ resultId: 'r7', inReplyToControlId: 'c7', payloadHash: 'h1' }).ok, true);
  assert.equal(c.state.outstandingControlId, null);
});

test('duplicate RESULT idempotent, retransmit preserves resultId + payloadHash', () => {
  const c = createDirectRunCoordinator();
  c.acceptControl(validEnv({ sequence: 7, controlId: 'c7' }));
  const r1 = c.recordResult({ resultId: 'r7', inReplyToControlId: 'c7', payloadHash: 'h1' });
  assert.equal(r1.ok, true); assert.equal(r1.duplicate, false);
  // retransmit the SAME result
  const rt = c.retransmit({ resultId: 'r7', payloadHash: 'h1' });
  assert.equal(rt.resultId, 'r7'); assert.equal(rt.payloadHash, 'h1');
  assert.equal(c.state.metrics.resultRetransmitCount, 1);
});

test('next control piggybacks ackResultId; RESULT becomes acknowledged', () => {
  const c = createDirectRunCoordinator();
  c.acceptControl(validEnv({ sequence: 7, controlId: 'c7' }));
  c.recordResult({ resultId: 'r7', inReplyToControlId: 'c7', payloadHash: 'h1' });
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
  const p = createChatGPTBrowserProvider({ transport: t });
  assert.equal(p._transport, t, 'provider owns exactly one transport');
  assert.equal(typeof p.send, 'function');
  assert.equal(DEFAULT_DIRECT_CONFIG.brainProvider, 'chatgpt');
  assert.equal(DIRECT_MODE_REQUIRES.nestedCodex, false);
  assert.equal(DIRECT_MODE_REQUIRES.workerBootstrap, false);
  assert.equal(typeof p.adoptConversation, 'function');
  assert.equal(typeof p.adoptCurrent, 'function');
});

test('composer fail-closed still resolves #prompt-textarea; canonical Skill orders machine gate before send', async () => {
  const facade = createTabFacade({ id: 't', playwright: { locator: (s) => ({ count: async () => s === '#prompt-textarea' ? 1 : 0, evaluate: async () => false, fill: async () => {}, press: async () => {}, innerText: async () => '' }), waitForTimeout: async () => {} } });
  assert.equal(await facade.isComposerReady(), true);
  const skill = fs.readFileSync(skillPath, 'utf8');
  const runSection = skill.slice(skill.indexOf('## Run (canonical default path)'));
  assert.ok(runSection.indexOf('governance.transition') < runSection.indexOf('provider.send'), 'machine transition before send');
  assert.match(runSection, /Run the machine acceptance transition, THEN send the compact RESULT/);
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
