import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRoute, normalizeFacts, ROUTES, MUTATION_OWNERS, ACCESS_MODES, FACT_KEYS, RouterError } from '../../src/router/decide.js';

test('router contract exposes the four routes and owner surface', () => {
  assert.deepEqual([...ROUTES], ['CHATGPT_NATIVE', 'CHATGPT_DIRECT_LOCAL', 'CODEX_DELEGATE', 'HYBRID']);
  assert.deepEqual([...MUTATION_OWNERS], ['none', 'chatgpt', 'codex']);
  assert.equal(FACT_KEYS.length, 10);
  assert.deepEqual([...ACCESS_MODES], ['read_only', 'workspace_write']);
});

test('native only -> CHATGPT_NATIVE', () => {
  const d = decideRoute({ requiresNative: true, requiresLocal: false });
  assert.equal(d.route, 'CHATGPT_NATIVE');
  assert.equal(d.localRoute, null);
  assert.equal(d.mutationOwnerExpected, 'none');
  assert.ok(d.reasonCodes.includes('native_only'));
});

test('no capability required -> CHATGPT_NATIVE', () => {
  const d = decideRoute({ requiresNative: false, requiresLocal: false });
  assert.equal(d.route, 'CHATGPT_NATIVE');
  assert.equal(d.mutationOwnerExpected, 'none');
  assert.ok(d.reasonCodes.includes('no_capability_required'));
});

test('read-only local -> CHATGPT_DIRECT_LOCAL (owner none)', () => {
  const d = decideRoute({ requiresLocal: true, requiresNative: false, readOnly: true, mutationRequired: false });
  assert.equal(d.route, 'CHATGPT_DIRECT_LOCAL');
  assert.equal(d.mutationOwnerExpected, 'none');
  assert.ok(d.reasonCodes.includes('read_only') || d.reasonCodes.includes('local_only'));
});

test('bounded exact mutation -> CHATGPT_DIRECT_LOCAL (owner chatgpt)', () => {
  const d = decideRoute({ requiresLocal: true, requiresNative: false, mutationRequired: true, boundedChange: true, exactChangeKnown: true, multiFile: false, unknownRootCause: false, iterative: false, longRunning: false });
  assert.equal(d.route, 'CHATGPT_DIRECT_LOCAL');
  assert.equal(d.mutationOwnerExpected, 'chatgpt');
});

test('multi-file -> CODEX_DELEGATE (owner codex)', () => {
  const d = decideRoute({ requiresLocal: true, requiresNative: false, mutationRequired: true, multiFile: true });
  assert.equal(d.route, 'CODEX_DELEGATE');
  assert.equal(d.mutationOwnerExpected, 'codex');
});

test('unknown root cause -> CODEX_DELEGATE', () => {
  const d = decideRoute({ requiresLocal: true, requiresNative: false, mutationRequired: true, unknownRootCause: true });
  assert.equal(d.route, 'CODEX_DELEGATE');
});

test('iterative -> CODEX_DELEGATE even if bounded/exact is ambiguous', () => {
  const d = decideRoute({ requiresLocal: true, requiresNative: false, mutationRequired: true, boundedChange: true, exactChangeKnown: true, iterative: true });
  assert.equal(d.route, 'CODEX_DELEGATE');
  assert.equal(d.mutationOwnerExpected, 'codex');
});

test('long-running -> CODEX_DELEGATE', () => {
  const d = decideRoute({ requiresLocal: true, requiresNative: false, mutationRequired: true, longRunning: true });
  assert.equal(d.route, 'CODEX_DELEGATE');
});

test('mutation not bounded/exact -> conservative CODEX_DELEGATE', () => {
  const d = decideRoute({ requiresLocal: true, requiresNative: false, mutationRequired: true, boundedChange: false, exactChangeKnown: false });
  assert.equal(d.route, 'CODEX_DELEGATE');
});

test('native + bounded local -> HYBRID + DIRECT_LOCAL (hybrid is not owner)', () => {
  const d = decideRoute({ requiresNative: true, requiresLocal: true, mutationRequired: true, boundedChange: true, exactChangeKnown: true });
  assert.equal(d.route, 'HYBRID');
  assert.equal(d.localRoute, 'CHATGPT_DIRECT_LOCAL');
  assert.ok(d.reasonCodes.includes('capability_both_then_compose'));
  // HYBRID is never the mutation owner; the local leg owns.
  assert.ok(d.mutationOwnerExpected !== 'hybrid');
  assert.equal(d.mutationOwnerExpected, 'chatgpt');
});

test('native + complex local -> HYBRID + CODEX_DELEGATE', () => {
  const d = decideRoute({ requiresNative: true, requiresLocal: true, mutationRequired: true, multiFile: true, unknownRootCause: true });
  assert.equal(d.route, 'HYBRID');
  assert.equal(d.localRoute, 'CODEX_DELEGATE');
  assert.equal(d.mutationOwnerExpected, 'codex');
});

