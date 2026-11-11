import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDurableGovernanceService, GovernanceStore } from '../../src/governance/durable.js';

// These tests are evidence for the shipped Windows store on an ephemeral runner,
// not a signal to run native I/O/child probes on a production device.
const admittedRunner = process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true' &&
  process.env.RUNNER_OS === 'Windows' && !!process.env.RUNNER_TEMP;
const opts = { skip: !admittedRunner, timeout: 240000 };
const taskId = 'windows-durability-fixture';
const workerImports = new URL('../../src/governance/durable.js', import.meta.url).href;
const scope = (workspaceRoot) => ({
  taskId, workspaceRoot, projectKey: 'example/fixture', governanceStep: 'step',
  key: 'a'.repeat(64), operationDigest: 'b'.repeat(64), contextDigest: 'c'.repeat(64),
});

function setup() {
  const dataRoot = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'windows-admission-'));
  const workspaceRoot = fs.realpathSync.native(dataRoot);
  const store = new GovernanceStore({ dataRoot });
  const service = createDurableGovernanceService({ dataRoot, store, heartbeatMs: 1 });
  try {
    const { authorityToken } = service.transition({ taskId, projectKey: 'example/fixture',
      workspaceRoot, control: 'PLAN' });
    service.transition({ taskId, workspaceRoot, authorityToken, stepId: 'step',
      control: 'TASK', route: 'CODEX_DELEGATE', acceptance: [{ id: 'fixture' }] });
  } finally { service.close(); }
  return { dataRoot, workspaceRoot, store };
}

function runInterruptedWriter(fixture, mode) {
  const worker = `
import fs from 'node:fs';
import { createDurableGovernanceService, GovernanceStore } from ${JSON.stringify(workerImports)};
const [dataRoot, workspaceRoot, mode] = process.argv.slice(1);
const taskId = ${JSON.stringify(taskId)};
const scope = { ...${JSON.stringify(scope(''))}, workspaceRoot };
const store = new GovernanceStore({ dataRoot });
const service = createDurableGovernanceService({ dataRoot, store, heartbeatMs: 1 });
service.loadTask(taskId);
const authorityToken = store.loadAdmissionTask(taskId).authority.token;
const grant = service.issueRelayCodexAdmission(scope, authorityToken).admission;
// Pass the exact fixture permit to the test parent without writing it to CI logs.
fs.writeSync(1, grant);
if (mode === 'between-replacements') {
  // Interrupt after a real primary rename and native flush, before backup.
  const realFlush = store.syncDirectory;
  let calls = 0;
  store.syncDirectory = (dir) => {
    realFlush(dir);
    if (++calls === 2) process.exit(43);
  };
}
const permit = service.reserveRelayCodexAdmission(scope, grant);
permit.commitDispatch();
// The protocol dispatch would be allowed at this point. Do not start it.
// Exit without acknowledgement or writer release.
process.exit(42);
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', worker,
    fixture.dataRoot, fixture.workspaceRoot, mode], { encoding: 'utf8', timeout: 180000, windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, mode === 'between-replacements' ? 43 : 42, result.stderr);
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(result.stdout), 'worker must return the issued fixture permit');
  return result.stdout;
}

test('real Windows checked store preserves a committed dispatch fence after writer process exit', opts, (t) => {
  const f = setup();
  const grant = runInterruptedWriter(f, 'after-dispatch-commit');
  const env = f.store.loadAdmissionTask(taskId);
  assert.equal(env.relayCodex.records[0].state, 'dispatched');
  assert.equal(env.relayCodex.records[0].revision, env.authorizationRevision);
  const service = createDurableGovernanceService({ dataRoot: f.dataRoot, heartbeatMs: 1 });
  t.after(() => service.close());
  service.loadTask(taskId);
  assert.throws(() => service.reserveRelayCodexAdmission(scope(f.workspaceRoot), grant),
    (e) => e.code === 'admission_denied');
  assert.throws(() => service.issueRelayCodexAdmission(scope(f.workspaceRoot), env.authority.token),
    (e) => e.code === 'admission_recovery_required');
});

test('real Windows interrupted replacement cannot restore admission from an older backup', opts, (t) => {
  const f = setup();
  const grant = runInterruptedWriter(f, 'between-replacements');
  const primary = path.join(f.store.dir, taskId + '.json');
  assert.notEqual(fs.readFileSync(primary, 'utf8'), fs.readFileSync(primary + '.bak', 'utf8'));
  assert.throws(() => f.store.loadAdmissionTask(taskId), (e) => e.code === 'admission_storage_unverified');
  // The ordinary reader can inspect the older backup after simulated primary
  // loss. That read must not clear the stronger admission boundary.
  fs.writeFileSync(primary, 'invalid fixture primary', 'utf8');
  const service = createDurableGovernanceService({ dataRoot: f.dataRoot, heartbeatMs: 1 });
  t.after(() => service.close());
  service.loadTask(taskId);
  const backup = f.store.loadTask(taskId);
  assert.equal(backup.relayCodex.records[0].state, 'issued');
  assert.throws(() => service.issueRelayCodexAdmission(scope(f.workspaceRoot), backup.authority.token),
    (e) => e.code === 'admission_storage_unverified');
  assert.throws(() => service.reserveRelayCodexAdmission(scope(f.workspaceRoot), grant),
    (e) => e.code === 'admission_storage_unverified');
});

test('native Windows flush refuses a regular file as a directory', opts, () => {
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'windows-flush-denial-'));
  const store = new GovernanceStore({ dataRoot: dir });
  const regular = path.join(dir, 'regular-file');
  fs.writeFileSync(regular, 'fixture', 'utf8');
  assert.throws(() => store.syncDirectory(regular), (e) => e.code === 'admission_storage_unverified');
});
