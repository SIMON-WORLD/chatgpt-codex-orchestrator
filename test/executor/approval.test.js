import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApproval, isApprovalMethod, buildApprovalResponse, APPROVAL_DECISIONS, ApprovalError } from '../../src/executor/approval.js';

test('isApprovalMethod recognizes requestApproval methods', () => {
  assert.equal(isApprovalMethod('item/commandExecution/requestApproval'), true);
  assert.equal(isApprovalMethod('item/fileChange/requestApproval'), true);
  assert.equal(isApprovalMethod('item/permissions/requestApproval'), true);
  assert.equal(isApprovalMethod('applyPatchApproval'), true);
  assert.equal(isApprovalMethod('execCommandApproval'), true);
  assert.equal(isApprovalMethod('thread/start'), false);
  assert.equal(isApprovalMethod('turn/start'), false);
});

test('normalizeApproval preserves identity and params', () => {
  const a = normalizeApproval({ id: 'req-1', method: 'item/commandExecution/requestApproval', params: { threadId: 't1', turnId: 'u1', itemId: 'i1', reason: 'x', command: 'echo hi' } });
  assert.ok(a);
  assert.equal(a.approvalId, 'req-1');
  assert.equal(a.requestId, 'req-1');
  assert.equal(a.kind, 'command');
  assert.equal(a.threadId, 't1');
  assert.equal(a.method, 'item/commandExecution/requestApproval');
});

test('normalizeApproval returns null for non-approval server requests', () => {
  assert.equal(normalizeApproval({ id: 'x', method: 'initialize', params: {} }), null);
});

test('buildApprovalResponse maps approve/deny', () => {
  assert.deepEqual(buildApprovalResponse({ decision: 'approve', approval: { approvalId: 'req-1' } }), { decision: 'approve', approved: true });
  assert.deepEqual(buildApprovalResponse({ decision: 'deny', approval: { approvalId: 'req-1' } }), { decision: 'deny', approved: false });
});

test('invalid decision fails closed', () => {
  assert.throws(() => buildApprovalResponse({ decision: 'maybe', approval: { approvalId: 'req-1' } }), ApprovalError);
});

test("APPROVAL_DECISIONS is ['approve','deny']", () => {
  assert.deepEqual(APPROVAL_DECISIONS, ['approve', 'deny']);
});
