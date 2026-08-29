import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDirectAcceptanceGate, createProofLedger, planVerification, verifyTierPrecondition, buildBootstrapEvidence, createDirectMetrics, attemptLateReplyRecovery } from '../src/direct-governance.js';
import { createPublicationTransaction, publicationReadyForDone, buildExternalEvidence, parseRemoteRef } from '../src/publication-transaction.js';
import { CONTROLS, isTerminalControl, validateLifecycleAfterDone, parseBrainOutput } from '../src/protocol.js';
import { createChatGPTBrowserProvider, DEFAULT_DIRECT_CONFIG, DIRECT_MODE_REQUIRES } from '../src/direct-mode.js';
import { createTabFacade } from '../src/iab-transport.js';

test('missing acceptance evidence blocks completion', () => {
  const gate = evaluateDirectAcceptanceGate({ acceptance: ['U1', 'U2'], evidence: [{ acceptanceId: 'U1', status: 'pass' }] });
  assert.equal(gate.ok, false);
  assert.ok(gate.missing.includes('U2'));
  assert.equal(gate.missing.includes('U1'), false);
});

test('natural-language "all pass" does not bypass the gate', () => {
  // summary says all passed, but evidence lacks U13 => gate fails.
  const gate = evaluateDirectAcceptanceGate({
    acceptance: ['U1', 'U2', 'U13'],
    evidence: [
      { acceptanceId: 'U1', status: 'pass', summary: 'ok' },
      { acceptanceId: 'U2', status: 'pass', summary: 'ok' },
    ],
  });
  assert.equal(gate.ok, false);
  assert.ok(gate.missing.includes('U13'), 'missing evidence is not pass');
});

test('all required acceptance evidence passes', () => {
  const gate = evaluateDirectAcceptanceGate({
    acceptance: ['U1', 'U2', 'U3'],
    evidence: [
      { acceptanceId: 'U1', status: 'pass' },
      { acceptanceId: 'U2', status: 'pass' },
      { acceptanceId: 'U3', status: 'pass' },
    ],
  });
  assert.equal(gate.ok, true);
  assert.deepEqual(gate.failed, []);
  assert.deepEqual(gate.missing, []);
});

test('evidence status unknown/failed is not pass', () => {
  const gate = evaluateDirectAcceptanceGate({
    acceptance: ['U1'],
    evidence: [{ acceptanceId: 'U1', status: 'unknown' }],
  });
  assert.equal(gate.ok, false);
  assert.ok(gate.failed.includes('U1'));
});

test('proof reuse when dependencies unchanged', () => {
  let fp = (f) => 'hash-' + f;
  const ledger = createProofLedger({ computeFingerprint: fp });
  ledger.record({ acceptanceId: 'M1', relevantFiles: ['a.txt'], status: 'pass' });
  assert.equal(ledger.isReusable('M1'), true);
  const plan = planVerification({ tier: 'milestone', requiredAcceptanceIds: ['M1'], proofLedger: ledger });
  assert.deepEqual(plan.reuse, ['M1']);
  assert.deepEqual(plan.needVerification, []);
});

test('proof invalidation when dependency changes', () => {
  let fileVersion = 'v1';
  const compute = (f) => 'hash-' + fileVersion;
  const ledger = createProofLedger({ computeFingerprint: compute });
  ledger.record({ acceptanceId: 'M1', relevantFiles: ['a.txt'], status: 'pass' });
  assert.equal(ledger.isReusable('M1'), true);
  fileVersion = 'v2'; // dependency byte content changed => stale
  assert.equal(ledger.isReusable('M1'), false);
  ledger.invalidateOnChange(['a.txt']);
  assert.equal(ledger.isReusable('M1'), false);
});

test('milestone does not blindly rerun a reusable proof', () => {
  const ledger = createProofLedger({ computeFingerprint: (f) => 'h-' + f });
  ledger.record({ acceptanceId: 'M1', relevantFiles: ['a.txt'], status: 'pass' });
  const plan = planVerification({ tier: 'milestone', requiredAcceptanceIds: ['M1', 'M2'], proofLedger: ledger });
  assert.deepEqual(plan.reuse, ['M1']);
  assert.deepEqual(plan.needVerification, ['M2']);
});

