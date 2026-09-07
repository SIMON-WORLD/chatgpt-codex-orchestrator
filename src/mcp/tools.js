// chatgpt-codex-orchestrator: MCP v0.2 tool registration.
// Tool groups: Direct Local (read-only + bounded edit + verify), Capability Router /
// Governance, and Codex Delegate. No general bash or unconstrained local mutation;
// workspace authorization is enforced on all workspace-scoped operations.

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
import { performContinuityTakeover } from '../governance/durable.js';

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

// Parent-token task-scoped mutation authorization (Issue #29, durable Governance only).
// workspaceId/jobId/changeSetId are lookup selectors, never mission authority. This path
// remains the ONLY authorization path for new Codex turns and all Parent-controlled
// mutation categories.
function requireTaskMutationAuth(governance, workspaceRegistry, { workspaceId = null, taskId = null, authorityToken = null } = {}) {
  if (!governance || typeof governance.authorizeMutation !== 'function') return taskId || null;
  if (!workspaceId) throw new WorkspaceError('workspaceId is required for an authorized mutation');
  const ws = workspaceRegistry.get(workspaceId);
  const res = governance.authorizeMutation({ taskId: taskId || null, authorityToken: authorityToken || null, workspaceRoot: ws.root });
  return res.taskId;
}

// Direct Local execution authorization (Issue #34). Parent authority remains valid for
// backward compatibility; a bounded execution token is accepted only by the dedicated
// durable authorizeExecution gate, which is step/route/workspace scoped. Never use this
// helper for Codex or Governance control tools.
function requireDirectLocalMutationAuth(governance, workspaceRegistry, { workspaceId = null, taskId = null, authorityToken = null, executionToken = null } = {}) {
  if (!governance || typeof governance.authorizeMutation !== 'function') return taskId || null;
  if (!workspaceId) throw new WorkspaceError('workspaceId is required for an authorized mutation');
  if (authorityToken != null && executionToken != null) throw new WorkspaceError('provide either authorityToken or executionToken, not both');
  const ws = workspaceRegistry.get(workspaceId);
  if (executionToken != null) {
    if (typeof governance.authorizeExecution !== 'function') throw new WorkspaceError('bounded execution claims are not supported by this governance runtime');
    const res = governance.authorizeExecution({ taskId: taskId || null, executionToken, workspaceRoot: ws.root });
    return res.taskId;
  }
  const res = governance.authorizeMutation({ taskId: taskId || null, authorityToken: authorityToken || null, workspaceRoot: ws.root });
  return res.taskId;
}

