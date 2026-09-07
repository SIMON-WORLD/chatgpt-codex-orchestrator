import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startMcpServer } from '../../src/mcp/server.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { createDurableGovernanceService } from '../../src/governance/durable.js';
import { MutationOwner } from '../../src/state/mutation-owner.js';
import { OperationState } from '../../src/state/operation-state.js';

function textOf(res) {
  const item = res && res.content && res.content.find((c) => c.type === 'text');
  return item ? item.text : '';
}

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  return { res, text: textOf(res) };
}

function fixture() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'issue34-mcp-'));
  const repo = path.join(dataRoot, 'repo');
  const other = path.join(dataRoot, 'other');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello world', 'utf8');
  return { dataRoot, repo, other, namespace: 'default' };
}

async function startContext({ dataRoot, repo, other, namespace, withCodexStub = false }) {
  const registry = new WorkspaceRegistry({ allowedRoots: [dataRoot] });
  const governance = createDurableGovernanceService({ dataRoot, namespace });
  const owner = new MutationOwner();
  const operations = new OperationState({ dataRoot });
  let codexStartCalls = 0;
  const executor = withCodexStub ? {
    owner,
    jobMap: { recoveryPreflight() { return { ok: true, dangerousCandidateCount: 0 }; } },
    async reconcileRecoveryPreflight() { return { ok: true, dangerousCandidateCount: 0 }; },
    async start() { codexStartCalls += 1; return { jobId: 'should-not-start' }; },
    load() { throw new Error('not used'); },
    async get() { throw new Error('not used'); },
    async continue() { throw new Error('not used'); },
    async interrupt() { throw new Error('not used'); },
    async reconcile() { throw new Error('not used'); },
    async respondApproval() { throw new Error('not used'); },
    async recover() { throw new Error('not used'); },
  } : null;
  const verifyChecks = {
    effectful: {
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      effect: 'workspace_effect',
      timeoutMs: 5000,
    },
  };
  const srv = await startMcpServer({
    workspaceRegistry: registry,
    governanceService: governance,
    appServerExecutor: executor,
    mutationOwner: owner,
    operationState: operations,
    verifyChecks,
    host: '127.0.0.1',
    port: 0,
    allowedRoots: [dataRoot],
  });
  const client = new Client({ name: 'issue34-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  return {
    registry,
    governance,
    owner,
    executor,
    srv,
    client,
    get codexStartCalls() { return codexStartCalls; },
    repo,
    other,
  };
}

async function closeContext(ctx) {
  try { await ctx.client.close(); } catch {}
  try { await ctx.srv.close(); } catch {}
  try { ctx.governance.close(); } catch {}
}

test('Issue #34: fresh bounded session recovers, claims, applies/verifies, records SAME-step RESULT without Parent takeover', async (t) => {
  const f = fixture();
  const ctx1 = await startContext(f);
  t.after(() => closeContext(ctx1));

  const ws1 = JSON.parse((await call(ctx1.client, 'workspace_open', { path: f.repo })).text);
  const plan = JSON.parse((await call(ctx1.client, 'governance_transition', {
    taskId: 't1',
    control: 'PLAN',
    projectKey: 'repo/x',
    identity: 'issue-34',
    workspaceId: ws1.workspaceId,
  })).text);
  const parentToken = plan.authorityToken;
  assert.ok(parentToken);
  const task = JSON.parse((await call(ctx1.client, 'governance_transition', {
    taskId: 't1',
    stepId: 's1',
    control: 'TASK',
    route: 'CHATGPT_DIRECT_LOCAL',
    acceptance: [{ id: 'a1', required: true }],
    authorityToken: parentToken,
    workspaceId: ws1.workspaceId,
  })).text);
  assert.equal(task.ok, true);
  assert.equal(task.authority.generation, 0);

  // Conversation/session rollover: durable task remains, Parent stays elsewhere.
  await closeContext(ctx1);
  const ctx2 = await startContext({ ...f, withCodexStub: true });
  t.after(() => closeContext(ctx2));
  const ws2 = JSON.parse((await call(ctx2.client, 'workspace_open', { path: f.repo })).text);
  const wsOther = JSON.parse((await call(ctx2.client, 'workspace_open', { path: f.other })).text);

  const tools = await ctx2.client.listTools();
  assert.ok(tools.tools.some((x) => x.name === 'governance_claim_execution'));

  const recovered = JSON.parse((await call(ctx2.client, 'governance_recover', { projectKey: 'repo/x', identity: 'issue-34' })).text);
  assert.equal(recovered.taskId, 't1');

  const wrongWorkspace = await call(ctx2.client, 'governance_claim_execution', {
    projectKey: 'repo/x', identity: 'issue-34', stepId: 's1', workspaceId: wsOther.workspaceId,
  });
  assert.equal(wrongWorkspace.res.isError, true);
  assert.match(wrongWorkspace.text, /workspace_mismatch/);

  const claim1 = JSON.parse((await call(ctx2.client, 'governance_claim_execution', {
    projectKey: 'repo/x', identity: 'issue-34', stepId: 's1', workspaceId: ws2.workspaceId,
  })).text);
  assert.equal(claim1.authority.generation, 0);
  assert.equal(claim1.executionClaim.generation, 1);
  const token1 = claim1.executionToken;

  const read1 = JSON.parse((await call(ctx2.client, 'read', { workspaceId: ws2.workspaceId, path: 'a.txt' })).text);
  const preview = JSON.parse((await call(ctx2.client, 'edit', {
    workspaceId: ws2.workspaceId,
    mode: 'preview',
    change: {
      path: 'a.txt',
      baseHash: read1.sha256,
      replacements: [{ oldText: 'world', newText: 'there' }],
    },
  })).text);
  assert.ok(preview.changeSetId);

  // A newer bounded session claim fences the older claim without touching Parent auth.
  const claim2 = JSON.parse((await call(ctx2.client, 'governance_claim_execution', {
    taskId: 't1', stepId: 's1', workspaceId: ws2.workspaceId,
  })).text);
  assert.equal(claim2.authority.generation, 0);
  assert.equal(claim2.executionClaim.generation, 2);
  assert.notEqual(claim2.executionToken, token1);
  const token2 = claim2.executionToken;

  const staleApply = await call(ctx2.client, 'edit', {
    workspaceId: ws2.workspaceId,
    mode: 'apply',
    changeSetId: preview.changeSetId,
    taskId: 't1',
    executionToken: token1,
  });
  assert.equal(staleApply.res.isError, true);
  assert.match(staleApply.text, /stale_execution_claim/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'a.txt'), 'utf8'), 'hello world');

  const staleVerify = await call(ctx2.client, 'verify', {
    workspaceId: ws2.workspaceId,
    check: 'effectful',
    taskId: 't1',
    executionToken: token1,
  });
  assert.equal(staleVerify.res.isError, true);
  assert.match(staleVerify.text, /stale_execution_claim/);

  const staleResult = await call(ctx2.client, 'governance_record_result', {
    taskId: 't1', stepId: 's1', executionToken: token1, executorStatus: 'success',
  });
  assert.equal(staleResult.res.isError, true);
  assert.match(staleResult.text, /stale_execution_claim/);

  // Claim token cannot be repurposed as Parent authority for control or takeover.
  const control = await call(ctx2.client, 'governance_transition', {
    taskId: 't1', stepId: 's1', control: 'REVISE', authorityToken: token2,
  });
  assert.equal(control.res.isError, true);
  assert.match(control.text, /stale_authority/);

  const takeover = await call(ctx2.client, 'governance_takeover', {
    taskId: 't1', authorityToken: token2, workspaceId: ws2.workspaceId,
  });
  assert.equal(takeover.res.isError, true);
  assert.match(takeover.text, /stale_authority/);

  // Nor can it authorize a new Codex turn: codex_start still requires Parent token.
  const codex = await call(ctx2.client, 'codex_start', {
    workspaceId: ws2.workspaceId,
    prompt: 'must not run',
    accessMode: 'workspace_write',
    taskId: 't1',
    stepId: 's1',
    executionToken: token2,
  });
  assert.equal(codex.res.isError, true);
  assert.match(codex.text, /stale_authority/);
  assert.equal(ctx2.codexStartCalls, 0);

  const wrongStep = await call(ctx2.client, 'governance_record_result', {
    taskId: 't1', stepId: 'wrong', executionToken: token2, executorStatus: 'success',
  });
  assert.equal(wrongStep.res.isError, true);
  assert.match(wrongStep.text, /step_mismatch/);

  const applied = JSON.parse((await call(ctx2.client, 'edit', {
    workspaceId: ws2.workspaceId,
    mode: 'apply',
    changeSetId: preview.changeSetId,
    taskId: 't1',
    executionToken: token2,
  })).text);
  assert.equal(applied.status, 'applied');
  assert.equal(fs.readFileSync(path.join(f.repo, 'a.txt'), 'utf8'), 'hello there');

  const verified = JSON.parse((await call(ctx2.client, 'verify', {
    workspaceId: ws2.workspaceId,
    check: 'effectful',
    taskId: 't1',
    executionToken: token2,
  })).text);
  assert.equal(verified.passed, true);

  const result = JSON.parse((await call(ctx2.client, 'governance_record_result', {
    taskId: 't1',
    stepId: 's1',
    executionToken: token2,
    executorStatus: 'success',
    evidence: [{ acceptanceId: 'a1', status: 'pass' }],
    changed: ['a.txt'],
  })).text);
  assert.equal(result.machineGate, 'pass');
  assert.equal(result.executionClaim.active, false);

  const statusAfterResult = JSON.parse((await call(ctx2.client, 'governance_status', {})).text);
  assert.equal(statusAfterResult.authority.generation, 0);
  assert.equal(statusAfterResult.executionClaim.active, false);
  assert.equal(JSON.stringify(statusAfterResult).includes(parentToken), false);
  assert.equal(JSON.stringify(statusAfterResult).includes(token2), false);

  // The original Parent token is still current. Parent REVISE re-opens the step.
  const revise = JSON.parse((await call(ctx2.client, 'governance_transition', {
    taskId: 't1', stepId: 's1', control: 'REVISE', authorityToken: parentToken, workspaceId: ws2.workspaceId,
  })).text);
  assert.equal(revise.ok, true);
  assert.equal(revise.authority.generation, 0);

  const claim3 = JSON.parse((await call(ctx2.client, 'governance_claim_execution', {
    taskId: 't1', stepId: 's1', workspaceId: ws2.workspaceId,
  })).text);
  const token3 = claim3.executionToken;

  const read2 = JSON.parse((await call(ctx2.client, 'read', { workspaceId: ws2.workspaceId, path: 'a.txt' })).text);
  const preview2 = JSON.parse((await call(ctx2.client, 'edit', {
    workspaceId: ws2.workspaceId,
    mode: 'preview',
    change: {
      path: 'a.txt',
      baseHash: read2.sha256,
      replacements: [{ oldText: 'there', newText: 'again' }],
    },
  })).text);

  // Later Parent control fences the outstanding bounded execution claim.
  const parentFence = JSON.parse((await call(ctx2.client, 'governance_transition', {
    taskId: 't1', stepId: 's1', control: 'REVISE', authorityToken: parentToken, workspaceId: ws2.workspaceId,
  })).text);
  assert.equal(parentFence.ok, true);
  const fencedApply = await call(ctx2.client, 'edit', {
    workspaceId: ws2.workspaceId,
    mode: 'apply',
    changeSetId: preview2.changeSetId,
    taskId: 't1',
    executionToken: token3,
  });
  assert.equal(fencedApply.res.isError, true);
  assert.match(fencedApply.text, /stale_execution_claim/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'a.txt'), 'utf8'), 'hello there');
});