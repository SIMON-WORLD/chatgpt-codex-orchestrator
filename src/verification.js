// chatgpt-codex-orchestrator: Verification Policy & Authority (Alpha.2).
// Tiers: step / milestone / final. Precedence:
//   mandatory orchestrator boundary > Brain requested level > Codex local minimum.
// Codex may escalate verification; it may not silently downgrade the required level.
// Repository-specific commands come from Project Profile / verificationPolicy rather
// than being globally hard-coded.
import { defaultVerificationPolicy } from './task-state.js';

export const VERIFICATION_TIERS = ['step', 'milestone', 'final'];
export const TIER_RANK = { step: 0, milestone: 1, final: 2 };

export function normalizeVerificationPolicy(policy) {
  const base = defaultVerificationPolicy();
  const p = { ...base, ...(policy || {}) };
  if (!Array.isArray(p.fullTestAt)) p.fullTestAt = base.fullTestAt;
  if (!p.stepRules || typeof p.stepRules !== 'object') p.stepRules = {};
  if (!p.milestoneRules || typeof p.milestoneRules !== 'object') p.milestoneRules = { fullTestAt: ['milestone', 'final'] };
  if (!p.finalRules || typeof p.finalRules !== 'object') p.finalRules = { fullTestAt: ['final'] };
  return p;
}

// Effective verification level per the authority precedence. Any of the three
// inputs may be null ("not set"). The effective level is the highest tier among
// those set, which encodes: a Codex minimum may only escalate (never silently
// downgrade), and a mandatory orchestrator boundary always wins.
export function resolveVerificationLevel({ policy = null, mandatory = null, requested = null, codexMinimum = null, docOnly = false }) {
  const p = normalizeVerificationPolicy(policy);
  const levels = [requested, mandatory, codexMinimum].filter((l) => VERIFICATION_TIERS.includes(l));
  let level = p.defaultLevel || 'step';
  for (const l of levels) {
    if (TIER_RANK[l] > TIER_RANK[level]) level = l;
  }
  // Documentation-only steps may use a relevant lightweight tier instead of the
  // full suite where the policy permits. It never overrides an explicit Brain or
  // Codex request, and never drops below a mandatory orchestrator boundary.
  if (docOnly && p.docOnlyTier && VERIFICATION_TIERS.includes(p.docOnlyTier)) {
    const explicitRequest = requested && VERIFICATION_TIERS.includes(requested) && TIER_RANK[requested] > TIER_RANK[p.defaultLevel];
    const explicitMin = codexMinimum && VERIFICATION_TIERS.includes(codexMinimum) && TIER_RANK[codexMinimum] > TIER_RANK[p.defaultLevel];
    if (!explicitRequest && !explicitMin) {
      const floor = (mandatory && VERIFICATION_TIERS.includes(mandatory)) ? TIER_RANK[mandatory] : 0;
      if (TIER_RANK[p.docOnlyTier] >= floor && TIER_RANK[p.docOnlyTier] < TIER_RANK[level]) level = p.docOnlyTier;
    }
  }
  return level;
}

// Does the given level require the full acceptance suite?
export function shouldRunFullSuite({ policy = null, level = 'step', fullTestAt = null }) {
  const p = normalizeVerificationPolicy(policy);
  const set = fullTestAt || p.fullTestAt || [];
  return set.includes(level);
}

// Whether a step level may be downgraded below a required tier without an explicit
// Brain decision. Any downgrade attempt that would lower below the mandatory
// boundary is forbidden.
export function canDowngrade({ mandatory = 'step', requested = 'step', codexMinimum = null }) {
  const floor = TIER_RANK[mandatory] || 0;
  const req = TIER_RANK[requested] || 0;
  if (req < floor) return false;
  // Codex may not silently downgrade below what the Brain requested.
  if (codexMinimum && TIER_RANK[codexMinimum] < req) return false;
  return true;
}

// Documentation-only steps may use a lightweight tier where the policy permits.
export function docOnlyTierAllowed({ policy = null }) {
  const p = normalizeVerificationPolicy(policy);
  return !!p.docOnlyTier && VERIFICATION_TIERS.includes(p.docOnlyTier);
}


// Heuristic: a documentation-only step (or a step explicitly marked docOnly) may
// use a relevant lightweight verification tier where the policy permits.
export function isDocOnlyStep(step) {
  if (!step) return false;
  if (step.docOnly === true) return true;
  const title = String(step.title || step.instruction || '').toLowerCase();
  return /(doc|readme|documentation|changelog|comment)/i.test(title);
}


export class VerificationPolicyError extends Error {
  constructor(msg) { super(msg); this.name = 'VerificationPolicyError'; }
}

// A milestone/final boundary is a mandatory orchestrator boundary.
export function isMandatoryBoundary(level) {
  return level === 'milestone' || level === 'final';
}

// Mandatory milestone/final verification requires executable, repo/task-specific
// command(s). A mandatory boundary with zero commands must NOT become a mere label
// that later lets DONE pass; it raises a deterministic VerificationPolicyError.
export function assertMandatoryVerification({ level = 'step', commands = [] } = {}) {
  if (isMandatoryBoundary(level) && (!Array.isArray(commands) || commands.length === 0)) {
    throw new VerificationPolicyError(`mandatory ${level} verification requires executable commands (got 0)`);
  }
  return true;
}

// Resolve repository-specific verification commands for a level. Commands come from
// the Project Profile / verificationPolicy (`commands` map) — never hard-coded here.
export function resolveVerificationCommands({ level = 'step', policy = null, commands = {} } = {}) {
  const p = normalizeVerificationPolicy(policy);
  const source = commands && typeof commands === 'object' ? commands : {};
  if (Array.isArray(source[level])) return source[level];
  // Fall back to policy rule-level commands if any.
  const rules = p[`${level}Rules`] || {};
  if (Array.isArray(rules.commands)) return rules.commands;
  return [];
}

// Produce a small verification plan for a step.
export function buildVerificationPlan({ policy = null, mandatory = null, requested = 'step', codexMinimum = null, commands = {}, docOnly = false } = {}) {
  const level = resolveVerificationLevel({ policy, mandatory, requested, codexMinimum, docOnly });
  return {
    level,
    fullSuite: shouldRunFullSuite({ policy, level }),
    commands: resolveVerificationCommands({ level, policy, commands }),
  };
}
