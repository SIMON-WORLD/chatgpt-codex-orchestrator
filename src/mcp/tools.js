// chatgpt-codex-orchestrator: MCP v2 tool registration (v0.2 M2).
// Two explicit tool groups: Direct Local (read-only) and Codex Delegate.
// No Capability Router yet (M4). No edit/write/create/verify/general bash.
//
// Workspace authorization: every Codex Delegate operation takes a workspaceId;
// the job's persisted canonical workspaceRoot is compared against the resolved
// root BEFORE any App Server action. Mismatch fails closed.

import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { readFile } from '../local/read.js';
import { search } from '../local/search.js';
import { gitStatus, gitDiff } from '../local/git.js';
import { WorkspaceError } from '../local/workspace.js';

const R = { readOnlyHint: true };
const M = { readOnlyHint: false, destructiveHint: true };

function text(result) { return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }; }
function errText(message) { return { content: [{ type: 'text', text: `error: ${message}` }], isError: true }; }

const workspaceIdSchema = z.string().min(1);

function rootsEqual(a, b) {
  if (!a || !b) return false;
  // Both roots are canonicalized through WorkspaceRegistry / realpath.
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

export function createToolsServer({ workspaceRegistry, appServerExecutor = null } = {}) {
  const server = new McpServer({ name: 'chatgpt-codex-orchestrator', version: '0.2.0-dev' });

  // ---- Direct Local --------------------------------------------------------
  server.registerTool('workspace_open', {
    description: 'Bind an explicit workspace root before local repo operations. The path must be within the configured allowed roots.',
    annotations: R,
    inputSchema: z.object({ path: z.string().describe('Absolute path to an existing directory to bind') }),
  }, async ({ path }) => {
    try { return text(workspaceRegistry.open({ path })); } catch (e) { return errText(e.message); }
  });

  server.registerTool('read', {
    description: 'Bounded read of a file inside a bound workspace. Blocks sensitive/binary files and truncates large output.',
    annotations: R,
    inputSchema: z.object({ workspaceId: workspaceIdSchema, path: z.string(), maxBytes: z.number().int().positive().max(4 * 1024 * 1024).optional() }),
  }, async ({ workspaceId, path, maxBytes }) => {
    try { return text(readFile({ workspaceId, path, maxBytes }, workspaceRegistry)); } catch (e) { return errText(e.message); }
  });

  server.registerTool('search', {
    description: 'Bounded text search inside a bound workspace. Skips sensitive and generated/cache/dependency directories.',
    annotations: R,
    inputSchema: z.object({ workspaceId: workspaceIdSchema, query: z.string(), path: z.string().optional(), maxResults: z.number().int().positive().max(1000).optional() }),
  }, async ({ workspaceId, query, path, maxResults }) => {
    try { return text(search({ workspaceId, query, path, maxResults }, workspaceRegistry)); } catch (e) { return errText(e.message); }
  });

  server.registerTool('git_status', {
    description: 'Read-only git status (--short --branch) for a bound workspace.',
    annotations: R,
    inputSchema: z.object({ workspaceId: workspaceIdSchema }),
  }, async ({ workspaceId }) => {
    try { return text(await gitStatus({ workspaceId }, workspaceRegistry)); } catch (e) { return errText(e.message); }
  });

  server.registerTool('git_diff', {
    description: 'Read-only git diff. Only modes: worktree (default) or staged. No arbitrary revision.',
    annotations: R,
    inputSchema: z.object({ workspaceId: workspaceIdSchema, mode: z.enum(['worktree', 'staged']).optional() }),
  }, async ({ workspaceId, mode }) => {
    try { return text(await gitDiff({ workspaceId, mode }, workspaceRegistry)); } catch (e) { return errText(e.message); }
  });

  // ---- Codex Delegate ------------------------------------------------------
  if (appServerExecutor) {
    server.registerTool('codex_start', {
      description: 'Start a Codex App Server thread + turn inside a bound workspace. May mutate the workspace.',
      annotations: M,
      inputSchema: z.object({ workspaceId: workspaceIdSchema, prompt: z.string(), sandbox: z.string().optional() }),
    }, async ({ workspaceId, prompt, sandbox }) => {
      try {
        const root = assertSameWorkspace(workspaceRegistry, workspaceId, null);
        return text(await appServerExecutor.start({ prompt, cwd: root, sandbox, workspaceRoot: root, workspaceId }));
      } catch (e) { return errText(e.message); }
    });

    server.registerTool('codex_get', {
      description: 'Read structured state + bounded assistant result + pending approvals for a Codex job in a workspace.',
      annotations: R,
      inputSchema: z.object({ workspaceId: workspaceIdSchema, jobId: z.string() }),
    }, async ({ workspaceId, jobId }) => {
      try {
        const job = appServerExecutor.load(jobId);
        assertSameWorkspace(workspaceRegistry, workspaceId, job);
        return text(await appServerExecutor.get({ jobId }));
      } catch (e) { return errText(e.message); }
    });

    server.registerTool('codex_continue', {
      description: 'Continue the same Codex thread with a new instruction. May mutate the workspace.',
      annotations: M,
      inputSchema: z.object({ workspaceId: workspaceIdSchema, jobId: z.string(), instruction: z.string() }),
    }, async ({ workspaceId, jobId, instruction }) => {
      try {
        const job = appServerExecutor.load(jobId);
        assertSameWorkspace(workspaceRegistry, workspaceId, job);
        return text(await appServerExecutor.continue({ jobId, instruction }));
      } catch (e) { return errText(e.message); }
    });

    server.registerTool('codex_interrupt', {
      description: 'Interrupt a running Codex turn.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({ workspaceId: workspaceIdSchema, jobId: z.string() }),
    }, async ({ workspaceId, jobId }) => {
      try {
        const job = appServerExecutor.load(jobId);
        assertSameWorkspace(workspaceRegistry, workspaceId, job);
        return text(await appServerExecutor.interrupt({ jobId }));
      } catch (e) { return errText(e.message); }
    });

    server.registerTool('codex_respond_approval', {
      description: 'Respond to a pending Codex approval (approve/deny). May authorize mutation.',
      annotations: M,
      inputSchema: z.object({ workspaceId: workspaceIdSchema, jobId: z.string(), approvalId: z.string(), decision: z.enum(['approve', 'deny']) }),
    }, async ({ workspaceId, jobId, approvalId, decision }) => {
      try {
        const job = appServerExecutor.load(jobId);
        assertSameWorkspace(workspaceRegistry, workspaceId, job);
        return text(await appServerExecutor.respondApproval({ jobId, approvalId, decision }));
      } catch (e) { return errText(e.message); }
    });
  }

  return server;
}

export { WorkspaceError };
