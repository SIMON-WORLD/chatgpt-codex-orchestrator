import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GovernanceStore, GovernanceStoreError, GOVERNANCE_SCHEMA_VERSION, GOVERNANCE_STATE_KIND, makeGovernanceEnvelope } from '../../src/governance/store.js';

function fixture(prefix = 'gstore-') {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dataRoot, namespace: 'ns-' + path.basename(dataRoot) };
}

function state(taskId) {
  return { taskId, control: 'TASK', currentStepId: 's1', steps: { s1: { stepId: 's1', executorStatus: 'success', machineGate: 'pass' } } };
}

test('saveTask/loadTask round-trips the full envelope', () => {
  const { dataRoot, namespace } = fixture();
  const store = new GovernanceStore({ dataRoot, namespace });
  const s = state('t1');
  store.saveTask('t1', makeGovernanceEnvelope({ taskId: 't1', state: s, projectKey: 'simon-world/repo', identity: 'issue-1', authority: { generation: 0, token: 'tok1' } }));
  const env = store.loadTask('t1');
  assert.equal(env.schemaVersion, GOVERNANCE_SCHEMA_VERSION);
  assert.equal(env.kind, GOVERNANCE_STATE_KIND);
  assert.equal(env.taskId, 't1');
  assert.equal(env.projectKey, 'simon-world/repo');
  assert.equal(env.identity, 'issue-1');
  assert.equal(env.authority.generation, 0);
  assert.equal(env.authority.token, 'tok1');
  assert.equal(env.state.control, 'TASK');
  assert.equal(env.state.steps.s1.executorStatus, 'success');
  assert.equal(store.hasTask('t1'), true);
  assert.equal(store.hasTask('missing'), false);
});

test('primary corruption with valid backup recovers the backup', () => {
  const { dataRoot, namespace } = fixture();
  const store = new GovernanceStore({ dataRoot, namespace });
  const s = state('t1');
  store.saveTask('t1', makeGovernanceEnvelope({ taskId: 't1', state: s, projectKey: 'p', identity: 'i' }));
  const file = path.join(store.dir, 't1.json');
  fs.writeFileSync(file, '{ this is not json !!!', 'utf8'); // corrupt primary; .bak intact
  const env = store.loadTask('t1');
  assert.equal(env.taskId, 't1');
  assert.equal(env.state.control, 'TASK');
  assert.equal(env.projectKey, 'p');
  assert.equal(env.identity, 'i');
});

test('primary + backup corruption fails closed with a named error', () => {
  const { dataRoot, namespace } = fixture();
  const store = new GovernanceStore({ dataRoot, namespace });
  store.saveTask('t1', makeGovernanceEnvelope({ taskId: 't1', state: state('t1') }));
  const file = path.join(store.dir, 't1.json');
  fs.writeFileSync(file, '{broken', 'utf8');
  fs.writeFileSync(file + '.bak', 'also broken', 'utf8');
  assert.throws(() => store.loadTask('t1'), (e) => {
    assert.ok(e instanceof GovernanceStoreError);
    assert.equal(e.code, 'corrupt');
    assert.match(e.message, /primary and backup/);
    return true;
  });
});

