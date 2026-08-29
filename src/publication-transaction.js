// chatgpt-codex-orchestrator: Git publication transaction (Alpha.4 candidate).
//
// A small, injectable Git helper for the safe main-publication sequence used by the
// Direct Brain Loop. It is NOT a release platform and does NOT create a GitHub
// Release by itself: the Release action and the external readback are supplied
// (injected) by the caller. The helper guarantees: final acceptance gate ->
// identity preflight -> fetch -> verify origin/main baseline -> commit -> re-check
// remote race -> require fast-forward -> explicit push to HEAD:refs/heads/main
// (never force) -> optional tag -> externally-supplied readback. If origin/main
// moves unexpectedly it STOPS/REPLANs and never force-pushes.

import { checkPublishIdentity, PUBLISH_POLICY_DEFAULTS } from './publish-policy.js';

export function parseRemoteRef(out) {
  const parts = String(out || '').trim().split(/\s+/);
  return parts[0] || '';
}

// Declarative external observable gate. Requires the main SHA to match, the tag
// SHA to match when a tag is in play, and (when a Release is declared as
// required) the declared Release properties to hold: exists, draft/prerelease,
// title, and any critical body assertion substrings. This catches the class of
// error where git/tag are correct but the GitHub Release metadata/text is wrong.
export function checkExternalReadback({ external = null, expectedCommit = null, tag = null, tagSha = null, requiredRelease = null } = {}) {
  if (!external) return false;
  if (!expectedCommit || external.remoteMainSha !== expectedCommit) return false;
  if (tag && (!external.tagSha || external.tagSha !== (tagSha || expectedCommit))) return false;
  if (requiredRelease) {
    const rel = external.release || {};
    if (requiredRelease.exists === true && rel.exists !== true) return false;
    if (typeof requiredRelease.draft === 'boolean' && rel.draft !== requiredRelease.draft) return false;
    if (typeof requiredRelease.prerelease === 'boolean' && rel.prerelease !== requiredRelease.prerelease) return false;
    if (requiredRelease.title && rel.title !== requiredRelease.title) return false;
    if (Array.isArray(requiredRelease.bodyContains)) {
      const body = rel.body || '';
      if (!requiredRelease.bodyContains.every((s) => body.includes(s))) return false;
    }
  }
  return true;
}

export function createPublicationTransaction({ gitRun = null, readback = null } = {}) {
  const gr = (args, opts = {}) => { if (!gitRun) throw new Error('publication transaction requires an injectable gitRun'); return gitRun(args, opts); };
  const rb = (info) => { if (!readback) return null; return readback(info); };

  async function run({ repoDir, expectedOriginMain, targetBranch = 'main', commitMessage, identity = null, tag = null, requiredRelease = null, acceptanceGateOk = true }) {
    if (!acceptanceGateOk) return { ok: false, step: 'gate', reason: 'final acceptance gate not passed' };

    // capture current branch (never silently publish a feature branch)
    let currentBranch = null;
    try { currentBranch = (await gr(['rev-parse', '--abbrev-ref', 'HEAD'], { repoDir })).trim(); } catch { currentBranch = null; }

    // 1) identity preflight
    const id = checkPublishIdentity({ repoDir, name: identity?.name, email: identity?.email, run: (args) => gr(args, { repoDir }) });
    if (!id.ok) return { ok: false, step: 'identity', reason: 'publish identity mismatch', actual: id.actual, currentBranch };

    // 2) fetch
    await gr(['fetch', 'origin'], { repoDir });

    // 3) verify origin/main == expected remote baseline
    const pre = parseRemoteRef(await gr(['ls-remote', 'origin', 'refs/heads/main'], { repoDir }));
    if (pre !== expectedOriginMain) return { ok: false, step: 'precommit', reason: 'origin/main moved before commit', expected: expectedOriginMain, actual: pre, currentBranch };

    // 4) create commit
    await gr(['add', '-A'], { repoDir });
    await gr(['commit', '-m', commitMessage], { repoDir });
    const commitSha = (await gr(['rev-parse', 'HEAD'], { repoDir })).trim();

    // 5) re-check remote race immediately before push
    await gr(['fetch', 'origin'], { repoDir });
    const race = parseRemoteRef(await gr(['ls-remote', 'origin', 'refs/heads/main'], { repoDir }));
    if (race !== expectedOriginMain) return { ok: false, step: 'race', reason: 'origin/main moved (race); STOP/REPLAN', expected: expectedOriginMain, actual: race, commit: commitSha, currentBranch };

    // 6) require fast-forward
    let ffOk = true;
    try { await gr(['merge-base', '--is-ancestor', 'origin/main', 'HEAD'], { repoDir }); } catch { ffOk = false; }
    if (!ffOk) return { ok: false, step: 'fastforward', reason: 'cannot fast-forward', commit: commitSha, currentBranch };

    // 7) push explicitly to refs/heads/<targetBranch> (never force, never follow current branch)
    await gr(['push', 'origin', `HEAD:refs/heads/${targetBranch}`], { repoDir });

    // 8) optional tag (Git publication only; a Release action is externally supplied)
    let tagSha = null;
    if (tag) {
      await gr(['tag', tag, commitSha], { repoDir });
      await gr(['push', 'origin', tag], { repoDir });
      tagSha = commitSha;
    }

    // 9) external readback (externally supplied; verifies declared observables)
    const external = await rb({ repoDir, expectedCommit: commitSha, tag, requiredRelease });
    const externalReadback = checkExternalReadback({ external, expectedCommit: commitSha, tag, tagSha, requiredRelease });

    return { ok: true, step: 'done', commit: commitSha, tagSha, currentBranch, targetBranch, externalReadback, external };
  }

  return { run, defaults: PUBLISH_POLICY_DEFAULTS, parseRemoteRef };
}

// A terminal DONE can only follow a publication that returned the required
// external observable evidence.
export function publicationReadyForDone(result) {
  return !!(result && result.ok && result.externalReadback);
}

// Structured external evidence carried in the publication RESULT for Brain review
// (remote main SHA, tag SHA, Release existence/draft/prerelease, title/body).
export function buildExternalEvidence({ remoteMainSha, tagSha, release } = {}) {
  return {
    kind: 'external_observable',
    remoteMainSha: remoteMainSha || null,
    tagSha: tagSha || null,
    release: release || { exists: false, draft: false, prerelease: false, title: null, body: null },
  };
}
