import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GovernanceStore, GovernanceStoreError, GOVERNANCE_SCHEMA_VERSION, GOVERNANCE_STATE_KIND, makeGovernanceEnvelope, governanceNamespaceDir, encodeGovernanceComponent } from '../../src/governance/store.js';
import { runtimePaths } from '../../src/runtime-paths.js';

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

test('namespace filesystem containment fails closed for genuinely unsafe values', () => {
  const { dataRoot } = fixture();
  const bad = ['..', '.', 'CON', 'NUL', 'con', 'nul.txt', 'COM1', 'PRN', 'CON.foo', 'con.txt', 'trail.', 'trail ', '*', 'a*b'];
  for (const ns of bad) {
    assert.throws(() => new GovernanceStore({ dataRoot, namespace: ns }), (e) => e instanceof GovernanceStoreError && e.code === 'invalid_component', 'namespace ' + JSON.stringify(ns));
    assert.throws(() => governanceNamespaceDir(dataRoot, ns), (e) => e instanceof GovernanceStoreError && e.code === 'invalid_component', 'dir namespace ' + JSON.stringify(ns));
  }
});

test('separators/control/leading-space remain one safe encoded component with strict-child containment (historical mapping)', () => {
  const { dataRoot } = fixture();
  const root = path.join(runtimePaths(dataRoot).runtime, 'governance');
  for (const ns of ['a/b', 'a\\b', 'x\ty', '\u0000x', ' lead', 'a:b?c']) {
    const dir = governanceNamespaceDir(dataRoot, ns);
    const rel = path.relative(root, dir);
    assert.ok(rel && rel !== '.' && !path.isAbsolute(rel) && !rel.split(path.sep).includes('..'), 'namespace ' + JSON.stringify(ns) + ' escaped root');
    const historical = encodeURIComponent(ns).replace(/%20/g, ' ');
    assert.equal(dir, path.join(root, historical), 'historical byte-for-byte mapping preserved for ' + JSON.stringify(ns));
  }
});

test('valid namespaces resolve as strict children of the dedicated runtime/governance root', () => {
  const { dataRoot } = fixture();
  const root = path.join(runtimePaths(dataRoot).runtime, 'governance');
  for (const ns of ['default', 'other-ns', 'research.project', '\u7814\u7a76', 'a b']) {
    const dir = governanceNamespaceDir(dataRoot, ns);
    const rel = path.relative(root, dir);
    assert.ok(rel && rel !== '.' && !path.isAbsolute(rel) && !rel.split(path.sep).includes('..'), 'namespace ' + ns + ' escaped root');
    const encoded = encodeGovernanceComponent(ns, 'namespace');
    assert.equal(dir, path.join(root, encoded));
  }
});

test('task-id filesystem component safety: unsafe ids fail closed; historical-safe ids round-trip', () => {
  const { dataRoot, namespace } = fixture();
  const store = new GovernanceStore({ dataRoot, namespace });
  const badTaskIds = ['..', '.', 'CON', 'NUL', 'nul.txt', 'trail.', 'trail ', '*', 'task*a'];
  for (const id of badTaskIds) {
    assert.throws(() => store.saveTask(id, makeGovernanceEnvelope({ taskId: id, state: state(id) })), (e) => e instanceof GovernanceStoreError && e.code === 'invalid_component', 'taskId ' + JSON.stringify(id));
  }
  for (const id of ['t1', 'issue-23-brain-continuity-core', '\u4efb\u52a1-1', 'a/b', 'a\\b']) {
    store.saveTask(id, makeGovernanceEnvelope({ taskId: id, state: state(id), projectKey: 'p', identity: 'i' }));
    assert.equal(store.loadTask(id).taskId, id);
  }
});

test('compatibility: ordinary spaces keep the historical mapping and existing state loads (no remap/fresh state)', () => {
  const { dataRoot } = fixture();
  const store = new GovernanceStore({ dataRoot, namespace: 'research project' });
  store.saveTask('task one', makeGovernanceEnvelope({ taskId: 'task one', state: state('task one'), projectKey: 'p', identity: 'i' }));
  const dir = path.join(runtimePaths(dataRoot).runtime, 'governance', 'research project');
  assert.equal(store.dir, dir);
  assert.equal(fs.existsSync(path.join(dir, 'task one.json')), true);
  // A new store instance over the same dataRoot loads the existing state (not fresh).
  const store2 = new GovernanceStore({ dataRoot, namespace: 'research project' });
  assert.equal(store2.hasTask('task one'), true);
  assert.equal(store2.loadTask('task one').taskId, 'task one');
});
