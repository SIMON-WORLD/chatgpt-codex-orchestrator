import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDirectRun, DIRECT_ALPHA4_MODE, assertDirectAlpha4Mode } from '../src/direct-run-controller.js';

const controllerPath = fileURLToPath(new URL('../src/direct-run-controller.js', import.meta.url));
const skillPath = fileURLToPath(new URL('../skills/brain-command/SKILL.md', import.meta.url));

// Deterministic scripted Brain: consumes an ordered list of reply strings on each
// send, records outbound message + nonce, and counts provider.open / adopt calls.
function makeFakeBrain(replies, { conversationId = 'conv-1' } = {}) {
  let i = 0;
  let currentId = conversationId;
  const state = { sent: [], openCount: 0, openCalls: [], adoptCount: 0 };
  return {
    ...state,
    async send(message, { nonce } = {}) {
      this.sent.push({ message, nonce });
      const reply = (replies && i < replies.length) ? replies[i] : 'ack';
      i += 1;
      return { reply, conversationId: currentId, conversationUrl: 'https://chatgpt.com/c/' + currentId, ownedTabId: 't1' };
    },
    async open({ url } = {}) {
      this.openCount += 1;
      this.openCalls.push(url);
      currentId = 'conv-new';
      return { conversationId: currentId, conversationUrl: 'https://chatgpt.com/c/' + currentId, ownedTabId: 't-new' };
    },
    async adoptConversation() {
      this.adoptCount += 1;
      currentId = 'conv-exist';
      return { conversationId: currentId, conversationUrl: 'https://chatgpt.com/c/' + currentId, ownedTabId: 't-e' };
    },
    async resume() {
      currentId = currentId || conversationId;
      return { conversationId: currentId, conversationUrl: 'https://chatgpt.com/c/' + currentId, ownedTabId: 't1' };
    },
  };
}

const c1 = { runId: 'run-c', controlId: 'c1', sequence: 1, control: 'TASK', stepId: 's1', instruction: 'do x', acceptance: [{ id: 'U1', required: true, requiredEvidenceLevel: 'observed' }] };
const c2 = { runId: 'run-c', controlId: 'c2', sequence: 2, control: 'TASK', stepId: 's2', instruction: 'do y', acceptance: [], ackResultId: 'r1' };
const cPublish = { runId: 'run-c', controlId: 'c3', sequence: 3, control: 'PUBLISH', stepId: 's3', instruction: 'publish', acceptance: [], ackResultId: 'r2' };
const cDone = { runId: 'run-c', controlId: 'c4', sequence: 4, control: 'DONE', stepId: 's4', instruction: 'done', acceptance: [], ackResultId: 'r3' };
const c1D = { ...c1, runId: 'run-d' };
const c2D = { ...c2, runId: 'run-d' };

test('controller is canonical direct-alpha4 and does not reach legacy TaskService/worker path', () => {
  assert.equal(DIRECT_ALPHA4_MODE, 'direct-alpha4');
  assert.throws(() => assertDirectAlpha4Mode('legacy'), /invalid mode/);
  const src = fs.readFileSync(controllerPath, 'utf8');
  for (const banned of ["from './task-service.js'", "from './task-manager.js'", "from './loop-controller.js'", "from './worker-client.js'", 'createTask(', 'advanceTask(', 'new LoopController(']) {
    assert.ok(!src.includes(banned), `controller must not reference ${banned}`);
  }
  // Behavioural guard: the controller runs purely in-memory/offline (no worker, no ready file).
  const run = createDirectRun({ runId: 'run-guard', repoDir: '.', provider: makeFakeBrain(['ack']) });
  assert.equal(run.mode, 'direct-alpha4');
  assert.ok(run.ledger && run.coordinator && run.governance);
});

