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
