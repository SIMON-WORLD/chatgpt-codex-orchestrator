import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { redactSecrets, redactObject, verifyAuth, normalizeRepoDir, detectBypass } from '../src/safety.js';

test('redactSecrets strips known secret and sk- patterns', () => {
  assert.ok(!redactSecrets('Bearer sk-abcdefghijklmnop', ['sk-abcdefghijklmnop']).includes('sk-'));
  const out = redactSecrets('auth=sk-1234567890abcdef x', []);
  assert.ok(!out.includes('sk-1234567890abcdef'));
});

test('redactObject redacts secret-named keys recursively', () => {
  const out = redactObject({ a: { authorization: 'x', keep: 'ok' }, token: 't' });
  assert.strictEqual(out.a.authorization, '***');
  assert.strictEqual(out.token, '***');
  assert.strictEqual(out.a.keep, 'ok');
});

test('verifyAuth: ok / token mismatch / task mismatch', () => {
  assert.strictEqual(verifyAuth({ auth: 'T', taskId: 'a' }, { token: 'T', taskId: 'a' }).ok, true);
  assert.strictEqual(verifyAuth({ auth: 'X' }, { token: 'T' }).ok, false);
  assert.strictEqual(verifyAuth({ auth: 'T', taskId: 'b' }, { token: 'T', taskId: 'a' }).ok, false);
});

test('normalizeRepoDir resolves to absolute', () => {
  const p = normalizeRepoDir('.');
  assert.ok(path.isAbsolute(p), 'should be absolute: ' + p);
});

test('detectBypass default safe', () => {
  assert.strictEqual(detectBypass({ bypassSandbox: false }).needsBypass, false);
  assert.strictEqual(detectBypass({ bypassSandbox: true }).needsBypass, true);
});