test('verification tier precondition: final requires fresh proofs, milestone requires gate pass', () => {
  const ledger = createProofLedger({ computeFingerprint: (f) => 'h-' + f });
  ledger.record({ acceptanceId: 'F1', relevantFiles: ['a.txt'], status: 'pass' });
  // milestone gate fails because F2 has no evidence
  const gate = evaluateDirectAcceptanceGate({ acceptance: ['F1', 'F2'], evidence: [{ acceptanceId: 'F1', status: 'pass' }] });
  assert.equal(verifyTierPrecondition({ tier: 'milestone', gate, proofLedger: ledger }).ok, false);
  // final with a fresh required proof passes
  const gate2 = evaluateDirectAcceptanceGate({ acceptance: ['F1'], evidence: [{ acceptanceId: 'F1', status: 'pass' }] });
  assert.equal(verifyTierPrecondition({ tier: 'final', gate: gate2, proofLedger: ledger }).ok, true);
  // final with a stale required proof does NOT pass
  const ledger2 = createProofLedger({ computeFingerprint: (f) => 'h-' + f });
  ledger2.record({ acceptanceId: 'F1', relevantFiles: ['a.txt'], status: 'pass' });
  ledger2.invalidateOnChange(['a.txt']);
  assert.equal(verifyTierPrecondition({ tier: 'final', gate: gate2, proofLedger: ledger2 }).ok, false);
});

test('PUBLISH is non-terminal; DONE is terminal; DONE -> REVISE rejected', () => {
  assert.ok(CONTROLS.includes('PUBLISH'));
  assert.equal(isTerminalControl('PUBLISH'), false);
  assert.equal(isTerminalControl('DONE'), true);
  assert.equal(validateLifecycleAfterDone('REVISE').ok, false);
  assert.equal(validateLifecycleAfterDone('TASK').ok, false);
  assert.equal(validateLifecycleAfterDone('REPLAN').ok, false);
  assert.equal(validateLifecycleAfterDone('PUBLISH').ok, false);
  assert.equal(validateLifecycleAfterDone('DONE').ok, true);
  assert.equal(parseBrainOutput('{"control":"PUBLISH","stepId":"pub-1"}').control.control, 'PUBLISH');
});

test('publication remote race blocks push', async () => {
  const effective = { remote: 'base-sha', lsCalls: 0 };
  const gitRun = async (args) => {
    if (args[0] === 'ls-remote') {
      effective.lsCalls++;
      if (effective.lsCalls >= 2) effective.remote = 'moved-sha';
      return effective.remote + '\trefs/heads/main';
    }
    if (args[0] === 'config') return args.length === 3 ? '' : (args[2] === 'user.name' ? 'SIMON-WORLD' : 'noreply');
    if (args[0] === 'fetch' || args[0] === 'add' || args[0] === 'push') return '';
    if (args[0] === 'rev-parse') return 'head-sha';
    if (args[0] === 'merge-base') return '';
    return '';
  };
  const tx = createPublicationTransaction({ gitRun });
  const res = await tx.run({ repoDir: '/x', expectedOriginMain: 'base-sha', commitMessage: 'm', acceptanceGateOk: true });
  assert.equal(res.ok, false);
  assert.equal(res.step, 'race');
  assert.equal(res.reason, 'origin/main moved (race); STOP/REPLAN');
});

