import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeApproval,
  isApprovalMethod,
  mapDecision,
  approvalKind,
  SUPPORTED_BINARY_METHODS,
  APPROVAL_DECISIONS,
  ApprovalError,
  UnsupportedApprovalMethodError,
} from '../../src/executor/approval.js';

test('isApprovalMethod recognizes requestApproval methods', () => {
  assert.equal(isApprovalMethod('item/commandExecution/requestApproval'), true);
  assert.equal(isApprovalMethod('item/fileChange/requestApproval'), true);
  assert.equal(isApprovalMethod('item/permissions/requestApproval'), true);
  assert.equal(isApprovalMethod('item/tool/requestUserInput'), true);
  assert.equal(isApprovalMethod('applyPatchApproval'), true);
  assert.equal(isApprovalMethod('execCommandApproval'), true);
  assert.equal(isApprovalMethod('thread/start'), false);
  assert.equal(isApprovalMethod('turn/start'), false);
});

test('normalizeApproval preserves identity and params', () => {
  const a = normalizeApproval({ id: 'req-1', method: 'item/commandExecution/requestApproval', params: { threadId: 't1', turnId: 'u1', itemId: 'i1', reason: 'x', command: 'echo hi', availableDecisions: ['accept', 'decline'] } });
  assert.ok(a);
  assert.equal(a.approvalId, 'req-1');
  assert.equal(a.requestId, 'req-1');
  assert.equal(a.kind, 'command');
  assert.equal(a.threadId, 't1');
  assert.equal(a.turnId, 'u1');
  assert.equal(a.itemId, 'i1');
  assert.equal(a.method, 'item/commandExecution/requestApproval');
  assert.deepEqual(a.availableDecisions, ['accept', 'decline']);
});

test('normalizeApproval returns null for non-approval server requests', () => {
  assert.equal(normalizeApproval({ id: 'x', method: 'initialize', params: {} }), null);
});

test('approvalKind classifies methods', () => {
  assert.equal(approvalKind('item/commandExecution/requestApproval'), 'command');
  assert.equal(approvalKind('item/fileChange/requestApproval'), 'file-change');
  assert.equal(approvalKind('item/permissions/requestApproval'), 'permissions');
  assert.equal(approvalKind('item/tool/requestUserInput'), 'user-input');
});

test('mapDecision maps approve/deny to accept/decline for command approval', () => {
  assert.deepEqual(mapDecision({ method: 'item/commandExecution/requestApproval', decision: 'approve' }), { decision: 'accept' });
  assert.deepEqual(mapDecision({ method: 'item/commandExecution/requestApproval', decision: 'deny' }), { decision: 'decline' });
});

test('mapDecision maps approve/deny to accept/decline for file change approval', () => {
  assert.deepEqual(mapDecision({ method: 'item/fileChange/requestApproval', decision: 'approve' }), { decision: 'accept' });
  assert.deepEqual(mapDecision({ method: 'item/fileChange/requestApproval', decision: 'deny' }), { decision: 'decline' });
});

test('mapDecision fails closed for unsupported non-binary methods', () => {
  assert.throws(() => mapDecision({ method: 'item/permissions/requestApproval', decision: 'approve' }), UnsupportedApprovalMethodError);
  assert.throws(() => mapDecision({ method: 'item/tool/requestUserInput', decision: 'approve' }), UnsupportedApprovalMethodError);
  assert.throws(() => mapDecision({ method: 'applyPatchApproval', decision: 'approve' }), UnsupportedApprovalMethodError);
  assert.throws(() => mapDecision({ method: 'execCommandApproval', decision: 'deny' }), UnsupportedApprovalMethodError);
});

test('invalid decision fails closed', () => {
  assert.throws(() => mapDecision({ method: 'item/commandExecution/requestApproval', decision: 'maybe' }), ApprovalError);
});

test('SUPPORTED_BINARY_METHODS is limited to the two item requestApproval methods', () => {
  assert.deepEqual(SUPPORTED_BINARY_METHODS, ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);
});

test("APPROVAL_DECISIONS is ['approve','deny']", () => {
  assert.deepEqual(APPROVAL_DECISIONS, ['approve', 'deny']);
});
