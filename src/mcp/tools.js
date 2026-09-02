// chatgpt-codex-orchestrator: MCP v2 tool registration (v0.2 M2/M3).
// Tool groups: Direct Local (read-only + bounded edit + verify) and Codex Delegate.
// No Capability Router yet (M4). No edit/write/create/verify/general bash beyond the
// explicit edit + verify tools. Workspace auth enforced on all workspace ops.

import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { readFile } from '../local/read.js';
import { search } from '../local/search.js';
import { gitStatus, gitDiff } from '../local/git.js';
import { WorkspaceError } from '../local/workspace.js';
import { ChangeSetService } from '../local/change-set.js';
import { OperationState } from '../state/operation-state.js';
import { VerifyService } from '../local/verify.js';
import { createCapabilityRouter } from '../router/capability-router.js';
import { createGovernanceService } from '../governance/index.js';

const R = { readOnlyHint: true };
const M = { readOnlyHint: false, destructiveHint: true };

function text(result) { return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }; }
function errText(message) { return { content: [{ type: 'text', text: 'error: ' + message }], isError: true }; }

const workspaceIdSchema = z.string().min(1);

function rootsEqual(a, b) {
  if (!a || !b) return false;
  if (process.platform === 'win32') return String(a).toLowerCase().replace(/\\/g, '/') === String(b).toLowerCase().replace(/\\/g, '/');
  return path.resolve(String(a)) === path.resolve(String(b));
}

function assertSameWorkspace(registry, workspaceId, job) {
  if (!workspaceId) throw new WorkspaceError('workspaceId is required for Codex operations');
  const ws = registry.get(workspaceId);
  if (job) {
    if (!job.workspaceRoot) throw new WorkspaceError('job predates workspace authorization; must be resumed or recreated through the bound M2 path (no workspaceRoot)');
    if (!rootsEqual(ws.root, job.workspaceRoot)) throw new WorkspaceError('job does not belong to this workspace (workspaceRoot mismatch)');
  }
  return ws.root;
}