export function createToolsServer({ workspaceRegistry, appServerExecutor = null, mutationOwner = null, changeSetService = null, verifyService = null, operationState = null, verifyChecks = {}, capabilityRouter = null, governanceService = null, worktreeService = null } = {}) {
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

  // ---- Narrow bounded worktree bootstrap (Issue #29) ------------------------
  // Registered only when a dedicated worktree service (trust pool + trusted repos) is
  // explicitly configured. No arbitrary shell / pool manager / scheduler / GC.
  if (worktreeService && typeof worktreeService.create === 'function') {
    server.registerTool('worktree_create', {
      description: 'Narrow bounded worktree bootstrap: git worktree add of an explicitly trusted repo into the dedicated worktree trust pool. Strict trust-root containment: rejects existing targets, ambiguous/unsafe branch or ref, untrusted repo, and any pool escape. Returns the exact canonical created path. No generic shell or repo manager.',
      annotations: M,
      inputSchema: z.object({ repo: z.string(), targetPath: z.string(), branch: z.string(), startPoint: z.string() }),
    }, async ({ repo, targetPath, branch, startPoint }) => {
      try { return text(await worktreeService.create({ repo, targetPath, branch, startPoint })); } catch (e) { return errText(e.message); }
    });
  }

  // Governance is created before mutation handlers run; closures below consume the
  // final configured service when a tool call arrives.
  const router = capabilityRouter || createCapabilityRouter();
  const governance = governanceService || createGovernanceService();

  // ---- Direct Local bounded edit (M3) -------------------------------------
  if (changeSet) {
    server.registerTool('edit', {
      description: 'Two-phase bounded Direct Local edit (preview or apply). One target file, base-hash stale-write protection, atomic apply. Durable apply accepts current Parent authority or a current-step bounded execution claim.',
      annotations: M,
      inputSchema: z.object({
        workspaceId: workspaceIdSchema,
        mode: z.enum(['preview', 'apply']),
        changeSetId: z.string().optional(),
        change: z.object({ path: z.string(), baseHash: z.string().nullable().optional(), replacements: z.array(z.object({ oldText: z.string(), newText: z.string(), expectedOccurrences: z.number().int().positive().optional() })).optional(), createContent: z.string().nullable().optional() }).optional(),
        taskId: z.string().optional(),
        authorityToken: z.string().optional(),
        executionToken: z.string().optional(),
      }),
    }, async ({ workspaceId, mode, changeSetId, change, taskId, authorityToken, executionToken }) => {
      try {
        if (mode === 'preview') return text(await changeSet.preview({ workspaceId, change }));
        if (mode === 'apply') { requireDirectLocalMutationAuth(governance, workspaceRegistry, { workspaceId, taskId, authorityToken, executionToken }); return text(await changeSet.apply({ workspaceId, changeSetId })); }
        return errText('unsupported edit mode');
      } catch (e) { return errText(e.message); }
    });
  }

  // ---- Narrow allowlisted verify (M3) -------------------------------------
  if (verify) {
    server.registerTool('verify', {
      description: 'Run a server-configured allowlisted verification check (read_only or workspace_effect). workspace_effect requires current Parent authority or a current-step bounded execution claim in durable Governance.',
      annotations: M,
      inputSchema: z.object({ workspaceId: workspaceIdSchema, check: z.string(), taskId: z.string().optional(), authorityToken: z.string().optional(), executionToken: z.string().optional() }),
    }, async ({ workspaceId, check, taskId, authorityToken, executionToken }) => {
      try { const spec = verifyChecks[check]; if (spec && spec.effect === 'workspace_effect') requireDirectLocalMutationAuth(governance, workspaceRegistry, { workspaceId, taskId, authorityToken, executionToken }); return text(await verify.run({ workspaceId, check })); } catch (e) { return errText(e.message); }
    });
  }

  // ---- Capability Router + Governance (M4) ---------------------------------
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
      description: 'Record a Parent Brain governance control (PLAN/TASK/REVISE/REPLAN/ASK_USER/PUBLISH/DONE) with acceptance contract and revise delta. Requires Parent authority in durable Governance; bounded execution claims never authorize this tool.',
      annotations: M,
      inputSchema: z.object({
        taskId: z.string().optional(),
        projectKey: z.string().optional(),
        identity: z.string().optional(),
        authorityToken: z.string().optional(),
        workspaceId: workspaceIdSchema.optional(),
        stepId: z.string().optional(),
        control: z.enum(['PLAN', 'TASK', 'REVISE', 'REPLAN', 'ASK_USER', 'PUBLISH', 'DONE']),
        route: z.enum(['CHATGPT_NATIVE', 'CHATGPT_DIRECT_LOCAL', 'CODEX_DELEGATE', 'HYBRID']).optional(),
        localRoute: z.enum(['CHATGPT_DIRECT_LOCAL', 'CODEX_DELEGATE']).optional(),
        acceptance: z.array(z.object({ id: z.string(), required: z.boolean().optional(), requiredEvidenceLevel: z.string().optional() })).optional(),
        reviseDelta: z.object({ preserve: z.array(z.string()).optional(), invalidate: z.array(z.string()).optional() }).optional(),
        whyBlocked: z.string().optional(),
        minimalUserAction: z.string().optional(),
        question: z.string().optional(),
      }).strict(),
    }, async (args) => {
      try {
        const txArgs = { ...args };
        if (txArgs.workspaceId) {
          if (governance && typeof governance.authorizeMutation === 'function') txArgs.workspaceRoot = workspaceRegistry.get(txArgs.workspaceId).root;
          delete txArgs.workspaceId;
        }
        return text(governance.transition(txArgs));
      } catch (e) { return errText(e.message); }
    });

    server.registerTool('governance_record_result', {
      description: 'Ingest an executor RESULT for the active step. Durable Governance accepts either current Parent authority or a bounded execution claim for that exact current step; execution claims cannot change scope/acceptance or invoke controls.',
      annotations: M,
      inputSchema: z.object({
        taskId: z.string().optional(),
        authorityToken: z.string().optional(),
        executionToken: z.string().optional(),
        stepId: z.string(),
        executorStatus: z.enum(['success', 'failure', 'unknown']),
        evidence: z.array(z.object({ acceptanceId: z.string(), status: z.string().optional(), evidenceLevel: z.string().optional(), kind: z.string().optional(), summary: z.string().optional() })).optional(),
        changed: z.array(z.string()).optional(),
        publication: z.object({ ok: z.boolean().optional(), externalReadback: z.any().optional() }).optional(),
      }),
    }, async (args) => {
      try { return text(governance.recordResult(args)); } catch (e) { return errText(e.message); }
    });

    server.registerTool('governance_status', {
      description: 'Return compact current governance state (read-only). Parent token and execution token are never returned.',
      annotations: R,
      inputSchema: z.object({}),
    }, async () => {
      try { return text(governance.status()); } catch (e) { return errText(e.message); }
    });
  }

  // ---- Brain Continuity (durable Governance re-entry) -------------------------
  // Registered only when the governance service is durable (namespace-scoped store +
  // authority fencing + takeover). Recovery stays read-only; claim_execution is the
  // non-Parent execution-continuation path; takeover remains Parent-only re-entry.
  const durableGovernance = governance && typeof governance.recoverSemantic === 'function' && typeof governance.takeover === 'function';
  if (durableGovernance) {
    server.registerTool('governance_recover', {
      description: 'Read-only bounded semantic governance recovery discovery (Brain Continuity). 0 -> not_found, 1 -> unique in-progress task, >1 -> ambiguous/fail closed. Never guesses most recent and never returns internal authority tokens.',
      annotations: R,
      inputSchema: z.object({
        taskId: z.string().optional(),
        projectKey: z.string().optional(),
        identity: z.string().optional(),
      }),
    }, async ({ taskId, projectKey, identity }) => {
      try {
        const result = governance.recoverSemantic({ taskId, projectKey, identity });
        if (!result.ok) return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: true };
        return text(result);
      } catch (e) { return errText(e.message); }
    });

    if (typeof governance.claimExecution === 'function') {
      server.registerTool('governance_claim_execution', {
        description: 'Claim ONLY the already Parent-authorized current CHATGPT_DIRECT_LOCAL TASK/REVISE step for bounded implementation-session continuation. Resolves exactly one active task by semantic identity, binds exact step + canonical workspace, refreshes an independent opaque execution token, and never changes Parent authority or grants Governance/Codex/worktree control.',
        annotations: M,
        inputSchema: z.object({
          taskId: z.string().optional(),
          projectKey: z.string().optional(),
          identity: z.string().optional(),
          stepId: z.string(),
          workspaceId: workspaceIdSchema,
        }).strict(),
      }, async ({ taskId, projectKey, identity, stepId, workspaceId }) => {
        try {
          const root = workspaceRegistry.get(workspaceId).root;
          return text(governance.claimExecution({ taskId, projectKey, identity, stepId, workspaceRoot: root }));
        } catch (e) { return errText(e.message); }
      });
    }

    server.registerTool('governance_takeover', {
      description: 'Bounded Parent re-entry/takeover for one uniquely resolved governance task: increments durable Parent authority generation, mints a new opaque Parent fencing token, and returns a bounded Context Capsule. Reconciles any still-valid delegated Codex execution through the existing recover path only. Bounded execution claim tokens never authorize takeover.',
      annotations: M,
      inputSchema: z.object({
        taskId: z.string().optional(),
        projectKey: z.string().optional(),
        identity: z.string().optional(),
        authorityToken: z.string().optional(),
        workspaceId: workspaceIdSchema.optional(),
      }),
    }, async ({ taskId, projectKey, identity, authorityToken, workspaceId }) => {
      try {
        let root = null;
        if (workspaceId) root = workspaceRegistry.get(workspaceId).root;
        const scope = { taskId, projectKey, identity, authorityToken };
        return text(await performContinuityTakeover({ service: governance, executor: appServerExecutor, workspaceId: workspaceId || null, workspaceRoot: root, scope }));
      } catch (e) { return errText(e.message); }
    });
  }

  // ---- Codex Delegate ------------------------------------------------------
  if (appServerExecutor) {
    server.registerTool('codex_recovery_preflight', {
      description: 'Read-only duplicate-execution risk preflight for one workspace and semantic task scope. Considers only recovery-risk/non-terminal jobs that are unbound or exactly match taskId/stepId/identity; ignores terminal history; never lists jobs, selects most-recent, resumes, reconciles, starts, interrupts, or force-unlocks anything.',
      annotations: R,
      inputSchema: z.object({ workspaceId: workspaceIdSchema, taskId: z.string().optional(), stepId: z.string().optional(), identity: z.string().optional() }),
    }, async ({ workspaceId, taskId, stepId, identity }) => {
      try {
        const root = assertSameWorkspace(workspaceRegistry, workspaceId, null);
        const result = appServerExecutor.jobMap.recoveryPreflight({ workspaceId, workspaceRoot: root, taskId, stepId, identity });
        if (!result.ok) return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: true };
        return text(result);
      } catch (e) {
        return errText(e.message);
      }
    });

    server.registerTool('codex_recovery_reconcile_preflight', {
      description: 'Bounded authoritative ambiguity remediation for recovery preflight. Reuses the exact hidden dangerous-candidate scope, reconciles candidates only via thread/resume + thread/read, never starts/continues/interrupts/selects-most-recent/lists jobs, then returns only the aggregate post-reconcile recovery decision.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({ workspaceId: workspaceIdSchema, taskId: z.string().optional(), stepId: z.string().optional(), identity: z.string().optional() }),
    }, async ({ workspaceId, taskId, stepId, identity }) => {
      try {
        const root = assertSameWorkspace(workspaceRegistry, workspaceId, null);
        const result = await appServerExecutor.reconcileRecoveryPreflight({ workspaceId, workspaceRoot: root, taskId, stepId, identity });
        if (!result.ok) return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: true };
        return text(result);
      } catch (e) {
        return errText(e.message);
      }
    });

    server.registerTool('codex_start', { description: 'Start a Codex App Server thread + turn in a workspace. accessMode is required (read_only | workspace_write); a mutation delegation must not silently default to read-only. networkAccess is an optional minimal job-level flag (default false) for operations like git push, and is never granted to every job. New turns are authorized against the current durable Governance task + canonical workspace root + current Parent authority token when a durable governance runtime is configured. Execution claim tokens are not accepted.', annotations: M, inputSchema: z.object({ workspaceId: workspaceIdSchema, prompt: z.string(), accessMode: z.enum(['read_only', 'workspace_write']), networkAccess: z.boolean().optional(), taskId: z.string().optional(), stepId: z.string().optional(), identity: z.string().optional(), authorityToken: z.string().optional() }) },
      async ({ workspaceId, prompt, accessMode, networkAccess = false, taskId, stepId, identity, authorityToken }) => { try { const root = assertSameWorkspace(workspaceRegistry, workspaceId, null); const authTaskId = requireTaskMutationAuth(governance, workspaceRegistry, { workspaceId, taskId, authorityToken }); return text(await appServerExecutor.start({ prompt, cwd: root, accessMode, workspaceRoot: root, workspaceId, networkAccess, taskId: taskId || authTaskId, stepId, identity })); } catch (e) { return errText(e.message); } });
    server.registerTool('codex_get', { description: 'Read structured state + bounded result + pending approvals for a Codex job.', annotations: R, inputSchema: z.object({ workspaceId: workspaceIdSchema, jobId: z.string() }) },
      async ({ workspaceId, jobId }) => { try { const job = appServerExecutor.load(jobId); assertSameWorkspace(workspaceRegistry, workspaceId, job); return text(await appServerExecutor.get({ jobId })); } catch (e) { return errText(e.message); } });
    server.registerTool('codex_continue', { description: 'Continue the same Codex thread. New turns are authorized against the current durable Governance task + canonical workspace root + current Parent authority token when a durable governance runtime is configured. Execution claim tokens are not accepted.', annotations: M, inputSchema: z.object({ workspaceId: workspaceIdSchema, jobId: z.string(), instruction: z.string(), taskId: z.string().optional(), stepId: z.string().optional(), identity: z.string().optional(), authorityToken: z.string().optional() }) },
      async ({ workspaceId, jobId, instruction, taskId, stepId, identity, authorityToken }) => { try { const job = appServerExecutor.load(jobId); const root = assertSameWorkspace(workspaceRegistry, workspaceId, job); const authTaskId = requireTaskMutationAuth(governance, workspaceRegistry, { workspaceId, taskId, authorityToken }); if (authTaskId && job.taskId && job.taskId !== authTaskId) throw new WorkspaceError(`job ${jobId} is bound to governance task ${job.taskId}, not the active task ${authTaskId}; refusing a cross-task continue`); return text(await appServerExecutor.continue({ jobId, instruction, taskId: taskId || authTaskId, stepId, identity })); } catch (e) { return errText(e.message); } });
    server.registerTool('codex_interrupt', { description: 'Interrupt a running Codex turn.', annotations: { readOnlyHint: false, destructiveHint: false }, inputSchema: z.object({ workspaceId: workspaceIdSchema, jobId: z.string() }) },
      async ({ workspaceId, jobId }) => { try { const job = appServerExecutor.load(jobId); assertSameWorkspace(workspaceRegistry, workspaceId, job); return text(await appServerExecutor.interrupt({ jobId })); } catch (e) { return errText(e.message); } });

    server.registerTool('codex_reconcile', { description: 'Authoritatively reconcile a Codex job after process death / connection loss. Uses thread/resume + thread/read (never creates a new turn, never a generic force-unlock). Terminal -> release writer; inProgress -> retain writer; ambiguous -> fail closed.', annotations: M, inputSchema: z.object({ workspaceId: workspaceIdSchema, jobId: z.string() }) },
      async ({ workspaceId, jobId }) => { try { const job = appServerExecutor.load(jobId); assertSameWorkspace(workspaceRegistry, workspaceId, job); return text(await appServerExecutor.reconcile({ jobId })); } catch (e) { return errText(e.message); } });
    server.registerTool('codex_respond_approval', { description: 'Respond to a pending Codex approval.', annotations: M, inputSchema: z.object({ workspaceId: workspaceIdSchema, jobId: z.string(), approvalId: z.string(), decision: z.enum(['approve', 'deny']) }) },
      async ({ workspaceId, jobId, approvalId, decision }) => { try { const job = appServerExecutor.load(jobId); assertSameWorkspace(workspaceRegistry, workspaceId, job); return text(await appServerExecutor.respondApproval({ jobId, approvalId, decision })); } catch (e) { return errText(e.message); } });
    server.registerTool('codex_recover', {
      description: 'Bounded recovery lookup: resolve the single Codex job bound to a durable orchestration identity (taskId/stepId/identity) in a workspace. Fails closed on not_found / ambiguous / wrong_workspace / stale and never guesses most-recent. May authoritatively reconcile a recovery_required job.',
      annotations: R,
      inputSchema: z.object({ workspaceId: workspaceIdSchema, taskId: z.string().optional(), stepId: z.string().optional(), identity: z.string().optional() }),
    }, async ({ workspaceId, taskId, stepId, identity }) => {
      try {
        if (!taskId && !stepId && !identity) throw new WorkspaceError('codex_recover requires at least one of taskId, stepId, or identity');
        const root = assertSameWorkspace(workspaceRegistry, workspaceId, null);
        return text(await appServerExecutor.recover({ workspaceId, workspaceRoot: root, taskId, stepId, identity }));
      } catch (e) {
        if (e && e.name === 'RecoveryError') return { content: [{ type: 'text', text: JSON.stringify(e.toJSON()) }], isError: true };
        return errText(e.message);
      }
    });
  }

  return server;
}

export { WorkspaceError };