import {
  StableRuntimeActivator as BaseStableRuntimeActivator,
  StableRuntimeActivationError,
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
  }

  async _probeLocal(baseUrl) {
    const result = await super._probeLocal(baseUrl);
    this._latestLocalProbe = result;
    return result;
  }

  async _validateRollbackState(state, context) {
    const validated = await super._validateRollbackState(state, context);
    const healthRevision = exactRevision(this._latestLocalProbe?.health?.body?.revision);
    const readyRevision = exactRevision(this._latestLocalProbe?.ready?.body?.revision);

    if (!validated) {
      this.rollbackEvidence = {
        status: 'no_safe_rollback',
        reason: 'no_valid_exact_clean_same_profile_activation_state',
        healthRevision,
        readyRevision,
      };
      return null;
    }

    if (!healthRevision || !readyRevision || healthRevision !== readyRevision) {
      this.rollbackEvidence = {
        status: 'no_safe_rollback',
        reason: 'serving_revision_not_exactly_proven',
        candidateSha: validated.sha,
        candidateCheckout: validated.checkout,
        healthRevision,
        readyRevision,
      };
      return null;
    }

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

  async activate(args) {
    this.rollbackEvidence = null;
    this._latestLocalProbe = null;
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
