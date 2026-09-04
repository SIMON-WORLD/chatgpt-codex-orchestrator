import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { JobMap } from '../../src/executor/job-map.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobmap-'));
function makeMap() { return new JobMap({ dataRoot: tmpRoot }); }

test('create persists a job id', () => {
  const map = makeMap();
  const e = map.create();
  assert.ok(e.jobId);
  const loaded = map.load(e.jobId);
  assert.equal(loaded.threadId, null);
});

test('save/load round-trips mapping', () => {
  const map = makeMap();
  const jobId = map.create().jobId;
  map.update(jobId, { threadId: 'thread-1', turnId: 'turn-1', state: 'running' });
  const loaded = map.load(jobId);
  assert.equal(loaded.threadId, 'thread-1');
  assert.equal(loaded.turnId, 'turn-1');
  assert.equal(loaded.state, 'running');
});

test('update bumps updatedAt and merges patch', () => {
  const map = makeMap();
  const jobId = map.create().jobId;
  const r1 = map.update(jobId, { state: 'running' });
  const r2 = map.update(jobId, { turnId: 'turn-2' });
  const loaded = map.load(jobId);
  assert.equal(loaded.state, 'running');
  assert.equal(loaded.turnId, 'turn-2');
  assert.ok(r2.updatedAt >= r1.updatedAt);
});

test('findByThread finds a job by threadId', () => {
  const map = makeMap();
  const jobId = map.create().jobId;
  map.update(jobId, { threadId: 'thread-9', state: 'running' });
  const found = map.findByThread('thread-9');
  assert.ok(found);
  assert.equal(found.jobId, jobId);
});

test('list returns persisted jobs', () => {
  const map = makeMap();
  map.create();
  map.create();
  const all = map.list();
  assert.ok(all.length >= 2);
});

test('job map persists purely in data root (no secrets)', () => {
  const map = makeMap();
  const jobId = map.create().jobId;
  map.update(jobId, { threadId: 't', turnId: 'u', state: 'running' });
  const raw = fs.readFileSync(path.join(tmpRoot, 'runtime', 'job-maps', jobId + '.json'), 'utf8');
  assert.ok(!/sk-|api[_-]?key|bearer|password|token/i.test(raw));
});

test('findByBinding matches exact durable orchestration identity', () => {
  const map = makeMap();
  const a = map.create().jobId;
  map.update(a, { taskId: 't1', stepId: 's1', identity: 'build' });
  const b = map.create().jobId;
  map.update(b, { taskId: 't2', stepId: 's2', identity: 'other' });
  assert.equal(map.findByBinding({ taskId: 't1' }).length, 1);
  assert.equal(map.findByBinding({ taskId: 't1' })[0].jobId, a);
  assert.equal(map.findByBinding({ taskId: 't1', stepId: 's1' })[0].jobId, a);
  assert.equal(map.findByBinding({ identity: 'build' })[0].jobId, a);
  assert.equal(map.findByBinding({ taskId: 'nope' }).length, 0);
  assert.equal(map.findByBinding({ taskId: 't1', stepId: 's2' }).length, 0);
});

test('findByBinding with no identity fields returns all persisted jobs (bounded by caller)', () => {
  const map = makeMap();
  map.create();
  map.create();
  assert.ok(map.findByBinding({}).length >= 2);
});

test('binding identity survives save/load round-trip', () => {
  const map = makeMap();
  const id = map.create().jobId;
  map.update(id, { taskId: 'T', stepId: 'S', identity: 'label' });
  const loaded = map.load(id);
  assert.equal(loaded.taskId, 'T');
  assert.equal(loaded.stepId, 'S');
  assert.equal(loaded.identity, 'label');
});
