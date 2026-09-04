import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobMap } from '../../src/executor/job-map.js';

const CURRENT_IDENTITY = 'brain-continuity@main:c4088fd3';

function fixture(prefix = 'recovery-preflight-') {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspaceRoot = path.join(dataRoot, 'repo');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  return { dataRoot, workspaceRoot, workspaceId: 'ws-current', map: new JobMap({ dataRoot }) };
}

function saveJob(map, patch = {}) {
  const job = map.create();
  return map.update(job.jobId, {
    workspaceId: 'ws-current',
    workspaceRoot: patch.workspaceRoot || null,
    state: 'running',
    ...patch,
  });
}

function preflight(map, args) {
  assert.equal(typeof map.recoveryPreflight, 'function', 'JobMap.recoveryPreflight must exist');
  return map.recoveryPreflight(args);
}

test('recovery preflight ignores terminal history and unrelated bound non-terminal jobs', () => {
  const { map, workspaceRoot, workspaceId } = fixture();
  saveJob(map, { workspaceRoot, state: 'completed' });
  saveJob(map, { workspaceRoot, state: 'failed', identity: CURRENT_IDENTITY });
  saveJob(map, { workspaceRoot, state: 'interrupted', identity: CURRENT_IDENTITY });
  saveJob(map, { workspaceRoot, state: 'running', identity: 'different-task' });

  const result = preflight(map, { workspaceId, workspaceRoot, identity: CURRENT_IDENTITY });
  assert.deepEqual(result, {
    ok: true,
    status: 'safe_to_start',
    dangerousCandidateCount: 0,
    nextAction: 'codex_start_allowed',
  });
});

test('recovery preflight returns the unique unbound recovery-risk job for reconcile, never latest', () => {
  const { map, workspaceRoot, workspaceId } = fixture();
  const job = saveJob(map, { workspaceRoot, state: 'running', taskId: null, stepId: null, identity: null, createdAt: 1, updatedAt: 1 });
  saveJob(map, { workspaceRoot, state: 'completed', taskId: null, stepId: null, identity: null, createdAt: 999999, updatedAt: 999999 });

  const result = preflight(map, { workspaceId, workspaceRoot, identity: CURRENT_IDENTITY });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'recover_existing');
  assert.equal(result.dangerousCandidateCount, 1);
  assert.equal(result.nextAction, 'codex_reconcile');
  assert.equal(result.recovery.jobId, job.jobId);
  assert.equal(result.recovery.mode, 'job_id');
  assert.equal('jobs' in result, false);
});

test('recovery preflight recovers one matching bound risk job by semantic binding and workspace root across workspaceId refresh', () => {
  const { map, workspaceRoot } = fixture();
  const job = saveJob(map, {
    workspaceId: 'ws-old-runtime',
    workspaceRoot,
    state: 'recovery_required',
    taskId: 'post-m7-brain-continuity-implementation',
    stepId: 'brain-continuity-implementation',
    identity: CURRENT_IDENTITY,
  });

  const result = preflight(map, {
    workspaceId: 'ws-new-runtime',
    workspaceRoot,
    taskId: 'post-m7-brain-continuity-implementation',
    stepId: 'brain-continuity-implementation',
    identity: CURRENT_IDENTITY,
  });
  assert.equal(result.status, 'recover_existing');
  assert.equal(result.nextAction, 'codex_recover');
  assert.equal(result.recovery.jobId, job.jobId);
  assert.deepEqual(result.recovery.binding, {
    taskId: 'post-m7-brain-continuity-implementation',
    stepId: 'brain-continuity-implementation',
    identity: CURRENT_IDENTITY,
  });
});

test('recovery preflight fails closed on multiple dangerous candidates regardless of timestamps', () => {
  const { map, workspaceRoot, workspaceId } = fixture();
  saveJob(map, { workspaceRoot, state: 'created', taskId: null, stepId: null, identity: null, createdAt: 1, updatedAt: 1 });
  saveJob(map, { workspaceRoot, state: 'running', identity: CURRENT_IDENTITY, createdAt: 999999, updatedAt: 999999 });

  const result = preflight(map, { workspaceId, workspaceRoot, identity: CURRENT_IDENTITY });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ambiguous');
  assert.equal(result.dangerousCandidateCount, 2);
  assert.equal('jobId' in result, false);
  assert.equal('jobs' in result, false);
});

test('recovery preflight fails closed on corrupt durable job-map state', () => {
  const { map, dataRoot, workspaceRoot, workspaceId } = fixture();
  fs.writeFileSync(path.join(dataRoot, 'runtime', 'job-maps', 'corrupt.json'), '{not-json', 'utf8');

  const result = preflight(map, { workspaceId, workspaceRoot, identity: CURRENT_IDENTITY });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'corrupt');
  assert.equal('jobs' in result, false);
});

test('recovery preflight fails closed when the current semantic binding is active in a foreign workspace', () => {
  const { map, workspaceRoot, workspaceId } = fixture();
  saveJob(map, {
    workspaceId: 'ws-foreign',
    workspaceRoot: path.join(path.dirname(workspaceRoot), 'other-repo'),
    state: 'running',
    identity: CURRENT_IDENTITY,
  });

  const result = preflight(map, { workspaceId, workspaceRoot, identity: CURRENT_IDENTITY });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'foreign');
});

test('recovery preflight fails closed on unknown lifecycle for a would-be dangerous candidate', () => {
  const { map, workspaceRoot, workspaceId } = fixture();
  saveJob(map, { workspaceRoot, state: 'mystery_state', identity: CURRENT_IDENTITY });

  const result = preflight(map, { workspaceId, workspaceRoot, identity: CURRENT_IDENTITY });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'lifecycle_unknown');
});

test('recovery preflight requires semantic scope so it cannot become a generic job browser', () => {
  const { map, workspaceRoot, workspaceId } = fixture();
  const result = preflight(map, { workspaceId, workspaceRoot });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'bad_request');
});