export function createToolsServer({ workspaceRegistry, appServerExecutor = null, mutationOwner = null, changeSetService = null, verifyService = null, operationState = null, verifyChecks = {}, capabilityRouter = null, governanceService = null } = {}) {
  // Shared mutation-ownership authority: when a Codex executor is present, Direct
  // Local mutation MUST use the SAME owner instance.
  let owner = mutationOwner;
  if (appServerExecutor) {
    if (owner && owner !== appServerExecutor.owner) throw new Error('mutationOwner must be shared with appServerExecutor; refusing unsafe concurrency');
    if (!owner) owner = appServerExecutor.owner;
  }
  // Externally injected Direct mutation services must use the SAME mutation owner.
  if (changeSetService && changeSetService.owner && owner && changeSetService.owner !== owner) throw new Error('changeSetService.mutationOwner must be shared; refusing unsafe concurrency');
  if (verifyService && verifyService.owner && owner && verifyService.owner !== owner) throw new Error('verifyService.mutationOwner must be shared; refusing unsafe concurrency');
  // Direct Local mutation tools are only auto-registered when explicitly configured
  // (operationState for edit, verifyChecks for verify). A codex-delegate-only server must
  // NOT auto-create an OperationState (which requires a data root) just because an owner
  // happens to be present.
  const hasVerifyChecks = Object.keys(verifyChecks || {}).length > 0;
  const changeSet = changeSetService || (operationState && owner ? new ChangeSetService({ workspaceRegistry, operationState, mutationOwner: owner }) : null);
  const verify = verifyService || (owner && hasVerifyChecks ? new VerifyService({ workspaceRegistry, mutationOwner: owner, verifyChecks }) : null);

  const server = new McpServer({ name: 'chatgpt-codex-orchestrator', version: '0.2.0-dev' });

  // ---- Direct Local (read-only + mutation) --------------------------------
  server.registerTool('workspace_open', { description: 'Bind an explicit workspace root before local repo operations.', annotations: R, inputSchema: z.object({ path: z.string() }) },
    async ({ path }) => { try { return text(workspaceRegistry.open({ path })); } catch (e) { return errText(e.message); } });

  server.registerTool('read', { description: 'Bounded read of a file inside a bound workspace.', annotations: R, inputSchema: z.object({ workspaceId: workspaceIdSchema, path: z.string(), maxBytes: z.number().int().positive().max(4 * 1024 * 1024).optional() }) },
    async ({ workspaceId, path, maxBytes }) => { try { return text(readFile({ workspaceId, path, maxBytes }, workspaceRegistry)); } catch (e) { return errText(e.message); } });

  server.registerTool('search', { description: 'Bounded text search inside a bound workspace.', annotations: R, inputSchema: z.object({ workspaceId: workspaceIdSchema, query: z.string(), path: z.string().optional(), maxResults: z.number().int().positive().max(1000).optional() }) },
    async ({ workspaceId, query, path, maxResults }) => { try { return text(search({ workspaceId, query, path, maxResults }, workspaceRegistry)); } catch (e) { return errText(e.message); } });

  server.registerTool('git_status', { description: 'Read-only git status for a bound workspace.', annotations: R, inputSchema: z.object({ workspaceId: workspaceIdSchema }) },
    async ({ workspaceId }) => { try { return text(await gitStatus({ workspaceId }, workspaceRegistry)); } catch (e) { return errText(e.message); } });

  server.registerTool('git_diff', { description: 'Read-only git diff (worktree|staged).', annotations: R, inputSchema: z.object({ workspaceId: workspaceIdSchema, mode: z.enum(['worktree', 'staged']).optional() }) },
    async ({ workspaceId, mode }) => { try { return text(await gitDiff({ workspaceId, mode }, workspaceRegistry)); } catch (e) { return errText(e.message); } });

  // ---- Direct Local bounded edit (M3) -------------------------------------
  if (changeSet) {
    server.registerTool('edit', {
      description: 'Two-phase bounded Direct Local edit (preview or apply). One target file, base-hash stale-write protection, atomic apply.',
      annotations: M,
      inputSchema: z.object({
        workspaceId: workspaceIdSchema,
        mode: z.enum(['preview', 'apply']),
        changeSetId: z.string().optional(),
        change: z.object({ path: z.string(), baseHash: z.string().nullable().optional(), replacements: z.array(z.object({ oldText: z.string(), newText: z.string(), expectedOccurrences: z.number().int().positive().optional() })).optional(), createContent: z.string().nullable().optional() }).optional(),
      }),
    }, async ({ workspaceId, mode, changeSetId, change }) => {
      try {
        if (mode === 'preview') return text(await changeSet.preview({ workspaceId, change }));
        if (mode === 'apply') return text(await changeSet.apply({ workspaceId, changeSetId }));
        return errText('unsupported edit mode');
      } catch (e) { return errText(e.message); }
    });
  }

  // ---- Narrow allowlisted verify (M3) -------------------------------------
  if (verify) {
    server.registerTool('verify', {
      description: 'Run a server-configured allowlisted verification check (read_only or workspace_effect). Caller supplies only check name.',
      annotations: M,
      inputSchema: z.object({ workspaceId: workspaceIdSchema, check: z.string() }),
    }, async ({ workspaceId, check }) => {
      try { return text(await verify.run({ workspaceId, check })); } catch (e) { return errText(e.message); }
    });
  }

  // ---- Capability Router + Governance (M4) ---------------------------------
  const router = capabilityRouter || createCapabilityRouter();
  const governance = governanceService || createGovernanceService();

  if (router) {
    server.registerTool('route_decide', {
      description: 'Deterministic capability routing over structured task facts (read-only). No model/NL reasoning.',
      annotations: R,
      inputSchema: z.object({
        requiresNative: z.boolean().optional(),
        requiresLocal: z.boolean().optional(),
        readOnly: z.boolean().optional(),
        mutationRequired: z.boolean().optional(),
        exactChangeKnown: z.boolean().optional(),
        boundedChange: z.boolean().optional(),
        multiFile: z.boolean().optional(),
        unknownRootCause: z.boolean().optional(),
        iterative: z.boolean().optional(),
        longRunning: z.boolean().optional(),
      }),
    }, async (facts) => {
      try { return text(router.decideStrict(facts)); } catch (e) { return errText(e.message); }
    });
  }

  if (governance) {
    server.registerTool('governance_transition', {
      description: 'Record a Brain governance control (PLAN/TASK/REVISE/REPLAN/ASK_USER/PUBLISH/DONE) with acceptance, evidence, and gate transition.',
      annotations: M,
      inputSchema: z.object({
        taskId: z.string().optional(),
        stepId: z.string().optional(),
        control: z.enum(['PLAN', 'TASK', 'REVISE', 'REPLAN', 'ASK_USER', 'PUBLISH', 'DONE']),
        route: z.enum(['CHATGPT_NATIVE', 'CHATGPT_DIRECT_LOCAL', 'CODEX_DELEGATE', 'HYBRID']).optional(),
        localRoute: z.enum(['CHATGPT_DIRECT_LOCAL', 'CODEX_DELEGATE']).optional(),
        acceptance: z.array(z.object({ id: z.string(), required: z.boolean().optional(), requiredEvidenceLevel: z.string().optional() })).optional(),
        evidence: z.array(z.object({ acceptanceId: z.string(), status: z.string().optional(), evidenceLevel: z.string().optional() })).optional(),
        reviseDelta: z.object({ preserve: z.array(z.string()).optional(), invalidate: z.array(z.string()).optional() }).optional(),
        executorStatus: z.enum(['success', 'failure', 'unknown']).optional(),
        changed: z.array(z.string()).optional(),
        publication: z.object({ ok: z.boolean().optional(), externalReadback: z.any().optional() }).optional(),
        whyBlocked: z.string().optional(),
        minimalUserAction: z.string().optional(),
        question: z.string().optional(),
      }),
    }, async (args) => {
      try { return text(governance.transition(args)); } catch (e) { return errText(e.message); }
    });

    server.registerTool('governance_status', {
      description: 'Return compact current governance state (read-only).',
      annotations: R,
      inputSchema: z.object({}),
    }, async () => {
      try { return text(governance.status()); } catch (e) { return errText(e.message); }
    });
  }

  // ---- Codex Delegate ------------------------------------------------------
  if (appServerExecutor) {
    server.registerTool('codex_start', { description: 'Start a Codex App Server thread + turn in a workspace.', annotations: M, inputSchema: z.object({ workspaceId: workspaceIdSchema, prompt: z.string(), sandbox: z.string().optional() }) },
      async ({ workspaceId, prompt, sandbox }) => { try { const root = assertSameWorkspace(workspaceRegistry, workspaceId, null); return text(await appServerExecutor.start({ prompt, cwd: root, sandbox, workspaceRoot: root, workspaceId })); } catch (e) { return errText(e.message); } });
    server.registerTool('codex_get', { description: 'Read structured state + bounded result + pending approvals for a Codex job.', annotations: R, inputSchema: z.object({ workspaceId: workspaceIdSchema, jobId: z.string() }) },
      async ({ workspaceId, jobId }) => { try { const job = appServerExecutor.load(jobId); assertSameWorkspace(workspaceRegistry, workspaceId, job); return text(await appServerExecutor.get({ jobId })); } catch (e) { return errText(e.message); } });
    server.registerTool('codex_continue', { description: 'Continue the same Codex thread.', annotations: M, inputSchema: z.object({ workspaceId: workspaceIdSchema, jobId: z.string(), instruction: z.string() }) },
      async ({ workspaceId, jobId, instruction }) => { try { const job = appServerExecutor.load(jobId); assertSameWorkspace(workspaceRegistry, workspaceId, job); return text(await appServerExecutor.continue({ jobId, instruction })); } catch (e) { return errText(e.message); } });
    server.registerTool('codex_interrupt', { description: 'Interrupt a running Codex turn.', annotations: { readOnlyHint: false, destructiveHint: false }, inputSchema: z.object({ workspaceId: workspaceIdSchema, jobId: z.string() }) },
      async ({ workspaceId, jobId }) => { try { const job = appServerExecutor.load(jobId); assertSameWorkspace(workspaceRegistry, workspaceId, job); return text(await appServerExecutor.interrupt({ jobId })); } catch (e) { return errText(e.message); } });
    server.registerTool('codex_respond_approval', { description: 'Respond to a pending Codex approval.', annotations: M, inputSchema: z.object({ workspaceId: workspaceIdSchema, jobId: z.string(), approvalId: z.string(), decision: z.enum(['approve', 'deny']) }) },
      async ({ workspaceId, jobId, approvalId, decision }) => { try { const job = appServerExecutor.load(jobId); assertSameWorkspace(workspaceRegistry, workspaceId, job); return text(await appServerExecutor.respondApproval({ jobId, approvalId, decision })); } catch (e) { return errText(e.message); } });
  }

  return server;
}

export { WorkspaceError };
