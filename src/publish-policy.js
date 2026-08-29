// chatgpt-codex-orchestrator: publish policy helpers for the Direct Brain Loop.
// Browser-agnostic helpers invoked at publish time (after Brain DONE).

import { execFileSync } from 'node:child_process';

// Canonical publish defaults: never force-push, never rewrite published history,
// always require a clean fast-forward.
export const PUBLISH_POLICY_DEFAULTS = {
  forcePush: false,
  rewriteHistory: false,
  requireFastForward: true,
};

function defaultGitRun(args, repoDir) {
  return execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' });
}

// If an expected git identity (name/email) is configured, set it repo-local BEFORE
// committing so the author identity is correct (do not wait for a failing push to
// amend). Returns { configured, name, email }.
export function configureGitIdentity({ repoDir, name = null, email = null, run = null } = {}) {
  if (!name && !email) return { configured: false, name: null, email: null };
  const doRun = run || ((args) => defaultGitRun(args, repoDir));
  if (name) doRun(['config', 'user.name', name]);
  if (email) doRun(['config', 'user.email', email]);
  return { configured: true, name, email };
}

// Preflight: verify the commit author identity. Configures the expected identity
// first (if provided), then reads the effective repo-local identity and checks it
// matches. Returns { ok, applied, expected, actual }.
export function checkPublishIdentity({ repoDir, name = null, email = null, run = null } = {}) {
  const applied = configureGitIdentity({ repoDir, name, email, run });
  const doRun = run || ((args) => defaultGitRun(args, repoDir));
  let actualName = null;
  let actualEmail = null;
  try { actualName = String(doRun(['config', 'user.name']) || '').trim() || null; } catch (e) { actualName = null; }
  try { actualEmail = String(doRun(['config', 'user.email']) || '').trim() || null; } catch (e) { actualEmail = null; }
  const ok = (!name || actualName === name) && (!email || actualEmail === email);
  return { ok, applied, expected: { name, email }, actual: { name: actualName, email: actualEmail } };
}

// Post-DONE boundary: after Brain DONE, the target repo must NOT receive new
// product modifications that were not Brain-reviewed. Independent workspace
// bookkeeping/logging is allowed as long as it does not change the accepted
// target-repo outcome.
export function isPostDoneModificationAllowed({ changesTargetRepoOutcome }) {
  return !changesTargetRepoOutcome;
}
