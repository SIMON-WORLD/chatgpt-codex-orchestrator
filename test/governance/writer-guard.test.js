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

test('a LIVE owner is never reclaimed after the stale window (heartbeat age alone must not create two live canonical writers)', () => {
  const { dataRoot, namespace } = fixture();
  let clock = 5000;
  const now = () => clock;
  const w1 = new GovernanceWriterGuard({ dataRoot, namespace, now, staleMs: 1000 });
  w1.acquire();
  // The owner PID is alive (same process) but its heartbeat is far older than the
  // stale window. Inactivity must NOT allow a second live canonical writer.
  clock += 60000;
  const w2 = new GovernanceWriterGuard({ dataRoot, namespace, now, staleMs: 1000, pidAlive: () => true });
  assert.throws(() => w2.acquire(), (e) => e instanceof GovernanceWriterError && e.code === 'writer_conflict');
  // The slot still belongs to w1.
  const file = path.join(w1.dir, 'writer.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).writerId, w1.writerId);
  w1.release();
});

test('a DEAD owner is reclaimed immediately even with a fresh heartbeat (crash/restart continuity)', () => {
  const { dataRoot, namespace } = fixture();
  let clock = 9000;
  const now = () => clock;
  const w1 = new GovernanceWriterGuard({ dataRoot, namespace, now });
  w1.acquire();
  // Simulate a crash: the recorded owner PID is no longer alive while the heartbeat
  // is still fresh. A restarting runtime must be able to reclaim without waiting.
  const w2 = new GovernanceWriterGuard({ dataRoot, namespace, now, pidAlive: () => false });
  const acq = w2.acquire();
  assert.equal(acq.ok, true);
  assert.equal(acq.reclaimed, true);
  const file = path.join(w1.dir, 'writer.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).writerId, w2.writerId);
  w2.release();
});

test('assertOwned/refresh fail closed once the writer slot belongs to another writer', () => {
  const { dataRoot, namespace } = fixture();
  const w1 = new GovernanceWriterGuard({ dataRoot, namespace });
  w1.acquire();
  // Another runtime takes over the slot (w1's recorded PID is treated as dead).
  const w2 = new GovernanceWriterGuard({ dataRoot, namespace, pidAlive: () => false });
  w2.acquire();
  assert.equal(w2.held, true);
  // w1 still believes it holds the slot, but ownership is gone: fail closed.
  assert.throws(() => w1.assertOwned(), (e) => e instanceof GovernanceWriterError && e.code === 'writer_conflict');
  assert.throws(() => w1.refresh(), (e) => e.code === 'writer_conflict');
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


function writeDeadSlot(guardDir, { writerId = 'dead-owner', pid = 2147483647 } = {}) {
  const file = path.join(guardDir, 'writer.json');
  fs.writeFileSync(file, JSON.stringify({ writerId, namespace: 'default', dataRoot: guardDir, pid, at: 1000, heartbeatAt: 1000 }), 'utf8');
  return file;
}

test('two reclaimers against one dead/stale owner: exactly one wins; loser fails closed and cannot delete/replace winner slot', () => {
  const { dataRoot, namespace } = fixture();
  const probe = new GovernanceWriterGuard({ dataRoot, namespace });
  const file = writeDeadSlot(probe.dir);
  const winner = new GovernanceWriterGuard({ dataRoot, namespace });
  const win = winner.acquire();
  assert.equal(win.ok, true);
  assert.equal(win.reclaimed, true);
  const loser = new GovernanceWriterGuard({ dataRoot, namespace });
  assert.throws(() => loser.acquire(), (e) => e instanceof GovernanceWriterError && e.code === 'writer_conflict');
  assert.equal(loser.held, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).writerId, winner.writerId);
  winner.assertOwned(); // winner remains canonical
  const leftovers = fs.readdirSync(probe.dir).filter((n) => n.includes('.claim.'));
  assert.equal(leftovers.length, 0);
  winner.release();
});

test('reclaim is single-winner even when the slot changed after inspection (contender never deletes the winner slot)', () => {
  const { dataRoot, namespace } = fixture();
  const probe = new GovernanceWriterGuard({ dataRoot, namespace });
  const file = writeDeadSlot(probe.dir);
  const winner = new GovernanceWriterGuard({ dataRoot, namespace });
  // The loser inspects the dead slot; before it can claim, the winner reclaims and
  // creates a live slot. The loser must detect the change, restore, and fail closed -
  // never unlink/replace the winner's slot (the exact old rm+wx race).
  const loser = new GovernanceWriterGuard({ dataRoot, namespace, hooks: { beforeStaleClaim() { winner.acquire(); } } });
  assert.throws(() => loser.acquire(), (e) => e instanceof GovernanceWriterError && e.code === 'writer_conflict');
  assert.equal(loser.held, false);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.writerId, winner.writerId);
  winner.assertOwned(); // winner slot intact and canonical
  const leftovers = fs.readdirSync(probe.dir).filter((n) => n.includes('.claim.'));
  assert.equal(leftovers.length, 0);
  winner.release();
});