test('unknown/future schema fails closed (never silent fresh state)', () => {
  const { dataRoot, namespace } = fixture();
  const store = new GovernanceStore({ dataRoot, namespace });
  const file = path.join(store.dir, 'future.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: GOVERNANCE_SCHEMA_VERSION + 5, kind: GOVERNANCE_STATE_KIND, taskId: 'future', state: state('future') }), 'utf8');
  assert.throws(() => store.loadTask('future'), (e) => {
    assert.ok(e instanceof GovernanceStoreError);
    assert.equal(e.code, 'schema_unsupported');
    assert.match(e.message, /newer than supported/);
    return true;
  });
});

test('explicit tested migration: schema version 0 hydrates deterministically', () => {
  const { dataRoot, namespace } = fixture();
  const store = new GovernanceStore({ dataRoot, namespace });
  // Simulated pre-continuity snapshot: no envelope kind/authority, schemaVersion 0.
  const legacy = { schemaVersion: 0, taskId: 'legacy', state: { taskId: 'legacy', control: 'TASK', currentStepId: 's1', steps: {} } };
  fs.writeFileSync(path.join(store.dir, 'legacy.json'), JSON.stringify(legacy), 'utf8');
  const env = store.loadTask('legacy');
  assert.equal(env.schemaVersion, GOVERNANCE_SCHEMA_VERSION);
  assert.equal(env.kind, GOVERNANCE_STATE_KIND);
  assert.equal(env.taskId, 'legacy');
  assert.equal(env.projectKey, null);
  assert.equal(env.identity, null);
  assert.equal(env.authority, null); // pre-authority snapshot: takeover mints later
  assert.equal(env.state.control, 'TASK');
});

test('scanStrict returns task envelopes, excludes writer.json, and counts corruption', () => {
  const { dataRoot, namespace } = fixture();
  const store = new GovernanceStore({ dataRoot, namespace });
  store.saveTask('a', makeGovernanceEnvelope({ taskId: 'a', state: state('a') }));
  store.saveTask('b', makeGovernanceEnvelope({ taskId: 'b', state: state('b') }));
  fs.writeFileSync(path.join(store.dir, 'writer.json'), JSON.stringify({ writerId: 'w1' }), 'utf8');
  fs.writeFileSync(path.join(store.dir, 'zzz.json'), 'corrupt', 'utf8');
  const { tasks, corruptCount } = store.scanStrict();
  assert.equal(corruptCount, 1);
  assert.deepEqual(tasks.map((t) => t.taskId).sort(), ['a', 'b']);
});


test('scanStrict resolves a candidate with corrupt primary + valid backup (same semantics as loadTask)', () => {
  const { dataRoot, namespace } = fixture();
  const store = new GovernanceStore({ dataRoot, namespace });
  store.saveTask('t1', makeGovernanceEnvelope({ taskId: 't1', state: state('t1'), projectKey: 'p', identity: 'i' }));
  fs.writeFileSync(path.join(store.dir, 't1.json'), '{{corrupt primary', 'utf8'); // .bak remains valid
  const { tasks, corruptCount } = store.scanStrict();
  assert.equal(corruptCount, 0);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].taskId, 't1');
  assert.equal(tasks[0].state.control, 'TASK');
  assert.equal(store.loadTask('t1').taskId, 't1'); // loadTask agrees
});

test('scanStrict includes a backup-only candidate when the primary is missing', () => {
  const { dataRoot, namespace } = fixture();
  const store = new GovernanceStore({ dataRoot, namespace });
  store.saveTask('t1', makeGovernanceEnvelope({ taskId: 't1', state: state('t1'), projectKey: 'p', identity: 'i' }));
  fs.rmSync(path.join(store.dir, 't1.json')); // primary lost; only .bak remains
  const { tasks, corruptCount } = store.scanStrict();
  assert.equal(corruptCount, 0);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].taskId, 't1');
  assert.equal(store.loadTask('t1').taskId, 't1');
});

test('scanStrict still fails closed for primary+backup corruption and future schema', () => {
  const { dataRoot, namespace } = fixture();
  const store = new GovernanceStore({ dataRoot, namespace });
  store.saveTask('a', makeGovernanceEnvelope({ taskId: 'a', state: state('a') }));
  store.saveTask('b', makeGovernanceEnvelope({ taskId: 'b', state: state('b') }));
  fs.writeFileSync(path.join(store.dir, 'a.json'), 'broken', 'utf8');
  fs.writeFileSync(path.join(store.dir, 'a.json.bak'), 'broken too', 'utf8');
  fs.writeFileSync(path.join(store.dir, 'c.json'), JSON.stringify({ schemaVersion: GOVERNANCE_SCHEMA_VERSION + 9, kind: GOVERNANCE_STATE_KIND, taskId: 'c', state: state('c') }), 'utf8');
  const { tasks, corruptCount } = store.scanStrict();
  assert.equal(corruptCount, 2); // a (primary+backup) and c (future schema)
  assert.deepEqual(tasks.map((t) => t.taskId), ['b']);
});