test('native + read-only local -> HYBRID + DIRECT_LOCAL, owner none', () => {
  const d = decideRoute({ requiresNative: true, requiresLocal: true, readOnly: true, mutationRequired: false });
  assert.equal(d.route, 'HYBRID');
  assert.equal(d.localRoute, 'CHATGPT_DIRECT_LOCAL');
  assert.equal(d.mutationOwnerExpected, 'none');
});

test('hybrid is never a mutation owner in the returned owner field', () => {
  for (const opts of [
    { requiresNative: true, requiresLocal: true, mutationRequired: true, boundedChange: true, exactChangeKnown: true },
    { requiresNative: true, requiresLocal: true, mutationRequired: true, multiFile: true },
  ]) {
    const d = decideRoute(opts);
    if (d.route === 'HYBRID') assert.notEqual(d.mutationOwnerExpected, 'hybrid');
  }
});

test('non-boolean fact is rejected (fail closed, never guess)', () => {
  assert.throws(() => decideRoute({ requiresNative: 'yes' }), RouterError);
  assert.throws(() => normalizeFacts({ readOnly: 1 }), RouterError);
});

test('missing facts default to false', () => {
  const d = decideRoute({});
  assert.equal(d.route, 'CHATGPT_NATIVE');
});

// ---- r1: contradiction / consistency validation ----------------------------

test('requiresLocal=false with local execution facts -> RouterError', () => {
  assert.throws(() => decideRoute({ requiresLocal: false, readOnly: true }), /local execution facts provided but requiresLocal is false/);
  assert.throws(() => decideRoute({ requiresLocal: false, mutationRequired: true }), /local execution facts provided but requiresLocal is false/);
});

test('readOnly and mutationRequired contradictory -> RouterError', () => {
  assert.throws(() => decideRoute({ requiresLocal: true, readOnly: true, mutationRequired: true }), /readOnly and mutationRequired are contradictory/);
});

test('requiresLocal=true must claim a readOnly or mutationRequired path -> RouterError', () => {
  assert.throws(() => decideRoute({ requiresLocal: true, readOnly: false, mutationRequired: false }), /requiresLocal must claim a readOnly or mutationRequired path/);
});

test('normalizeFacts applies the same consistency validation', () => {
  assert.throws(() => normalizeFacts({ requiresLocal: false, multiFile: true }), /local execution facts provided but requiresLocal is false/);
  assert.doesNotThrow(() => normalizeFacts({ requiresLocal: true, readOnly: true, mutationRequired: false }));
});


// ---- M7: explicit Codex access contract (codexAccessModeExpected) ----------

test('CODEX_DELEGATE mutation -> codexAccessModeExpected=workspace_write', () => {
  const d = decideRoute({ requiresLocal: true, requiresNative: false, mutationRequired: true, multiFile: true });
  assert.equal(d.route, 'CODEX_DELEGATE');
  assert.equal(d.codexAccessModeExpected, 'workspace_write');
});

test('HYBRID -> CODEX_DELEGATE mutation -> codexAccessModeExpected=workspace_write', () => {
  const d = decideRoute({ requiresNative: true, requiresLocal: true, mutationRequired: true, multiFile: true, unknownRootCause: true });
  assert.equal(d.route, 'HYBRID');
  assert.equal(d.localRoute, 'CODEX_DELEGATE');
  assert.equal(d.codexAccessModeExpected, 'workspace_write');
});

test('non-Codex routes -> codexAccessModeExpected=null', () => {
  // native-only
  let d = decideRoute({ requiresNative: true, requiresLocal: false });
  assert.equal(d.codexAccessModeExpected, null);
  // read-only direct local
  d = decideRoute({ requiresLocal: true, requiresNative: false, readOnly: true, mutationRequired: false });
  assert.equal(d.route, 'CHATGPT_DIRECT_LOCAL');
  assert.equal(d.codexAccessModeExpected, null);
  // HYBRID -> DIRECT_LOCAL
  d = decideRoute({ requiresNative: true, requiresLocal: true, readOnly: true, mutationRequired: false });
  assert.equal(d.localRoute, 'CHATGPT_DIRECT_LOCAL');
  assert.equal(d.codexAccessModeExpected, null);
});

test('Codex route never returns read_only for a mutation delegation', () => {
  const d = decideRoute({ requiresLocal: true, requiresNative: false, mutationRequired: true, longRunning: true });
  assert.equal(d.route, 'CODEX_DELEGATE');
  assert.equal(d.codexAccessModeExpected, 'workspace_write');
  assert.notEqual(d.codexAccessModeExpected, 'read_only');
});
