// Bounded diagnostic wrapper for codex_recovery_reconcile_preflight.
//
// This module deliberately reuses the existing dangerous-candidate selector and the
// AppServerExecutor authoritative observation/remediation primitives. It adds only a
// stable aggregate failure taxonomy for reconciliation_unresolved responses. Candidate
// identities, timestamps, lists, and raw App Server error text are never returned.

export const RECOVERY_DIAGNOSTIC_CATEGORIES = Object.freeze([
  'missing_thread_identity',
  'resume_failed',
  'resume_no_thread_identity',
  'read_failed',
  'turn_binding_none',
  'turn_binding_multiple',
  'lifecycle_unreadable',
]);

export function classifyRecoveryObservationFailure(reason) {
  const value = String(reason || '');
  if (value === 'no thread identity to reconcile') return 'missing_thread_identity';
  if (value.startsWith('resume failed:')) return 'resume_failed';
  if (value === 'thread/resume returned no thread id') return 'resume_no_thread_identity';
  if (value.startsWith('thread/read failed:')) return 'read_failed';
  if (value === 'multiple candidate turns for current mutation unit') return 'turn_binding_multiple';
  if (value === 'no current mutation unit' || value === 'no candidate turn for current mutation unit') return 'turn_binding_none';
  return 'lifecycle_unreadable';
}

function incrementReasonCount(reasonCounts, category) {
  reasonCounts[category] = (reasonCounts[category] || 0) + 1;
}

// Keep the existing remediation semantics intact while adding aggregate diagnostics:
// - exact same recoveryPreflightCandidates() selection;
// - exact same thread/resume + thread/read observation primitive;
// - exact same terminal/in-progress durable updates;
// - no start/continue/interrupt/unlock/list/most-recent behavior.
export async function reconcileRecoveryPreflightWithDiagnostics(executor, { workspaceId = null, workspaceRoot = null, taskId = null, stepId = null, identity = null } = {}) {
  const args = { workspaceId, workspaceRoot, taskId, stepId, identity };
  const selected = executor.jobMap.recoveryPreflightCandidates(args);
  if (!selected.ok) return selected;
  if (selected.dangerous.length === 0) return executor.jobMap.recoveryPreflight(args);

  await executor._ensureConnected();
  let unresolvedCandidateCount = 0;
  const reasonCounts = {};

  for (const { job } of selected.dangerous) {
    const observed = await executor._authoritativeObserveLifecycle(job);
    if (!observed.ok) {
      unresolvedCandidateCount += 1;
      incrementReasonCount(reasonCounts, classifyRecoveryObservationFailure(observed.reason));
      continue;
    }

    if (observed.resolution === 'terminal') {
      if (executor._isWriter(job) && executor.owner.owner === 'codex' && executor.owner.unitId === (job.mutationUnitId || null)) {
        executor._releaseUnitOnTerminal(job, observed.state);
      } else {
        executor.jobMap.update(job.jobId, { state: observed.state, ownershipReleased: executor.owner.owner === 'none', updatedAt: Date.now() });
      }
    } else if (observed.resolution === 'in_progress') {
      executor.jobMap.update(job.jobId, { state: 'running', ownershipReleased: false, updatedAt: Date.now() });
    }
  }

  if (unresolvedCandidateCount > 0) {
    return {
      ok: false,
      error: 'reconciliation_unresolved',
      reason: 'one or more hidden recovery-risk executions could not be authoritatively reconciled; refusing to infer safety',
      unresolvedCandidateCount,
      reasonCounts,
    };
  }

  const after = executor.jobMap.recoveryPreflight(args);
  if (after.ok && after.status === 'recover_existing' && after.dangerousCandidateCount === 1 && after.recovery && after.recovery.jobId) {
    return {
      ...after,
      nextAction: 'codex_reconcile',
      recovery: { ...after.recovery, mode: 'job_id' },
    };
  }
  return after;
}
