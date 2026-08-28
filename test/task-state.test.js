import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STATE_SCHEMA_VERSION, newTaskState, saveState, loadState, updateState, addStep, setStepStatus, findStep,
  TaskStateCorruptError,
} from '../src/task-state.js';

function dir() { const d = path.join(os.tmpdir(), 'ts-' + Date.now()); fs.mkdirSync(d, { recursive: true }); return d; }

test('newTaskState has schema/status/taskId', () => {
  const s = newTaskState({ repoDir: 'r', goal: 'g' });
  assert.strictEqual(s.schemaVersion, STATE_SCHEMA_VERSION);
  assert.strictEqual(s.status, 'running');
  assert.ok(s.taskId);
  assert.strictEqual(s.repoDir, 'r');
});

test('save/load roundtrip and stable taskId', () => {
  const d = dir();
  const s = newTaskState({ repoDir: 'r', goal: 'g' });
  saveState(d, s);
  const loaded = loadState(d, s.taskId);
  assert.strictEqual(loaded.taskId, s.taskId);
  assert.strictEqual(loaded.goal, 'g');
});

test('corrupt primary falls back to .bak', () => {
  const d = dir();
  const s = newTaskState({ repoDir: 'r', goal: 'g' });
  saveState(d, s);
  // corrupt primary
  fs.writeFileSync(path.join(d, s.taskId + '.json'), '{not json', 'utf8');
  const loaded = loadState(d, s.taskId);
  assert.strictEqual(loaded.goal, 'g');
});

test('corrupt primary AND backup -> TaskStateCorruptError (no silent reset)', () => {
  const d = dir();
  const s = newTaskState({ repoDir: 'r', goal: 'g' });
  saveState(d, s);
  fs.writeFileSync(path.join(d, s.taskId + '.json'), '{bad', 'utf8');
  fs.writeFileSync(path.join(d, s.taskId + '.json.bak'), '{bad', 'utf8');
  assert.throws(() => loadState(d, s.taskId), TaskStateCorruptError);
});

test('updateState bumps updatedAt and keeps schema', () => {
  const s = newTaskState({ repoDir: 'r', goal: 'g' });
  const u = updateState(s, { round: 1 });
  assert.strictEqual(u.round, 1);
  assert.strictEqual(u.schemaVersion, STATE_SCHEMA_VERSION);
  assert.ok(u.updatedAt >= s.updatedAt);
});

test('step ledger: received -> executing -> executed -> reviewed adds to completedSteps', () => {
  const s = newTaskState({ repoDir: 'r', goal: 'g' });
  addStep(s, { stepId: 'step-1', control: 'TASK', instruction: 'x', acceptance: [], status: 'received' });
  setStepStatus(s, 'step-1', 'executing');
  setStepStatus(s, 'step-1', 'executed');
  setStepStatus(s, 'step-1', 'reviewed');
  assert.ok(s.completedSteps.includes('step-1'));
  assert.strictEqual(findStep(s, 'step-1').status, 'reviewed');
});