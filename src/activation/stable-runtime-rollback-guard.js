import path from 'node:path';
import {
  StableRuntimeActivator as BaseStableRuntimeActivator,
  StableRuntimeActivationError,
  deriveActivationRoot,
} from './stable-runtime-activator.js';

const EXACT_SHA_RE = /^[0-9a-f]{40}$/i;

function exactRevision(value) {
  const revision = String(value || '').trim().toLowerCase();
  return EXACT_SHA_RE.test(revision) ? revision : null;
}

export { StableRuntimeActivationError };

export class StableRuntimeActivator extends BaseStableRuntimeActivator {
  constructor(options = {}) {
    super(options);
    this.rollbackEvidence = null;
    this._latestLocalProbe = null;
    this._trustedRepo = null;
  }

  _resolveTrustedRepo(config, repoPath) {
    const repo = super._resolveTrustedRepo(config, repoPath);
    this._trustedRepo = repo;
    return repo;
  }

  async _probeLocal(baseUrl) {
    const result = await super._probeLocal(baseUrl);
    this._latestLocalProbe = result;
    return result;
  }

  async _exactCleanInferredCheckout(checkout, revision) {
    if (!checkout || !this.fs.existsSync(checkout) || !this.fs.existsSync(path.join(checkout, 'node_modules'))) return null;
    try {
      const head = (await this.run('git', ['-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim().toLowerCase();
      const dirty = (await this.run('git', ['-C', checkout, 'status', '--porcelain'])).stdout.trim();
      if (head !== revision || dirty) return null;
      await this.run('git', ['-C', checkout, 'merge-base', '--is-ancestor', revision, 'origin/main']);
      return checkout;
    } catch { return null; }
  }

  async _validateRollbackState(state, context) {
    const validated = await super._validateRollbackState(state, context);
    const healthRevision = exactRevision(this._latestLocalProbe?.health?.body?.revision);
    const readyRevision = exactRevision(this._latestLocalProbe?.ready?.body?.revision);

    if (!healthRevision || !readyRevision || healthRevision !== readyRevision) {
      this.rollbackEvidence = {
        status: 'no_safe_rollback',
        reason: 'serving_revision_not_exactly_proven',
        candidateSha: validated?.sha || null,
        candidateCheckout: validated?.checkout || null,
        healthRevision,
        readyRevision,
      };
      return null;
    }

    if (validated) {
      if (healthRevision !== validated.sha) {
        this.rollbackEvidence = {
          status: 'no_safe_rollback',
          reason: 'serving_revision_does_not_match_validated_same_profile_state',
          candidateSha: validated.sha,
          candidateCheckout: validated.checkout,
          healthRevision,
          readyRevision,
        };
        return null;
      }
      this.rollbackEvidence = {
        status: 'provisional_safe',
        source: 'serving_revision_plus_validated_exact_clean_same_profile_state',
        sha: validated.sha,
        checkout: validated.checkout,
        healthRevision,
        readyRevision,
      };
      return validated;
    }

    const candidates = this._trustedRepo
      ? [path.join(deriveActivationRoot(this._trustedRepo), healthRevision), this._trustedRepo]
      : [];
    for (const checkout of candidates) {
      const exactClean = await this._exactCleanInferredCheckout(checkout, healthRevision);
      if (!exactClean) continue;
      const provisional = {
        version: 1,
        sha: healthRevision,
        checkout: exactClean,
        configPath: context.configPath,
        profileFingerprint: context.fingerprint,
        activatedAt: 'provisional-serving-binding',
      };
      this.rollbackEvidence = {
        status: 'provisional_safe',
        source: 'serving_revision_plus_exact_clean_checkout_current_profile',
        sha: healthRevision,
        checkout: exactClean,
        healthRevision,
        readyRevision,
      };
      return provisional;
    }

    this.rollbackEvidence = {
      status: 'no_safe_rollback',
      reason: 'no_exact_clean_prepared_checkout_for_proven_serving_revision',
      healthRevision,
      readyRevision,
    };
    return null;
  }

  async activate(args) {
    this.rollbackEvidence = null;
    this._latestLocalProbe = null;
    this._trustedRepo = null;
    try {
      const result = await super.activate(args);
      return {
        ...result,
        rollbackEvidence: this.rollbackEvidence || {
          status: 'not_required',
          reason: result?.alreadyActive ? 'target_already_active' : 'no_cutover_rollback_assessment',
        },
      };
    } catch (error) {
      if (!(error instanceof StableRuntimeActivationError) || !this.rollbackEvidence) throw error;
      throw new StableRuntimeActivationError(error.message, { ...error.details, rollbackEvidence: this.rollbackEvidence });
    }
  }
}