test('external readback required before DONE', async () => {
  const okGitRun = async (args) => {
    if (args[0] === 'ls-remote') return 'base-sha\trefs/heads/main';
    if (args[0] === 'config') return args.length === 3 ? '' : (args[2] === 'user.name' ? 'SIMON-WORLD' : 'noreply');
    if (args[0] === 'rev-parse') return 'head-sha';
    if (args[0] === 'merge-base') return '';
    return '';
  };
  // no readback provider => not ready for DONE
  const tx1 = createPublicationTransaction({ gitRun: okGitRun });
  const r1 = await tx1.run({ repoDir: '/x', expectedOriginMain: 'base-sha', commitMessage: 'm', tag: 'v1', acceptanceGateOk: true });
  assert.equal(publicationReadyForDone(r1), false);

  // with fresh external readback => ready for DONE
  const tx2 = createPublicationTransaction({ gitRun: okGitRun, readback: () => buildExternalEvidence({ remoteMainSha: 'head-sha', tagSha: 'head-sha', release: { exists: true, draft: false, prerelease: false, title: 't', body: 'b' } }) });
  const r2 = await tx2.run({ repoDir: '/x', expectedOriginMain: 'base-sha', commitMessage: 'm', tag: 'v1', acceptanceGateOk: true });
  assert.equal(publicationReadyForDone(r2), true);
  assert.equal(r2.external.release.exists, true);
});

test('acceptance gate not passed stops the publication transaction', async () => {
  const tx = createPublicationTransaction({ gitRun: async () => '' });
  const res = await tx.run({ repoDir: '/x', expectedOriginMain: 'base-sha', commitMessage: 'm', acceptanceGateOk: false });
  assert.equal(res.ok, false);
  assert.equal(res.step, 'gate');
});

test('branch bootstrap evidence is included', () => {
  const gitRun = (args) => {
    if (args.includes('--abbrev-ref')) return 'main';
    if (args[0] === 'rev-parse') return 'abc1234';
    if (args[0] === 'status') return ' M README.md';
    if (args[0] === 'rev-list') return '0\t1';
    return '';
  };
  const ev = buildBootstrapEvidence({ repoDir: '/x', gitRun });
  assert.equal(ev.repoDir, '/x');
  assert.equal(ev.currentBranch, 'main');
  assert.equal(ev.HEAD, 'abc1234');
  assert.equal(ev.gitStatusSummary, ' M README.md');
  assert.equal(ev.originMainDivergence, '0\t1');
});

test('late reply recovered with no resend', async () => {
  const calls = { read: 0 };
  const reply = await attemptLateReplyRecovery({
    readReply: async () => { calls.read++; return 'late reply'; },
    getCount: async () => 1,
    beforeCount: 0, beforeLast: '', maxSlices: 2, sliceMs: 1,
  });
  assert.equal(reply, 'late reply');
  assert.equal(calls.read, 1, 'only reads, never resends');
});

test('direct metrics snapshot exposes the tracked fields', () => {
  const m = createDirectMetrics();
  m.bump('taskCount', 3);
  m.bump('replyTimeoutCount');
  m.set('timeToFirstBrainControl', 1200);
  const snap = m.snapshot();
  assert.equal(snap.taskCount, 3);
  assert.equal(snap.replyTimeoutCount, 1);
  assert.equal(snap.timeToFirstBrainControl, 1200);
  assert.ok(snap.duration >= 0);
  assert.ok('reusedProofCount' in snap && 'verificationRuns' in snap);
});

test('Alpha.3 guarantees unchanged: existing-conversation / IAB / composer', async () => {
  assert.equal(DEFAULT_DIRECT_CONFIG.brainProvider, 'chatgpt');
  assert.equal(DEFAULT_DIRECT_CONFIG.executor, 'current-codex');
  assert.equal(DIRECT_MODE_REQUIRES.nestedCodex, false);
  assert.equal(DIRECT_MODE_REQUIRES.workerBootstrap, false);
  assert.equal(DIRECT_MODE_REQUIRES.localhostTcp, false);
  const p = createChatGPTBrowserProvider({ transport: { connect: async () => {}, browser: { tabs: { new: async () => ({ id: 't', playwright: {} }) } } } });
  assert.equal(typeof p.adoptConversation, 'function');
  assert.equal(typeof p.adoptCurrent, 'function');
  // composer resolve uses the structural #prompt-textarea, never a bare first.
  const facade = createTabFacade({ id: 't', playwright: { locator: (s) => ({ count: async () => s === '#prompt-textarea' ? 1 : 0, evaluate: async () => false, fill: async () => {}, press: async () => {}, innerText: async () => '' }), waitForTimeout: async () => {} } });
  assert.equal(await facade.isComposerReady(), true);
});
