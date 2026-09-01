// chatgpt-codex-orchestrator: approval normalization + wire-response mapping
// (v0.2 M1). App Server pushes server-initiated approval requests (ServerRequest)
// with an `id` and method-specific params. We preserve the `id` as the approval
// identity and map an orchestrator-facing `approve | deny` API to the exact
// method-specific App Server response.
//
// Authority: `codex app-server generate-ts --experimental` (codex-cli 0.146.0).
//
// Supported binary approvals (M1):
//   - item/commandExecution/requestApproval ->
//       CommandExecutionRequestApprovalResponse { decision: 'accept' | 'decline' }
//   - item/fileChange/requestApproval ->
//       FileChangeRequestApprovalResponse { decision: 'accept' | 'decline' }
//
// NOT binary (M1 does NOT force them through approve/deny):
//   - item/permissions/requestApproval  -> { permissions, scope } (not binary)
//   - item/tool/requestUserInput        -> not an approve/deny operation
//   - applyPatchApproval / execCommandApproval -> ReviewDecision (legacy, not same)
// These are surfaced + recorded but fail closed in respondApproval.

export const APPROVAL_DECISIONS = ['approve', 'deny'];

export const SUPPORTED_BINARY_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
];

export class ApprovalError extends Error {
  constructor(msg) { super(msg); this.name = 'ApprovalError'; }
}

export class UnsupportedApprovalMethodError extends ApprovalError {
  constructor(method) {
    super(`approval method '${method}' is not a supported binary approve/deny in M1; refusing to guess`);
    this.name = 'UnsupportedApprovalMethodError';
    this.method = method;
  }
}

const REQUEST_APPROVAL_RE = /requestApproval$/i;

export function isApprovalMethod(method) {
  if (!method) return false;
  return REQUEST_APPROVAL_RE.test(method) ||
    method === 'applyPatchApproval' ||
    method === 'execCommandApproval' ||
    method === 'item/tool/requestUserInput';
}

export function approvalKind(method) {
  if (method === 'applyPatchApproval' || method === 'item/fileChange/requestApproval') return 'file-change';
  if (method === 'execCommandApproval' || method === 'item/commandExecution/requestApproval') return 'command';
  if (method === 'item/tool/requestUserInput') return 'user-input';
  if (method === 'item/permissions/requestApproval') return 'permissions';
  return 'unknown';
}

export function normalizeApproval(serverRequest) {
  if (!serverRequest || !isApprovalMethod(serverRequest.method)) return null;
  const p = serverRequest.params || {};
  return {
    approvalId: String(serverRequest.id === undefined || serverRequest.id === null ? '' : serverRequest.id),
    requestId: serverRequest.id,
    method: serverRequest.method,
    kind: approvalKind(serverRequest.method),
    threadId: p.threadId || null,
    turnId: p.turnId || null,
    itemId: p.itemId || null,
    reason: p.reason || null,
    availableDecisions: Array.isArray(p.availableDecisions) ? p.availableDecisions.slice() : null,
  };
}

// Map orchestrator-facing `approve | deny` to the exact App Server wire response.
export function mapDecision({ method, decision }) {
  if (!APPROVAL_DECISIONS.includes(decision)) throw new ApprovalError(`invalid decision: ${decision}`);
  if (!SUPPORTED_BINARY_METHODS.includes(method)) throw new UnsupportedApprovalMethodError(method);
  const wire = decision === 'approve' ? 'accept' : 'decline';
  return { decision: wire };
}
