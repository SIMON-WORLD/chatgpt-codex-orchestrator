import { test } from 'node:test';
import assert from 'node:assert';
import {
  resolveVerificationLevel, shouldRunFullSuite, resolveVerificationCommands, buildVerificationPlan,
  normalizeVerificationPolicy, canDowngrade, TIER_RANK,
} from '../src/verification.js';

test('normalizeVerificationPolicy supplies defaults', () => {
  const p = normalizeVerificationPolicy(null);
  assert.strictEqual(p.defaultLevel, 'step');
  assert.deepStrictEqual(p.fullTestAt, ['milestone', 'final']);
  assert.strictEqual(p.docOnlyTier, 'step');
});

test('doc-only step uses docOnlyTier, but never overrides an explicit request or a mandatory boundary', () => {
  const policy = { defaultLevel: 'step', docOnlyTier: 'step', fullTestAt: ['milestone', 'final'] };
  // default step + docOnly stays at docOnlyTier
  assert.strictEqual(resolveVerificationLevel({ policy, docOnly: true }), 'step');
  // a milestone implied by the plan is downscoped for a value-neutral doc step? no: milestone default only if requested...
  // explicit Brain 'milestone' is NOT silent-downgraded by docOnly
  assert.strictEqual(resolveVerificationLevel({ policy, requested: 'milestone', docOnly: true }), 'milestone');
  // mandatory final is never bypassed
  assert.strictEqual(resolveVerificationLevel({ policy, requested: 'step', mandatory: 'final', docOnly: true }), 'final');
  // codex minimum (escalation) is not silent-downgraded
  assert.strictEqual(resolveVerificationLevel({ policy, requested: 'step', codexMinimum: 'final', docOnly: true }), 'final');
});

test('resolveVerificationLevel: default to step, mandatory wins over requested, codex minimum only escalates', () => {
  // default
  assert.strictEqual(resolveVerificationLevel({}), 'step');
  // requested final -> final
  assert.strictEqual(resolveVerificationLevel({ requested: 'final' }), 'final');
  // mandatory final beats requested step
  assert.strictEqual(resolveVerificationLevel({ requested: 'step', mandatory: 'final' }), 'final');
  // codex minimum escalates (final) above requested milestone
  assert.strictEqual(resolveVerificationLevel({ requested: 'milestone', codexMinimum: 'final' }), 'final');
  // codex minimum cannot silently downgrade below requested
  assert.strictEqual(resolveVerificationLevel({ requested: 'milestone', codexMinimum: 'step' }), 'milestone');
});

test('shouldRunFullSuite: milestone/final by default, not step', () => {
  assert.strictEqual(shouldRunFullSuite({ level: 'step' }), false);
  assert.strictEqual(shouldRunFullSuite({ level: 'milestone' }), true);
  assert.strictEqual(shouldRunFullSuite({ level: 'final' }), true);
});

test('canDowngrade: cannot drop below mandatory; codex may not silently downgrade', () => {
  assert.strictEqual(canDowngrade({ mandatory: 'final', requested: 'step' }), false);
  assert.strictEqual(canDowngrade({ mandatory: 'step', requested: 'step' }), true);
  assert.strictEqual(canDowngrade({ mandatory: 'step', requested: 'milestone', codexMinimum: 'step' }), false);
});

test('resolveVerificationCommands: repository-specific, from policy/profile not hardcoded', () => {
  const commands = { step: ['node --test test/stats.test.js'], final: ['npm test', 'npm run check'] };
  assert.deepStrictEqual(resolveVerificationCommands({ level: 'step', commands }), ['node --test test/stats.test.js']);
  assert.deepStrictEqual(resolveVerificationCommands({ level: 'final', commands }), ['npm test', 'npm run check']);
  // no commands -> empty (never globally hard-coded)
  assert.deepStrictEqual(resolveVerificationCommands({ level: 'milestone' }), []);
});

test('buildVerificationPlan returns level/fullSuite/commands', () => {
  const plan = buildVerificationPlan({ policy: null, requested: 'final', commands: { final: ['npm test'] } });
  assert.strictEqual(plan.level, 'final');
  assert.strictEqual(plan.fullSuite, true);
  assert.deepStrictEqual(plan.commands, ['npm test']);
});

test('TIER_RANK order', () => {
  assert.ok(TIER_RANK.milestone > TIER_RANK.step);
  assert.ok(TIER_RANK.final > TIER_RANK.milestone);
});
