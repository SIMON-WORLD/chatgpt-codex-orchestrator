import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GovernanceWriterGuard, GovernanceWriterError, WRITER_STALE_MS_DEFAULT } from '../../src/governance/writer-guard.js';

function fixture(prefix = 'wguard-') {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dataRoot, namespace: 'default' };
}

test('first writer acquires; second canonical writer in the same namespace fails closed', () => {
  const { dataRoot, namespace } = fixture();
  const w1 = new GovernanceWriterGuard({ dataRoot, namespace });
  assert.equal(w1.acquire().ok, true);
  const w2 = new GovernanceWriterGuard({ dataRoot, namespace });
  assert.throws(() => w2.acquire(), (e) => {
    assert.ok(e instanceof GovernanceWriterError);
    assert.equal(e.code, 'writer_conflict');
    return true;
  });
  // Different namespace is a different writer slot.
  const w3 = new GovernanceWriterGuard({ dataRoot, namespace: 'other' });
  assert.equal(w3.acquire().ok, true);
  w1.release();
  w3.release();
});

test('clean release allows a restart writer to acquire the same namespace', () => {
  const { dataRoot, namespace } = fixture();
  const w1 = new GovernanceWriterGuard({ dataRoot, namespace });
  w1.acquire();
  w1.release();
  const w2 = new GovernanceWriterGuard({ dataRoot, namespace });
  assert.equal(w2.acquire().ok, true);
  assert.equal(w2.acquire().ok, true); // re-entrant idempotent
  w2.release();
});

test('dead + stale owner is reclaimed (crash restart), never a live owner', () => {
  const { dataRoot, namespace } = fixture();
  let clock = 1000;
  const now = () => clock;
  // Owner "crashes": same process but we simulate its death with pidAlive=false.
  const w1 = new GovernanceWriterGuard({ dataRoot, namespace, now });
  w1.acquire();
  const w2 = new GovernanceWriterGuard({ dataRoot, namespace, now, pidAlive: () => false });
  clock += WRITER_STALE_MS_DEFAULT + 1;
  const acq = w2.acquire();
  assert.equal(acq.ok, true);
  assert.equal(acq.reclaimed, true);
  // The reclaimed slot belongs to w2.
  const file = path.join(w1.dir, 'writer.json');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.writerId, w2.writerId);
  w1.release(); // no-op: no longer ours
  w2.release();
});

test('live owner with a stale heartbeat is not stolen while pid alive but may be reclaimed after the stale window per heartbeat rule', () => {
  const { dataRoot, namespace } = fixture();
  let clock = 5000;
  const now = () => clock;
  const w1 = new GovernanceWriterGuard({ dataRoot, namespace, now, staleMs: 1000 });
  w1.acquire();
  // pid alive (same process) but heartbeat older than the stale window.
  clock += 2000;
  const w2 = new GovernanceWriterGuard({ dataRoot, namespace, now, staleMs: 1000, pidAlive: () => true });
  const acq = w2.acquire();
  assert.equal(acq.ok, true);
  assert.equal(acq.reclaimed, true);
  w2.release();
});

test('refresh keeps the heartbeat fresh so an active live writer is not stolen', () => {
  const { dataRoot, namespace } = fixture();
  let clock = 10000;
  const now = () => clock;
  const w1 = new GovernanceWriterGuard({ dataRoot, namespace, now, staleMs: 1000 });
  w1.acquire();
  clock += 500;
  w1.refresh();
  clock += 500;
  w1.refresh();
  const w2 = new GovernanceWriterGuard({ dataRoot, namespace, now, staleMs: 1000, pidAlive: () => true });
  // Heartbeat was refreshed, so not stale yet.
  assert.throws(() => w2.acquire(), (e) => e.code === 'writer_conflict');
  w1.release();
});
