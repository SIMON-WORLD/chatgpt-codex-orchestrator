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
// send, records the outbound message + nonce, and returns a stable conversation id.
function makeFakeBrain(replies) {
  let i = 0;
  return {
    sent: [],
    async send(message, { nonce } = {}) {
      this.sent.push({ message, nonce });
      const reply = (replies && i < replies.length) ? replies[i] : 'ack';
      i += 1;
      return { reply, conversationId: 'conv-1', conversationUrl: 'https://chatgpt.com/c/conv-1', ownedTabId: 't1' };
    },
    async resume() {
      return { conversationId: 'conv-1', conversationUrl: 'https://chatgpt.com/c/conv-1', ownedTabId: 't1' };
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
