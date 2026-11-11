import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AppServerExecutor } from '../../src/executor/app-server-executor.js';
import { createDurableGovernanceService, GovernanceStore } from '../../src/governance/durable.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { DeviceRelayAgent } from '../../src/relay/agent.js';
import { LocalMcpToolExecutor } from '../../src/relay/runtime-mode.js';
import { createRelayCodexAdmission, ADMITTED_CODEX_METHOD } from '../../src/relay/codex-admission.js';

class MockAppServer {
  _connected = true;
  isRunning = true;
  child = {};
  turns = 0;
  threads = 0;
  settingsBarrier = null;
  changeSettings = (settings) => settings;
  onNotification(fn) { this.notify = fn; }
  onServerRequest() {}
  onExit() {}
  async request(method, p) {
    if (method === 'thread/start') return { thread: { id: 'thread-' + ++this.threads } };
    if (method === 'thread/settings/update') {
      await this.settingsBarrier?.();
      this.notify({ method: 'thread/settings/updated', params: { threadId: p.threadId, threadSettings: this.changeSettings(p) } });
      return {};
    }
    if (method === 'turn/start') return { turn: { id: 'turn-' + ++this.turns } };
    throw new Error('Unexpected mock method: ' + method);
  }
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-permit-source-'));
  const root = fs.realpathSync.native(path.join(dir, '.'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-b', 'fixture');
  git('remote', 'add', 'origin', 'https://github.com/example/repo.git');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
  const dataRoot = path.join(dir, 'isolated-data');
  // Windows directory flush support is not asserted by this fixture. Linux CI
  // exercises the real directory and file flushes; failure is injected below.
  const options = process.platform === 'win32' ? { syncDirectory() {} } : {};
  const store = new GovernanceStore({ dataRoot, ...options });
  let clock = 0;
  const open = () => createDurableGovernanceService({ dataRoot, store, admissionNow: () => clock });
  let governance = open();
  t.after(() => governance.close());
  const taskId = 'task-235', governanceStep = 'governance-step';
  const { authorityToken } = governance.transition({ taskId, projectKey: 'example/repo', workspaceRoot: root, control: 'PLAN' });
  const transition = (control = 'TASK', route = 'CODEX_DELEGATE') => governance.transition({
    taskId, workspaceRoot: root, authorityToken, stepId: governanceStep, control, route, acceptance: [{ id: 'evidence' }],
  });
  transition();
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const { workspaceId } = registry.open({ path: root });
  const alias = registry.open({ path: root }).workspaceId;
  const client = new MockAppServer();
  const executor = new AppServerExecutor({ dataRoot, client });
  let issuer;
  const parent = Object.freeze({});
  const privateParentTransport = { authenticate: (caller) => caller === parent, register: (value) => { issuer = value; } };
  const transport = { connect() {}, poll() {}, respond() {} };
  let agent;
  const wire = (enablePrivate = true) => {
    const execute = createRelayCodexAdmission({ governance, registry, executor,
      currentContext: () => agent.admissionContext(), privateParentTransport: enablePrivate ? privateParentTransport : null });
    agent = new DeviceRelayAgent({ deviceId: 'exact-device', runtimeId: 'exact-runtime',
      credential: 'fixture-pairing-a', readyzUrl: 'http://localhost/readyz', transport, execute });
    agent.connectionEpoch = 1;
  };
  wire();
  const start = { workspaceId, taskId, identity: 'semantic-task-1', prompt: 'bounded operation', accessMode: 'workspace_write', networkAccess: false };
  const issue = (operation = start, overrides = {}, caller = parent) => issuer.issue(caller, {
    authorityToken, governanceStep, name: 'codex_start', operation, ...overrides,
  }).admission;
  const send = (admission, operation = start, name = 'codex_start', envelope = {}) => agent.handleEnvelope({
    requestId: randomUUID(), deviceId: agent.deviceId, runtimeId: agent.runtimeId, connectionEpoch: agent.connectionEpoch,
    deadline: Date.now() + 30000, payload: { method: ADMITTED_CODEX_METHOD, params: { name, arguments: { ...operation, admission } } }, ...envelope,
  });
  return { root, git, store, registry, client, executor, authorityToken, taskId, start, alias, issue, send, transition,
    revoke: (admission) => issuer.revoke(parent, { taskId, workspaceId, authorityToken, admission }),
    advanceClock(ms) { clock += ms; },
    get agent() { return agent; },
    get governance() { return governance; },
    restart() { governance.close(); governance = open(); governance.loadTask(taskId); wire(); },
    wire,
  };
}

test('private issuance requires a verified caller, current Parent, runnable Codex step and exact repository', (t) => {
  const h = fixture(t);
  assert.throws(() => h.issue(h.start, {}, { trusted: true }), /admission denied/);
  assert.throws(() => h.issue(h.start, { authorityToken: 'execution-claim-not-parent' }), /stale_authority/);
  assert.throws(() => h.issue(h.start, { governanceStep: 'wrong-step' }), /not authorized/);
  assert.throws(() => h.issue({ ...h.start, taskId: 'wrong-task' }), /task_mismatch/);
  h.git('remote', 'set-url', 'origin', 'https://github.com/example/other.git');
  assert.throws(() => h.issue(), /not authorized/);
  h.git('remote', 'set-url', 'origin', 'https://github.com/example/repo.git');
  h.transition('REVISE', 'CHATGPT_DIRECT_LOCAL');
  assert.throws(() => h.issue(), /not authorized/);
  assert.equal(h.client.turns, 0);
  assert.equal(h.client.threads, 0);
});

test('one exact start, then one completed-job continuation; no bearer in persisted state or response', async (t) => {
  const h = fixture(t);
  const admission = h.issue();
  const started = await h.send(admission);
  assert.equal(started.ok, true, JSON.stringify(started.error));
  assert.equal(h.client.turns, 1);
  const job = JSON.parse(started.value.content[0].text);
  assert.equal(job.effectiveVerified, true);
  assert.equal(JSON.stringify(started).includes(admission), false);
  assert.equal(JSON.stringify(h.store.loadTask(h.taskId).relayCodex).includes(admission), false);
  h.client.notify({ method: 'turn/completed', params: { threadId: job.threadId, turn: { id: job.turnId, status: 'completed' } } });
  const op = { workspaceId: h.start.workspaceId, taskId: h.taskId, jobId: job.jobId, stepId: 'semantic-continue-1', instruction: 'finish bounded work' };
  const continuation = h.issue(op, { name: 'codex_continue' });
  const continued = await h.send(continuation, op, 'codex_continue');
  assert.equal(continued.ok, true, JSON.stringify(continued.error));
  assert.equal(h.client.turns, 2);
  assert.equal((await h.send(continuation, { ...op, workspaceId: h.alias }, 'codex_continue')).ok, false);
  assert.equal(h.client.turns, 2);
  h.client.notify({ method: 'turn/completed', params: { threadId: job.threadId, turn: { id: 'turn-2', status: 'completed' } } });
  assert.throws(() => h.issue(op, { name: 'codex_continue' }), /already admitted/);
});

test('changed payload, access, network, identity, task, workspace or credential fields cannot consume the grant', async (t) => {
  const h = fixture(t);
  const admission = h.issue();
  for (const change of [
    { prompt: 'different operation' }, { accessMode: 'read_only' }, { networkAccess: true },
    { identity: 'different identity' }, { taskId: 'another task' }, { workspaceId: 'forged-workspace' },
    { authorityToken: h.authorityToken }, { trusted: true }, { deviceId: 'caller supplied' },
  ]) {
    assert.equal((await h.send(admission, { ...h.start, ...change })).ok, false);
  }
  assert.equal(h.client.threads, 0);
  assert.equal(h.client.turns, 0);
  assert.equal((await h.send(admission)).ok, true);
});

test('same operation does not replay after ACK loss, worktree branch change, runtime restart or a new grant', async (t) => {
  const h = fixture(t);
  const admission = h.issue({ ...h.start, accessMode: 'read_only' });
  const op = { ...h.start, accessMode: 'read_only' };
  assert.equal((await h.send(admission, op)).ok, true);
  // Ignore the first response; the replay comes directly through a new delivery,
  // with no Relay SQLite state available to protect the device.
  assert.equal((await h.send(admission, { ...op, workspaceId: h.alias })).ok, false);
  h.git('checkout', '-b', 'alternate-branch');
  assert.throws(() => h.issue(op), /already admitted/);
  h.restart();
  assert.equal((await h.send(admission, op)).ok, false);
  assert.throws(() => h.issue(op), /already admitted/);
  assert.equal(h.client.turns, 1);
});

test('concurrent delivery of a one-use admission reserves before asynchronous effects', async (t) => {
  const h = fixture(t);
  let entered, resume;
  const waiting = new Promise((resolve) => { entered = resolve; });
  h.client.settingsBarrier = () => new Promise((resolve) => { resume = resolve; entered(); });
  const admission = h.issue();
  const first = h.send(admission);
  await waiting;
  assert.equal((await h.send(admission)).ok, false);
  assert.throws(() => h.issue({ ...h.start, identity: 'different' }), /reconciliation/);
  resume();
  assert.equal((await first).ok, true);
  assert.equal(h.client.turns, 1);
});

for (const [label, change] of [
  ['REVISE without a claim', (h) => h.transition('REVISE')],
  ['RESULT without a claim', (h) => h.governance.recordResult({ taskId: h.taskId, stepId: 'governance-step',
    executorStatus: 'success', authorityToken: h.authorityToken, evidence: [{ id: 'evidence', status: 'pass' }] })],
  ['takeover', (h) => h.governance.takeover({ taskId: h.taskId, workspaceRoot: h.root })],
  ['connection epoch', (h) => { h.agent.connectionEpoch++; }],
  ['runtime', (h) => { h.agent.runtimeId = 'replaced-runtime'; }],
  ['pairing', (h) => { h.agent.credential = 'fixture-new-pairing'; }],
  ['worktree branch', (h) => h.git('checkout', '-b', 'switched')],
  ['App Server child replacement', (h) => { h.client.child = {}; }],
]) {
  test(label + ' during permission preparation prevents any turn', async (t) => {
    const h = fixture(t);
    const admission = h.issue();
    h.client.settingsBarrier = () => change(h);
    const out = await h.send(admission);
    assert.equal(out.ok, false, JSON.stringify(out));
    assert.equal(h.client.turns, 0);
    assert.equal(h.client.threads, 1);
    assert.equal(h.executor.jobMap.list()[0].state, 'recovery_required');
  });
}

test('explicit revoke, restart barrier and transport absence refuse unused permits', async (t) => {
  const h = fixture(t);
  const first = h.issue();
  h.revoke(first);
  assert.equal((await h.send(first)).ok, false);
  const second = h.issue();
  const revision = h.store.loadTask(h.taskId).authorizationRevision;
  h.restart();
  assert.equal((await h.send(second)).ok, false);
  const third = h.issue();
  assert.ok(h.store.loadTask(h.taskId).authorizationRevision >= revision + 2);
  h.wire(false);
  assert.equal((await h.send(third)).ok, false);
  assert.equal(h.client.turns, 0);
});

test('permission mismatch is still a hard stop despite a valid admission', async (t) => {
  const h = fixture(t);
  h.client.changeSettings = (settings) => ({ ...settings, sandboxPolicy: { type: 'readOnly' } });
  assert.equal((await h.send(h.issue())).ok, false);
  assert.equal(h.client.turns, 0);
});

test('failure after primary replacement poisons admission despite successful ordinary reload', async (t) => {
  const h = fixture(t);
  const permit = h.issue();
  const sync = h.store.syncDirectory;
  let attempts = 0;
  h.store.syncDirectory = (dir) => {
    if (++attempts === 2) throw new Error('fixture failure after primary replacement');
    sync(dir);
  };
  assert.equal((await h.send(permit)).ok, false);
  h.store.syncDirectory = sync;
  assert.equal(h.governance.loadTask(h.taskId).ok, true);
  assert.equal((await h.send(permit)).ok, false);
  assert.throws(() => h.issue(), /admission storage/);
  h.restart();
  assert.throws(() => h.issue(), /admission storage/);
  assert.equal(h.client.threads, 0);
  assert.equal(h.client.turns, 0);
});

test('older backup cannot restore authority or mint a new permit after primary loss', async (t) => {
  const h = fixture(t);
  const permit = h.issue();
  const file = path.join(h.store.dir, h.taskId + '.json');
  fs.writeFileSync(file, 'broken primary', 'utf8');
  h.restart();
  assert.equal((await h.send(permit)).ok, false);
  assert.throws(() => h.issue(), /admission storage/);
  assert.equal(h.client.turns, 0);
});

test('old tools/call adapter never treats a private admission as a legacy Codex or Governance request', async () => {
  let calls = 0;
  const executor = new LocalMcpToolExecutor({ mcpUrl: 'http://localhost/mcp', clientFactory: () => {
    calls++;
    throw new Error('should not connect');
  } });
  await assert.rejects(executor.execute({ method: ADMITTED_CODEX_METHOD, params: { name: 'codex_start' } }), /internal tools\/call/);
  for (const name of ['codex_start','codex_continue','governance_relay_codex_admission','governance_takeover']) {
    await assert.rejects(executor.execute({ method: 'tools/call', params: { name } }), /cannot forward/);
  }
  assert.equal(calls, 0);
});

// These fixtures exercise the local authority boundary only, not a live control channel.
test('expired and pre-bootstrap child-replaced admissions dispatch zero turns', async (t) => {
  const h = fixture(t);
  const first = h.issue();
  h.advanceClock(300_001);
  assert.equal((await h.send(first)).ok, false);
  const second = h.issue();
  h.client.child = {};
  assert.equal((await h.send(second)).ok, false);
  assert.equal(h.client.threads, 0);
  assert.equal(h.client.turns, 0);
});

test('a new writer cannot admit from a v2 snapshot missing its revision', async (t) => {
  const h = fixture(t);
  const permit = h.issue();
  const file = path.join(h.store.dir, h.taskId + '.json');
  const malformed = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete malformed.authorizationRevision;
  fs.writeFileSync(file, JSON.stringify(malformed));
  h.restart();
  assert.equal((await h.send(permit)).ok, false);
  assert.throws(() => h.issue(), /admission storage/);
  assert.equal(h.client.turns, 0);
});

test('a matching legacy v1 task migrates before its first grant without resetting Parent authority', (t) => {
  const h = fixture(t);
  const file = path.join(h.store.dir, h.taskId + '.json');
  const legacy = { ...h.store.loadTask(h.taskId), schemaVersion: 1 };
  delete legacy.authorizationRevision;
  delete legacy.relayCodex;
  for (const p of [file, file + '.bak']) fs.writeFileSync(p, JSON.stringify(legacy));
  h.restart();
  const admission = h.issue();
  assert.equal(admission.length, 43);
  const env = h.store.loadTask(h.taskId);
  assert.equal(env.schemaVersion, 2);
  assert.equal(env.authorizationRevision, 2);
  assert.equal(env.authority.token, h.authorityToken);
  assert.equal(h.client.turns, 0);
});

test('uncertain turn acknowledgement keeps a durable dispatch record after restart', async (t) => {
  const h = fixture(t);
  const baseRequest = h.client.request.bind(h.client);
  h.client.request = async (method, p) => {
    const value = await baseRequest(method, p);
    if (method === 'turn/start') throw new Error('fixture lost response after send');
    return value;
  };
  const op = { ...h.start, accessMode: 'read_only' };
  const admission = h.issue(op);
  assert.equal((await h.send(admission, op)).ok, false);
  assert.equal(h.client.turns, 1);
  h.restart();
  // With no mutation owner to block a read-only retry, only the durable
  // dispatched-but-unacknowledged record prevents a duplicate turn.
  assert.throws(() => h.issue(op), /reconciliation/);
  assert.equal((await h.send(admission, op)).ok, false);
  assert.equal(h.client.turns, 1);
});

test('failure to prove directory flush leaves the prior revision intact and emits no grant', (t) => {
  const h = fixture(t);
  const before = h.store.loadTask(h.taskId).authorizationRevision;
  h.store.syncDirectory = () => { throw new Error('fixture unsupported directory flush'); };
  assert.throws(() => h.issue(), /unsupported directory flush/);
  assert.equal(h.store.loadTask(h.taskId).authorizationRevision, before);
  assert.throws(() => h.issue(), /admission storage/);
  assert.equal(h.client.threads, 0);
  assert.equal(h.client.turns, 0);
});