test('canonical Alpha.4 flow: takeover -> one FORMAT_REPAIR -> c1 -> gate -> r1 -> nonce send -> c2 ack r1 -> Brain accept -> PUBLISH -> DONE', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-'));
  const fake = makeFakeBrain([
    'OK, I own planning now. Execute the bounded task.',   // prose (no envelope) -> triggers FORMAT_REPAIR
    JSON.stringify(c1),                                    // repaired structured c1
    JSON.stringify(c2),                                    // reply to r1
    JSON.stringify(cPublish),                              // reply to r2
    JSON.stringify(cDone),                                 // reply to r3
  ]);
  const run = createDirectRun({ runId: 'run-c', dataRoot: dir, repoDir: '.', provider: fake });
  run.setOrchestratorHead('19cc3fac3b3687c4042cad2551023d16010bd531');

  const start = await run.start({ goal: 'do x', bootstrap: 'BOOTSTRAP', allowRepair: true });
  assert.equal(start.ok, true, 'start accepted the repaired c1');
  assert.equal(start.control.control, 'TASK');
  assert.equal(start.control.controlId, 'c1');
  assert.equal(run.coordinator.state.outstandingControlId, 'c1');
  // exactly ONE FORMAT_REPAIR happened
  assert.equal(fake.sent.length, 2, 'takeover send + one repair send');
  assert.match(fake.sent[1].message, /Restate the immediately previous control/);
  assert.match(fake.sent[1].nonce, /^repair-/);

  // Executor evidence -> machine gate -> RESULT r1 -> nonce send
  const prep = run.prepareResult({ stepId: 's1', executorStatus: 'success', changed: ['a.txt'], evidence: [{ acceptanceId: 'U1', status: 'pass', evidenceLevel: 'observed' }], blockers: [] });
  assert.equal(prep.ok, true, 'recordResult r1 ok');
  assert.equal(prep.machineGate, 'pass');
  assert.equal(prep.result.resultId, 'r1');
  assert.equal(prep.result.payloadHash, run.coordinator.state.results.r1.payloadHash);
  const sent = await run.sendResult();
  assert.equal(sent.ok, true, 'r1 sent');
  assert.ok(typeof sent.reply === 'string');
  assert.equal(fake.sent[2].message, prep.serialized, 'RESULT serialized as string');
  assert.match(fake.sent[2].nonce, /^r-run-c-r1$/);
  const c2Parsed = JSON.parse(sent.reply);

  // Brain acceptance transition + next control c2 ack r1
  const acc2 = await run.acceptBrainReply(sent.reply, { allowRepair: false });
  assert.equal(acc2.ok, true, 'c2 accepted');
  assert.equal(c2Parsed.controlId, 'c2');
  assert.equal(run.coordinator.state.lastAcknowledgedResultId, 'r1');
  assert.equal(run.governance.state.brainAcceptance.s1, 'accepted', 'prior milestone s1 accepted via applyBrainAcceptanceTransition');

  // c2 -> RESULT r2
  const prep2 = run.prepareResult({ stepId: 's2', executorStatus: 'success', changed: [], evidence: [], blockers: [] });
  assert.equal(prep2.ok, true);
  assert.equal(prep2.result.resultId, 'r2');
  const sent2 = await run.sendResult();
  const pubParsed = JSON.parse(sent2.reply);
  const accPub = await run.acceptBrainReply(sent2.reply, { allowRepair: false });
  assert.equal(accPub.ok, true);
  assert.equal(pubParsed.control, 'PUBLISH');
  assert.equal(run.coordinator.state.lastAcknowledgedResultId, 'r2');
  assert.equal(run.governance.state.brainAcceptance.s2, 'accepted');

  // PUBLISH gate
  const pubGate = run.publicationGate({ brainControl: 'PUBLISH', acceptanceGateOk: true, identityPreflightOk: true, workingTreeScopeOk: true });
  assert.equal(pubGate.ok, true, 'PUBLISH authorizes publication');
  assert.equal(run.publicationGate({ brainControl: 'DONE', acceptanceGateOk: true, identityPreflightOk: true, workingTreeScopeOk: true }).ok, false, 'DONE never authorizes publishing');

  // c3 PUBLISH -> RESULT r3 -> DONE
  const prep3 = run.prepareResult({ stepId: 's3', executorStatus: 'success', changed: [], evidence: [{ acceptanceId: 'PUBLISH', status: 'pass', evidenceLevel: 'observed' }], blockers: [] });
  assert.equal(prep3.ok, true);
  const sent3 = await run.sendResult();
  const doneParsed = JSON.parse(sent3.reply);
  const accDone = await run.acceptBrainReply(sent3.reply, { allowRepair: false });
  assert.equal(accDone.ok, true);
  assert.equal(doneParsed.control, 'DONE');
  assert.equal(run.isTerminal('DONE'), true);
  const doneGate = run.doneGate({ publicationReady: true, finalVerificationOk: true, workingTreeScopeOk: true });
  assert.equal(doneGate.ok, true, 'DONE requires publication ready');

  // metrics
  const m = run.metrics();
  assert.equal(m.protocolRepairCount, 1);
  assert.equal(m.taskCount, 2);
  assert.equal(m.publishCount, 1);
  assert.equal(m.brainTurns, 4);
  assert.ok(m.duration >= 0);
  assert.equal(m.coordinator.duplicateResultCount, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('canonical delivery recovery: r1 frozen, send timeout, restart -> same r1 retransmitted, no new resultId, no duplicate execution', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc2-'));
  // Phase 1: accept c1, prepare r1, then a send that throws (composer uncertainty).
  const fake1 = makeFakeBrain([JSON.stringify(c1D)]);
  const run1 = createDirectRun({ runId: 'run-d', dataRoot: dir, repoDir: '.', provider: fake1 });
  const start1 = await run1.start({ goal: 'do x', bootstrap: 'B', allowRepair: false });
  assert.equal(start1.ok, true);
  assert.equal(run1.coordinator.state.lastAcceptedControlId, 'c1');
  const prep1 = run1.prepareResult({ stepId: 's1', executorStatus: 'success', changed: ['a.txt'], evidence: [{ acceptanceId: 'U1', status: 'pass', evidenceLevel: 'observed' }], blockers: [] });
  assert.equal(prep1.ok, true);
  const r1 = prep1.result;
  // Simulate send timeout by making provider.send throw on the result send.
  let throwOnResult = true;
  const fake1b = { ...fake1, send: async (message, opts) => { if (throwOnResult && opts && /^r-run-d-r1$/.test(opts.nonce)) { throw new Error('composer unavailable'); } return fake1.send(message, opts); } };
  run1.provider = fake1b;
  const failedSend = await run1.sendResult();
  assert.equal(failedSend.ok, false);
  assert.equal(failedSend.pending, true);
  assert.equal(run1.pendingResult.resultId, 'r1');

  // Phase 2: controller/provider restart -> resume from ledger.
  const fake2 = makeFakeBrain([JSON.stringify(c2D)]);
  const run2 = createDirectRun({ runId: 'run-d', dataRoot: dir, repoDir: '.', provider: fake2 });
  const resumed = await run2.resume();
  assert.equal(resumed.ok, true);
  assert.equal(resumed.retransmitted, true, 'unacknowledged r1 retransmitted');
  assert.equal(resumed.resultId, 'r1', 'same frozen resultId reused');
  // Same payloadHash, no new resultId, no duplicate execution.
  assert.equal(run2.coordinator.state.results.r1.payloadHash, r1.payloadHash);
  assert.equal(run2.frozenResult ? run2.frozenResult.resultId : null, 'r1');
  assert.equal(fake2.sent.length, 1, 'only the retransmit was sent, no redo of takeover');
  assert.equal(run2.coordinator.state.processedControlIds.includes('c1'), true, 'c1 not re-executed');
  // No new resultId created.
  assert.equal(run2.coordinator.state.lastSentResultId, 'r1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Skill truth simplification: canonical SKILL references the Direct controller, not the manual primitive recipe', () => {
  const skill = fs.readFileSync(skillPath, 'utf8');
  assert.match(skill, /direct-run-controller|createDirectRun/);
  assert.match(skill, /direct-alpha4|DIRECT_ALPHA4_MODE/);
  // The long manual "wire governance.transition / provider.send" recipe is removed.
  assert.ok(!skill.includes('7. **Freeze RESULT identity, machine gate, serialize, then send'), 'manual step 7 recipe removed');
  assert.ok(!skill.includes('const machine = governance.transition({ stepId, acceptance, result: { changed, evidence } });'), 'manual recipe removed');
});

// --- REVISE 004a: focused controller-level advancement / startup tests ---------

test('REVISE 004a A: new conversation opens provider exactly once before takeover send', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-004a-'));
  const c1A = { ...c1, runId: 'run-a' };
  const fake = makeFakeBrain([JSON.stringify(c1A)]);
  const run = createDirectRun({ runId: 'run-a', dataRoot: dir, repoDir: '.', provider: fake });
  const start = await run.start({ goal: 'do x', bootstrap: 'B', allowRepair: false });
  assert.equal(start.ok, true);
  assert.equal(fake.openCount, 1, 'provider.open called exactly once for a new conversation');
  assert.equal(fake.openCalls.length, 1);
  assert.equal(fake.sent.length, 1, 'exactly one takeover send, no repair send');
  assert.match(fake.sent[0].message, /Current runId: run-a/);
  assert.match(fake.sent[0].nonce, /^takeover-/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('REVISE 004a B: adoptConversation then start does NOT open a second conversation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-004b-'));
  const c1B = { ...c1, runId: 'run-b' };
  const fake = makeFakeBrain([JSON.stringify(c1B)]);
  const run = createDirectRun({ runId: 'run-b', dataRoot: dir, repoDir: '.', provider: fake });
  await run.adoptConversation({ conversationId: 'conv-exist' });
  const start = await run.start({ goal: 'do x', bootstrap: 'B', allowRepair: false });
  assert.equal(start.ok, true);
  assert.equal(fake.openCount, 0, 'no provider.open after adoptConversation');
  assert.equal(fake.adoptCount, 1);
  assert.equal(run.ledger.state.conversationId, 'conv-exist');
  assert.equal(fake.sent.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('REVISE 004a C: advance requires prior RESULT success + pass + ack r1 (prior accepted)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-004c-'));
  const c1C = { ...c1, runId: 'run-c' };
  const c2C = { ...c2, runId: 'run-c', ackResultId: 'r1' };
  const fake = makeFakeBrain([JSON.stringify(c1C), JSON.stringify(c2C)]);
  const run = createDirectRun({ runId: 'run-c', dataRoot: dir, repoDir: '.', provider: fake });
  const start = await run.start({ goal: 'do x', bootstrap: 'B', allowRepair: false });
  assert.equal(start.ok, true);
  const prep = run.prepareResult({ stepId: 's1', executorStatus: 'success', changed: ['a.txt'], evidence: [{ acceptanceId: 'U1', status: 'pass', evidenceLevel: 'observed' }], blockers: [] });
  assert.equal(prep.machineGate, 'pass');
  const sent = await run.sendResult();
  const acc = await run.acceptBrainReply(sent.reply, { allowRepair: false });
  assert.equal(acc.ok, true);
  assert.equal(acc.priorAccepted, true);
  assert.equal(run.governance.state.brainAcceptance.s1, 'accepted', 'prior milestone accepted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('REVISE 004a D: cannot advance when prior machineGate failed (prior NOT accepted)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-004d-'));
  const c1D2 = { ...c1, runId: 'run-d' };
  const c2D2 = { ...c2, runId: 'run-d', ackResultId: 'r1' };
  const fake = makeFakeBrain([JSON.stringify(c1D2), JSON.stringify(c2D2)]);
  const run = createDirectRun({ runId: 'run-d', dataRoot: dir, repoDir: '.', provider: fake });
  const start = await run.start({ goal: 'do x', bootstrap: 'B', allowRepair: false });
  assert.equal(start.ok, true);
  const prep = run.prepareResult({ stepId: 's1', executorStatus: 'success', changed: [], evidence: [], blockers: [] });
  assert.equal(prep.machineGate, 'fail', 'missing U1 evidence -> gate fail');
  const sent = await run.sendResult();
  const acc = await run.acceptBrainReply(sent.reply, { allowRepair: false });
  assert.equal(acc.ok, false);
  assert.equal(acc.protocolIntegrity, true, 'advancement over a failed gate is a protocol-integrity failure');
  assert.notEqual(run.governance.state.brainAcceptance.s1, 'accepted', 'prior NOT accepted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('REVISE 004a E: advance with RESULT present but NO ackResultId fails closed (prior NOT accepted)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-004e-'));
  const c1E = { ...c1, runId: 'run-e' };
  const c2E = { ...c2, runId: 'run-e' };
  delete c2E.ackResultId;
  const fake = makeFakeBrain([JSON.stringify(c1E), JSON.stringify(c2E)]);
  const run = createDirectRun({ runId: 'run-e', dataRoot: dir, repoDir: '.', provider: fake });
  const start = await run.start({ goal: 'do x', bootstrap: 'B', allowRepair: false });
  assert.equal(start.ok, true);
  const prep = run.prepareResult({ stepId: 's1', executorStatus: 'success', changed: ['a.txt'], evidence: [{ acceptanceId: 'U1', status: 'pass', evidenceLevel: 'observed' }], blockers: [] });
  assert.equal(prep.machineGate, 'pass');
  const sent = await run.sendResult();
  const acc = await run.acceptBrainReply(sent.reply, { allowRepair: false });
  assert.equal(acc.ok, false, 'missing ackResultId fails closed');
  assert.equal(acc.protocolIntegrity, true);
  assert.equal(acc.expectedAckResultId, 'r1');
  assert.equal(acc.got, null);
  assert.notEqual(run.governance.state.brainAcceptance.s1, 'accepted', 'prior NOT accepted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('REVISE 004a F: advance with WRONG ackResultId fails closed (prior NOT accepted)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-004f-'));
  const c1F = { ...c1, runId: 'run-f' };
  const c2F = { ...c2, runId: 'run-f', ackResultId: 'r999' };
  const fake = makeFakeBrain([JSON.stringify(c1F), JSON.stringify(c2F)]);
  const run = createDirectRun({ runId: 'run-f', dataRoot: dir, repoDir: '.', provider: fake });
  const start = await run.start({ goal: 'do x', bootstrap: 'B', allowRepair: false });
  assert.equal(start.ok, true);
  const prep = run.prepareResult({ stepId: 's1', executorStatus: 'success', changed: ['a.txt'], evidence: [{ acceptanceId: 'U1', status: 'pass', evidenceLevel: 'observed' }], blockers: [] });
  assert.equal(prep.machineGate, 'pass');
  const sent = await run.sendResult();
  const acc = await run.acceptBrainReply(sent.reply, { allowRepair: false });
  assert.equal(acc.ok, false, 'wrong ackResultId fails closed');
  assert.equal(acc.protocolIntegrity, true);
  assert.equal(acc.expectedAckResultId, 'r1');
  assert.equal(acc.got, 'r999');
  assert.notEqual(run.governance.state.brainAcceptance.s1, 'accepted', 'prior NOT accepted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('REVISE 004a G: REVISE after failed r1 applies revise transition, no false accepted state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-004g-'));
  const c1G = { ...c1, runId: 'run-g' };
  const reviseEnv = { runId: 'run-g', controlId: 'c2', sequence: 2, control: 'REVISE', stepId: 's1', instruction: 'fix', acceptance: [], ackResultId: 'r1', reviseDelta: { invalidate: ['s1'] } };
  const fake = makeFakeBrain([JSON.stringify(c1G), JSON.stringify(reviseEnv)]);
  const run = createDirectRun({ runId: 'run-g', dataRoot: dir, repoDir: '.', provider: fake });
  const start = await run.start({ goal: 'do x', bootstrap: 'B', allowRepair: false });
  assert.equal(start.ok, true);
  const prep = run.prepareResult({ stepId: 's1', executorStatus: 'failure', changed: [], evidence: [], blockers: [] });
  assert.equal(prep.machineGate, 'fail');
  const sent = await run.sendResult();
  const acc = await run.acceptBrainReply(sent.reply, { allowRepair: false });
  assert.equal(acc.ok, true, 'REVISE accepted even after failed r1');
  assert.equal(acc.control.control, 'REVISE');
  assert.equal(run.coordinator.state.lastAcceptedControlId, 'c2');
  assert.notEqual(run.governance.state.brainAcceptance.s1, 'accepted', 'no false accepted state');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('REVISE 004a H: ASK_USER after r1 does NOT silently accept the prior', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-004h-'));
  const c1H = { ...c1, runId: 'run-h' };
  const askEnv = { runId: 'run-h', controlId: 'c2', sequence: 2, control: 'ASK_USER', stepId: 's2', instruction: 'ask', acceptance: [], ackResultId: 'r1', askUser: { whyBlocked: 'need input', minimalUserAction: 'run cmd', readOnly: true, resumeControlId: 'c1' } };
  const fake = makeFakeBrain([JSON.stringify(c1H), JSON.stringify(askEnv)]);
  const run = createDirectRun({ runId: 'run-h', dataRoot: dir, repoDir: '.', provider: fake });
  const start = await run.start({ goal: 'do x', bootstrap: 'B', allowRepair: false });
  assert.equal(start.ok, true);
  const prep = run.prepareResult({ stepId: 's1', executorStatus: 'success', changed: ['a.txt'], evidence: [{ acceptanceId: 'U1', status: 'pass', evidenceLevel: 'observed' }], blockers: [] });
  assert.equal(prep.machineGate, 'pass');
  const sent = await run.sendResult();
  const acc = await run.acceptBrainReply(sent.reply, { allowRepair: false });
  assert.equal(acc.ok, true);
  assert.equal(acc.control.control, 'ASK_USER');
  assert.notEqual(run.governance.state.brainAcceptance.s1, 'accepted', 'ASK_USER must not silently accept the prior milestone');
  assert.equal(run.governance.state.brainAcceptance.s1 ? run.governance.state.brainAcceptance.s1 : 'pending', 'pending');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- REVISE 004b: control-lifecycle closure (every non-terminal control -> 1 RESULT) ---

test('REVISE 004b A: PLAN -> RESULT r1 -> TASK c2 ack r1 (no outstanding-control deadlock)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-004bA-'));
  const planC1 = { runId: 'run-p1', controlId: 'c1', sequence: 1, control: 'PLAN', stepId: 's1', instruction: 'plan', acceptance: [] };
  const taskC2 = { runId: 'run-p1', controlId: 'c2', sequence: 2, control: 'TASK', stepId: 's2', instruction: 'do y', acceptance: [], ackResultId: 'r1' };
  const fake = makeFakeBrain([JSON.stringify(planC1), JSON.stringify(taskC2)]);
  const run = createDirectRun({ runId: 'run-p1', dataRoot: dir, repoDir: '.', provider: fake });
  const start = await run.start({ goal: 'do x', bootstrap: 'B', allowRepair: false });
  assert.equal(start.ok, true);
  assert.equal(start.control.control, 'PLAN');
  assert.equal(run.coordinator.state.outstandingControlId, 'c1');
  const prep = run.prepareResult({ stepId: 's1', executorStatus: 'success', changed: [], evidence: [], blockers: [] });
  assert.equal(prep.ok, true);
  assert.equal(run.coordinator.state.outstandingControlId, null, 'RESULT clears PLAN outstanding');
  const sent = await run.sendResult();
  const acc = await run.acceptBrainReply(sent.reply, { allowRepair: false });
  assert.equal(acc.ok, true);
  assert.equal(acc.control.control, 'TASK');
  assert.equal(run.coordinator.state.outstandingControlId, 'c2', 'c2 becomes outstanding, no deadlock');
  assert.equal(acc.priorAccepted, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('REVISE 004b B: failed r1 -> REVISE c2 ack r1 -> accepted + ack recorded + prior NOT falsely accepted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-004bB-'));
  const c1B = { ...c1, runId: 'run-p2' };
  const reviseB = { runId: 'run-p2', controlId: 'c2', sequence: 2, control: 'REVISE', stepId: 's1', instruction: 'fix', acceptance: [], ackResultId: 'r1', reviseDelta: { invalidate: ['s1'] } };
  const fake = makeFakeBrain([JSON.stringify(c1B), JSON.stringify(reviseB)]);
  const run = createDirectRun({ runId: 'run-p2', dataRoot: dir, repoDir: '.', provider: fake });
  const start = await run.start({ goal: 'do x', bootstrap: 'B', allowRepair: false });
  assert.equal(start.ok, true);
  const prep = run.prepareResult({ stepId: 's1', executorStatus: 'failure', changed: [], evidence: [], blockers: [] });
  assert.equal(prep.machineGate, 'fail');
  const sent = await run.sendResult();
  const acc = await run.acceptBrainReply(sent.reply, { allowRepair: false });
  assert.equal(acc.ok, true, 'REVISE accepted');
  assert.equal(acc.control.control, 'REVISE');
  assert.equal(run.coordinator.state.lastAcknowledgedResultId, 'r1', 'r1 acknowledged');
  assert.ok(run.coordinator.state.acknowledgedResultIds.includes('r1'));
  assert.notEqual(run.governance.state.brainAcceptance.s1, 'accepted', 'prior NOT falsely accepted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('REVISE 004b C: failed r1 -> ASK_USER c2 ack r1 -> user_verified RESULT r2 -> c3 ack r2 (no deadlock, blocked milestone not silently accepted)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-004bC-'));
  const c1C = { ...c1, runId: 'run-p3' };
  const askC = { runId: 'run-p3', controlId: 'c2', sequence: 2, control: 'ASK_USER', stepId: 's2', instruction: 'ask', acceptance: [], ackResultId: 'r1', askUser: { whyBlocked: 'blocked', minimalUserAction: 'x', readOnly: true, resumeControlId: 'c1' } };
  const c3C = { runId: 'run-p3', controlId: 'c3', sequence: 3, control: 'REVISE', stepId: 's3', instruction: 'fix', acceptance: [], ackResultId: 'r2', reviseDelta: { invalidate: ['s1'] } };
  const fake = makeFakeBrain([JSON.stringify(c1C), JSON.stringify(askC), JSON.stringify(c3C)]);
  const run = createDirectRun({ runId: 'run-p3', dataRoot: dir, repoDir: '.', provider: fake });
  const start = await run.start({ goal: 'do x', bootstrap: 'B', allowRepair: false });
  assert.equal(start.ok, true);
  const prep1 = run.prepareResult({ stepId: 's1', executorStatus: 'failure', changed: [], evidence: [], blockers: [] });
  assert.equal(prep1.machineGate, 'fail');
  const sent1 = await run.sendResult();
  const accAsk = await run.acceptBrainReply(sent1.reply, { allowRepair: false });
  assert.equal(accAsk.ok, true, 'ASK_USER accepted with ack r1');
  assert.equal(accAsk.control.control, 'ASK_USER');
  assert.equal(run.coordinator.state.outstandingControlId, 'c2', 'ASK_USER outstanding while waiting');
  const prep2 = run.prepareResult({ stepId: 's2', executorStatus: 'success', changed: [], evidence: [{ acceptanceId: 'USER', status: 'pass', evidenceLevel: 'user_verified', summary: 'user input' }], blockers: [] });
  assert.equal(prep2.ok, true, 'user_verified RESULT r2 recorded');
  assert.equal(prep2.result.resultId, 'r2');
  assert.equal(run.coordinator.state.outstandingControlId, null, 'r2 clears ASK_USER outstanding');
  const sent2 = await run.sendResult();
  const acc3 = await run.acceptBrainReply(sent2.reply, { allowRepair: false });
  assert.equal(acc3.ok, true, 'c3 (REVISE) accepted with ack r2');
  assert.equal(acc3.control.control, 'REVISE');
  assert.equal(run.coordinator.state.lastAcknowledgedResultId, 'r2');
  assert.notEqual(run.governance.state.brainAcceptance.s1, 'accepted', 'original BLOCKED milestone s1 not silently accepted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('REVISE 004b D: REPLAN -> RESULT r1 -> TASK c2 ack r1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-004bD-'));
  const replanC1 = { runId: 'run-p4', controlId: 'c1', sequence: 1, control: 'REPLAN', stepId: 's1', instruction: 'replan', acceptance: [], reviseDelta: { invalidate: ['s0'] } };
  const taskC2 = { runId: 'run-p4', controlId: 'c2', sequence: 2, control: 'TASK', stepId: 's2', instruction: 'do y', acceptance: [], ackResultId: 'r1' };
  const fake = makeFakeBrain([JSON.stringify(replanC1), JSON.stringify(taskC2)]);
  const run = createDirectRun({ runId: 'run-p4', dataRoot: dir, repoDir: '.', provider: fake });
  const start = await run.start({ goal: 'do x', bootstrap: 'B', allowRepair: false });
  assert.equal(start.ok, true);
  assert.equal(start.control.control, 'REPLAN');
  const prep = run.prepareResult({ stepId: 's1', executorStatus: 'success', changed: [], evidence: [], blockers: [] });
  assert.equal(prep.ok, true);
  assert.equal(run.coordinator.state.outstandingControlId, null);
  const sent = await run.sendResult();
  const acc = await run.acceptBrainReply(sent.reply, { allowRepair: false });
  assert.equal(acc.ok, true);
  assert.equal(acc.control.control, 'TASK');
  assert.equal(run.coordinator.state.outstandingControlId, 'c2');
  assert.equal(acc.priorAccepted, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('REVISE 004b E: ANY next control after an unacknowledged RESULT with missing/wrong ack fails closed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-004bE-'));
  const c1E = { ...c1, runId: 'run-p5' };
  const reviseE = { runId: 'run-p5', controlId: 'c2', sequence: 2, control: 'REVISE', stepId: 's1', instruction: 'fix', acceptance: [] };
  const fake = makeFakeBrain([JSON.stringify(c1E), JSON.stringify(reviseE)]);
  const run = createDirectRun({ runId: 'run-p5', dataRoot: dir, repoDir: '.', provider: fake });
  const start = await run.start({ goal: 'do x', bootstrap: 'B', allowRepair: false });
  assert.equal(start.ok, true);
  const prep = run.prepareResult({ stepId: 's1', executorStatus: 'failure', changed: [], evidence: [], blockers: [] });
  assert.equal(prep.machineGate, 'fail');
  const sent = await run.sendResult();
  const acc = await run.acceptBrainReply(sent.reply, { allowRepair: false });
  assert.equal(acc.ok, false, 'REVISE (non-advancing) without ack still fails closed');
  assert.equal(acc.protocolIntegrity, true);
  assert.equal(acc.expectedAckResultId, 'r1');
  assert.equal(acc.got, null);
  assert.ok(!run.coordinator.state.acknowledgedResultIds.includes('r1'), 'r1 NOT acknowledged');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('REVISE 004b F: DONE after PUBLISH RESULT requires correct ackResultId, is terminal, produces no new RESULT', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-004bF-'));
  const c1F = { ...c1, runId: 'run-p6' };
  const pubF = { runId: 'run-p6', controlId: 'c2', sequence: 2, control: 'PUBLISH', stepId: 's2', instruction: 'publish', acceptance: [], ackResultId: 'r1' };
  const doneF = { runId: 'run-p6', controlId: 'c3', sequence: 3, control: 'DONE', stepId: 's3', instruction: 'done', acceptance: [], ackResultId: 'r2' };
  const fake = makeFakeBrain([JSON.stringify(c1F), JSON.stringify(pubF), JSON.stringify(doneF)]);
  const run = createDirectRun({ runId: 'run-p6', dataRoot: dir, repoDir: '.', provider: fake });
  const start = await run.start({ goal: 'do x', bootstrap: 'B', allowRepair: false });
  assert.equal(start.ok, true);
  const prep1 = run.prepareResult({ stepId: 's1', executorStatus: 'success', changed: [], evidence: [{ acceptanceId: 'U1', status: 'pass', evidenceLevel: 'observed' }], blockers: [] });
  assert.equal(prep1.machineGate, 'pass');
  const sent1 = await run.sendResult();
  const accPub = await run.acceptBrainReply(sent1.reply, { allowRepair: false });
  assert.equal(accPub.ok, true);
  assert.equal(accPub.control.control, 'PUBLISH');
  assert.equal(run.publicationGate({ brainControl: 'PUBLISH', acceptanceGateOk: true, identityPreflightOk: true, workingTreeScopeOk: true }).ok, true);
  const prep2 = run.prepareResult({ stepId: 's2', executorStatus: 'success', changed: [], evidence: [{ acceptanceId: 'PUB', status: 'pass', evidenceLevel: 'observed' }], blockers: [] });
  assert.equal(prep2.result.resultId, 'r2');
  const sent2 = await run.sendResult();
  // DONE with correct ack r2 is accepted; DONE is terminal and produces NO new RESULT.
  const accDone = await run.acceptBrainReply(sent2.reply, { allowRepair: false });
  assert.equal(accDone.ok, true, 'DONE accepted with ack r2');
  assert.equal(accDone.control.control, 'DONE');
  assert.equal(run.isTerminal('DONE'), true);
  assert.equal(run.doneGate({ publicationReady: true, finalVerificationOk: true, workingTreeScopeOk: true }).ok, true);
  assert.equal(run.frozenResult ? run.frozenResult.resultId : null, 'r2', 'last frozen RESULT is the PUBLISH r2');
  assert.ok(!run.coordinator.state.results['r3'], 'no r3 RESULT produced for terminal DONE');
  fs.rmSync(dir, { recursive: true, force: true });
});
