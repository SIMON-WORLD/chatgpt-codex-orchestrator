import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MutationOwner, MutationOwnerError } from '../../src/state/mutation-owner.js';

test('default owner is none', () => {
  const m = new MutationOwner();
  assert.equal(m.owner, 'none');
  assert.equal(m.isNone(), true);
});

test('acquire codex sets owner; conflicting acquire fails closed', () => {
  const m = new MutationOwner();
  m.acquire('codex');
  assert.equal(m.owner, 'codex');
  assert.throws(() => m.acquire('chatgpt'), MutationOwnerError);
});

test('release requires reconciled unit state', () => {
  const m = new MutationOwner();
  m.acquire('codex');
  // running -> release without reconcile fails
  assert.throws(() => m.release(), /not reconciled/);
  m.markUnitState('reconciled');
  const r = m.release();
  assert.equal(r.released, true);
  assert.equal(m.owner, 'none');
});

test('interrupted/unknown state blocks silent release', () => {
  const m = new MutationOwner();
  m.acquire('codex');
  m.markUnitState('interrupted');
  assert.throws(() => m.release(), /not reconciled/);
  m.markUnitState('reconciled');
  assert.equal(m.release().released, true);
});

test('force release bypasses reconcile guard', () => {
  const m = new MutationOwner();
  m.acquire('codex');
  m.markUnitState('unknown');
  const r = m.release({ force: true });
  assert.equal(r.released, true);
  assert.equal(m.owner, 'none');
});

test('assertCanWrite denies a different owner', () => {
  const m = new MutationOwner();
  m.acquire('codex');
  assert.throws(() => m.assertCanWrite('chatgpt'), /owned by codex/);
  assert.equal(m.assertCanWrite('codex'), true);
});

test('release when already none is a no-op', () => {
  const m = new MutationOwner();
  const r = m.release();
  assert.equal(r.released, false);
});
