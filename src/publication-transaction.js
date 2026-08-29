// chatgpt-codex-orchestrator: GitHub publication transaction (Alpha.4 candidate).
//
// A small, injectable helper for the safe Git/GitHub release sequence used by the
// Direct Brain Loop. NOT a general release platform. It productizes: final
// acceptance gate -> identity preflight -> fetch -> verify origin/main baseline
// -> commit -> re-check remote race -> require fast-forward -> push (no force)
// -> optional tag/Release -> external readback. If origin/main moves unexpectedly
// it STOPS/REPLANs and never force-pushes.

import { checkPublishIdentity, PUBLISH_POLICY_DEFAULTS } from './publish-policy.js';

export function parseRemoteRef(out) {
  const parts = String(out || '').trim().split(/\s+/);
  return parts[0] || '';
}

export function createPublicationTransaction({ gitRun = null, readback = null } = {}) {
  const gr = (args, opts = {}) => { if (!gitRun) throw new Error('publication transaction requires an injectable gitRun'); return gitRun(args, opts); };
  const rb = (info) => { if (!readback) return null; return readback(info); };

  async function run({ repoDir, expectedOriginMain, commitMessage, identity = null, tag = null, acceptanceGateOk = true }) {
    if (!acceptanceGateOk) return { ok: false, step: 'gate', reason: 'final acceptance gate not passed' };

    // 1) identity preflight
    const id = checkPublishIdentity({ repoDir, name: identity?.name, email: identity?.email, run: (args) => gr(args, { repoDir }) });
    if (!id.ok) return { ok: false, step: 'identity', reason: 'publish identity mismatch', actual: id.actual };

    // 2) fetch
    await gr(['fetch', 'origin'], { repoDir });

    // 3) verify origin/main == expected remote baseline
    const pre = parseRemoteRef(await gr(['ls-remote', 'origin', 'refs/heads/main'], { repoDir }));
    if (pre !== expectedOriginMain) return { ok: false, step: 'precommit', reason: 'origin/main moved before commit', expected: expectedOriginMain, actual: pre };

    // 4) create commit
    await gr(['add', '-A'], { repoDir });
    await gr(['commit', '-m', commitMessage], { repoDir });
    const commitSha = (await gr(['rev-parse', 'HEAD'], { repoDir })).trim();

    // 5) re-check remote race before push
    await gr(['fetch', 'origin'], { repoDir });
    const race = parseRemoteRef(await gr(['ls-remote', 'origin', 'refs/heads/main'], { repoDir }));
    if (race !== expectedOriginMain) return { ok: false, step: 'race', reason: 'origin/main moved (race); STOP/REPLAN', expected: expectedOriginMain, actual: race, commit: commitSha };

    // 6) require fast-forward
    let ffOk = true;
    try { await gr(['merge-base', '--is-ancestor', 'origin/main', 'HEAD'], { repoDir }); } catch { ffOk = false; }
    if (!ffOk) return { ok: false, step: 'fastforward', reason: 'cannot fast-forward', commit: commitSha };

    // 7) push without force
    await gr(['push', 'origin', 'HEAD'], { repoDir });

    // 8) optional tag / GitHub Release action
    let tagSha = null;
    if (tag) {
      await gr(['tag', tag, commitSha], { repoDir });
      await gr(['push', 'origin', tag], { repoDir });
      tagSha = commitSha;
    }

    // 9) external readback (external observable evidence)
    const external = await rb({ repoDir, expectedCommit: commitSha, tag });
    const externalReadback = !!(external && external.remoteMainSha === commitSha && (!tag || external.tagSha === commitSha));

    return { ok: true, step: 'done', commit: commitSha, tagSha, externalReadback, external };
  }

  return { run, defaults: PUBLISH_POLICY_DEFAULTS, parseRemoteRef };
}

// A DONE can only follow a publication that returned external observable evidence.
export function publicationReadyForDone(result) {
  return !!(result && result.ok && result.externalReadback);
}

// Build the structured external evidence carried in the publication RESULT for
// Brain review (remote main SHA, tag SHA, Release existence/draft/prerelease,
// title/body metadata). Injected readback supplies these.
export function buildExternalEvidence({ remoteMainSha, tagSha, release } = {}) {
  return {
    kind: 'external_observable',
    remoteMainSha: remoteMainSha || null,
    tagSha: tagSha || null,
    release: release || { exists: false, draft: false, prerelease: false, title: null, body: null },
  };
}
