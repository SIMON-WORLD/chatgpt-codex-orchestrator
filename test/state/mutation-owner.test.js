import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MutationOwner, MutationOwnerError } from '../../src/state/mutation-owner.js';

test('default owner is none', () => {
  const m = new MutationOwner();
  assert.equal(m.owner, 'none');
  assert.equal(m.isNone(), true);
});

test('acquire codex with unit binds owner + unit', () => {
  const m = new MutationOwner();
  m.acquire('codex', 'unit-1');
  assert.equal(m.owner, 'codex');
  assert.equal(m.unitId, 'unit-1');
  assert.equal(m.unitState, 'running');
});

test('same owner + SAME unitId reacquire is idempotent', () => {
  const m = new MutationOwner();
  m.acquire('codex', 'unit-1');
  const r = m.acquire('codex', 'unit-1');
  assert.equal(r.acquired, true);
  assert.equal(m.unitId, 'unit-1');
});

test('same owner + DIFFERENT running unitId fails closed', () => {
  const m = new MutationOwner();
  m.acquire('codex', 'unit-1');
  assert.throws(() => m.acquire('codex', 'unit-2'), MutationOwnerError);
});

test('different owner fails closed', () => {
  const m = new MutationOwner();
  m.acquire('codex', 'unit-1');
  assert.throws(() => m.acquire('chatgpt', 'unit-2'), MutationOwnerError);
});

test('after reconciled, a different unit may be acquired', () => {
  const m = new MutationOwner();
  m.acquire('codex', 'unit-1');
  m.markUnitState('reconciled');
  const r = m.acquire('codex', 'unit-2');
  assert.equal(r.acquired, true);
  assert.equal(m.unitId, 'unit-2');
  assert.equal(m.unitState, 'running');
});

test('release requires reconciled unit state', () => {
  const m = new MutationOwner();
  m.acquire('codex', 'unit-1');
  assert.throws(() => m.release(), /not reconciled/);
  m.markUnitState('reconciled');
  const r = m.release();
  assert.equal(r.released, true);
  assert.equal(m.owner, 'none');
  assert.equal(m.unitId, null);
});

test('interrupted/unknown state blocks silent release', () => {
  const m = new MutationOwner();
  m.acquire('codex', 'unit-1');
  m.markUnitState('interrupted');
  assert.throws(() => m.release(), /not reconciled/);
  m.markUnitState('reconciled');
  assert.equal(m.release().released, true);
});

test('force release bypasses reconcile guard', () => {
  const m = new MutationOwner();
  m.acquire('codex', 'unit-1');
  m.markUnitState('unknown');
  const r = m.release({ force: true });
  assert.equal(r.released, true);
  assert.equal(m.owner, 'none');
});

test('assertCanWrite denies a different owner', () => {
  const m = new MutationOwner();
  m.acquire('codex', 'unit-1');
  assert.throws(() => m.assertCanWrite('chatgpt'), /owned by codex/);
  assert.equal(m.assertCanWrite('codex'), true);
});

test('acquire without unitId fails closed', () => {
  const m = new MutationOwner();
  assert.throws(() => m.acquire('codex'), MutationOwnerError);
  assert.throws(() => m.acquire('codex', ''), MutationOwnerError);
});

test('release when already none is a no-op', () => {
  const m = new MutationOwner();
  const r = m.release();
  assert.equal(r.released, false);
});
