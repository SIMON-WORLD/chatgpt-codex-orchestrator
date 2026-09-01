// chatgpt-codex-orchestrator: approval normalization + response mapping (v0.2 M1).
// App Server pushes server-initiated approval requests (ServerRequest) with an `id`.
// We preserve that `id` as the approval identity (approvalId) and map an approve/deny
// decision back to a JSON-RPC response with the same `id`. Unknown/stale ids fail
// closed. We never bypass Codex approval semantics.
//
// Authority: codex app-server generate-ts (codex-cli 0.146.0) ServerRequest union.

export const APPROVAL_DECISIONS = ['approve', 'deny'];

export class ApprovalError extends Error {
  constructor(msg) { super(msg); this.name = 'ApprovalError'; }
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
  };
}

export function buildApprovalResponse({ decision, approval }) {
  if (!APPROVAL_DECISIONS.includes(decision)) throw new ApprovalError(`invalid decision: ${decision}`);
  return { decision, approved: decision === 'approve' };
}
