import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskLock, TaskLockedError } from '../src/task-lock.js';

function dir() { const d = path.join(os.tmpdir(), 'lock-' + Date.now()); fs.mkdirSync(d, { recursive: true }); return d; }

test('lock: second acquire throws, release allows re-acquire', () => {
  const l = new TaskLock({ lockDir: dir() });
  const r1 = l.acquire('task-1');
  assert.strictEqual(l.isHeld('task-1'), true);
  assert.throws(() => l.acquire('task-1'), TaskLockedError);
  r1();
  assert.strictEqual(l.isHeld('task-1'), false);
  const r2 = l.acquire('task-1');
  r2();
});

test('stale lock (dead owner) is reclaimed', () => {
  const d = dir();
  const l = new TaskLock({ lockDir: d, staleMs: 1000 });
  // write a lock from a dead owner + old timestamp
  fs.writeFileSync(path.join(d, 'task-9.lock'), JSON.stringify({ owner: 'dead', pid: 999999, at: '2000-01-01T00:00:00.000Z', taskId: 'task-9' }), 'utf8');
  const release = l.acquire('task-9');
  assert.strictEqual(l.isHeld('task-9'), true);
  release();
});

test('active owner (live pid) is rejected', () => {
  const d = dir();
  const l = new TaskLock({ lockDir: d, staleMs: 100000 });
  fs.writeFileSync(path.join(d, 'task-10.lock'), JSON.stringify({ owner: 'live', pid: process.pid, at: new Date().toISOString(), taskId: 'task-10' }), 'utf8');
  assert.throws(() => l.acquire('task-10'), TaskLockedError);
});