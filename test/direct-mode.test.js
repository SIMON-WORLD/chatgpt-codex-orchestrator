import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DIRECT_CONFIG,
  DIRECT_MODE_REQUIRES,
  BRAIN_PROVIDERS,
  createChatGPTBrowserProvider,
  newDirectTaskState,
  evaluatePublishGate,
  isPublishForbiddenState,
} from '../src/direct-mode.js';
import { buildCompactResult, normalizeResult, parseBrainOutput } from '../src/protocol.js';

const skillPath = fileURLToPath(new URL('../skills/brain-command/SKILL.md', import.meta.url));

test('canonical SKILL.md describes Direct Brain Loop as the default', () => {
  assert.ok(fs.existsSync(skillPath), 'canonical skill file should exist');
  const md = fs.readFileSync(skillPath, 'utf8');
  assert.match(md, /Direct Brain Loop/i, 'skill must describe the Direct Brain Loop');
  assert.match(md, /current Codex agent/i, 'skill must say the current Codex agent is the executor');
  assert.match(md, /built-in browser/i, 'skill must use the built-in browser');
  assert.match(md, /Legacy \/ experimental runtime/i, 'skill must mark the detached runtime as legacy/experimental');
  // The default path must NOT be the worker/nested-Codex path.
  assert.doesNotMatch(md, /brain-command-worker\.mjs\s+--config/i, 'default path must not tell the agent to start the worker via --config');
});

test('default path does not require worker bootstrap / ready file / nested Codex / localhost / token / REPL long loop / process shim', () => {
  assert.equal(DIRECT_MODE_REQUIRES.workerBootstrap, false);
  assert.equal(DIRECT_MODE_REQUIRES.readyFile, false);
  assert.equal(DIRECT_MODE_REQUIRES.nestedCodex, false);
  assert.equal(DIRECT_MODE_REQUIRES.localhostTcp, false);
  assert.equal(DIRECT_MODE_REQUIRES.authTokenHandshake, false);
  assert.equal(DIRECT_MODE_REQUIRES.trustedReplLongLoop, false);
  assert.equal(DIRECT_MODE_REQUIRES.processShim, false);
});

test('ChatGPT is the default Brain provider and current Codex is the default executor', () => {
  assert.equal(DEFAULT_DIRECT_CONFIG.brainProvider, 'chatgpt');
  assert.equal(DEFAULT_DIRECT_CONFIG.executor, 'current-codex');
  assert.ok(BRAIN_PROVIDERS.includes('chatgpt'));
});

test('chatgpt browser provider implements the BrainProvider contract (open/send/identify/resume) without a worker', () => {
  const p = createChatGPTBrowserProvider();
  assert.equal(p.provider, 'chatgpt');
  assert.equal(typeof p.open, 'function');
  assert.equal(typeof p.send, 'function');
  assert.equal(typeof p.identifyConversation, 'function');
  assert.equal(typeof p.resume, 'function');
  assert.equal(p.identifyConversation(), null, 'no conversation before open');
});

test('RESULT packet stays compact structured protocol', () => {
  const r = buildCompactResult({
    stepId: 'step-1',
    status: 'success',
    summary: 'done',
    changed: ['a.txt'],
    evidence: [{ acceptanceId: 'acc-1', status: 'pass' }],
    blockers: [],
  });
  assert.deepEqual(Object.keys(r).sort(), ['blockers', 'changed', 'evidence', 'status', 'stepId', 'summary', 'type']);
  assert.equal(r.type, 'result');
  assert.equal(r.stepId, 'step-1');
  assert.equal(r.status, 'success');
  assert.equal(r.changed[0], 'a.txt');
  assert.equal(r.evidence[0].acceptanceId, 'acc-1');
  assert.equal(r.evidence[0].status, 'pass');
  // normalizeResult round-trips the compact shape.
  const n = normalizeResult(r);
  assert.equal(n.type, 'result');
  assert.equal(n.stepId, 'step-1');
});

test('DONE publish gate retained: only DONE + completed + verified + clean worktree publishes', () => {
  assert.equal(evaluatePublishGate({ brainControl: 'DONE', taskStatus: 'completed', mandatoryVerificationOk: true, workingTreeScopeOk: true }).ok, true);
  assert.equal(evaluatePublishGate({ brainControl: 'REVISE', taskStatus: 'completed', mandatoryVerificationOk: true, workingTreeScopeOk: true }).ok, false, 'REVISE must not publish');
  assert.equal(evaluatePublishGate({ brainControl: 'DONE', taskStatus: 'recovery_required', mandatoryVerificationOk: true, workingTreeScopeOk: true }).ok, false, 'recovery_required task must not publish');
  assert.equal(evaluatePublishGate({ brainControl: 'DONE', taskStatus: 'completed', mandatoryVerificationOk: false, workingTreeScopeOk: true }).ok, false, 'failed verification must not publish');
  assert.equal(evaluatePublishGate({ brainControl: 'DONE', taskStatus: 'completed', mandatoryVerificationOk: true, workingTreeScopeOk: false }).ok, false, 'unclean worktree must not publish');
  // Known forbidden states.
  for (const s of ['REVISE', 'ASK_USER', 'failure', 'recovery_required']) {
    assert.equal(isPublishForbiddenState(s), true, `${s} is a non-publish state`);
  }
  assert.equal(isPublishForbiddenState('DONE'), false);
});

test('minimal Direct Task State shape', () => {
  const st = newDirectTaskState({ taskId: 't1', repoDir: '/repo' });
  assert.equal(st.taskId, 't1');
  assert.equal(st.repoDir, '/repo');
  assert.equal(st.brainProvider, 'chatgpt');
  assert.equal(st.executor, 'current-codex');
  assert.equal(st.completedSteps.length, 0);
  assert.equal(st.evidenceLedger.length, 0);
  assert.equal(st.publishPolicy, 'auto');
  assert.ok(st.startedAt);
});

test('parseBrainOutput recognizes structured and legacy controls (compact protocol)', () => {
  assert.equal(parseBrainOutput('DONE').control.control, 'DONE');
  assert.equal(parseBrainOutput('{"control":"TASK","stepId":"s1","instruction":"do x"}').control.control, 'TASK');
  assert.throws(() => parseBrainOutput('no control here'), /no recognizable control|invalid control/i);
});