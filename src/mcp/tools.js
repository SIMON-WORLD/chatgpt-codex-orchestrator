// chatgpt-codex-orchestrator: MCP tool registration (v0.2 M2).
// Two explicit tool groups: Direct Local (read-only) and Codex Delegate.
// No Capability Router yet (M4). No edit/write/create/verify/general bash.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { readFile } from '../local/read.js';
import { search } from '../local/search.js';
import { gitStatus, gitDiff } from '../local/git.js';
import { WorkspaceError } from '../local/workspace.js';

const R = { readOnlyHint: true };
const M = { readOnlyHint: false, destructiveHint: true };

function text(result) { return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }; }
function errText(message) { return { content: [{ type: 'text', text: `error: ${message}` }], isError: true }; }

export function createToolsServer({ workspaceRegistry, appServerExecutor = null } = {}) {
  const server = new McpServer({ name: 'chatgpt-codex-orchestrator', version: '0.2.0' });

  // ---- Direct Local --------------------------------------------------------
  server.registerTool('workspace_open', {
    title: 'workspace_open',
    description: 'Bind an explicit workspace root before local repo operations. The path must be within the configured allowed roots.',
    annotations: R,
    inputSchema: { path: z.string().describe('Absolute path to an existing directory to bind') },
  }, async ({ path }) => {
    try { return text(workspaceRegistry.open({ path })); } catch (e) { return errText(e.message); }
  });

  server.registerTool('read', {
    title: 'read',
    description: 'Bounded read of a file inside a bound workspace. Blocks sensitive/binary files and truncates large output.',
    annotations: R,
    inputSchema: { workspaceId: z.string(), path: z.string(), maxBytes: z.number().optional() },
  }, async ({ workspaceId, path, maxBytes }) => {
    try { return text(readFile({ workspaceId, path, maxBytes }, workspaceRegistry)); } catch (e) { return errText(e.message); }
  });

  server.registerTool('search', {
    title: 'search',
    description: 'Bounded text search inside a bound workspace. Skips sensitive and generated/cache/dependency directories.',
    annotations: R,
    inputSchema: { workspaceId: z.string(), query: z.string(), path: z.string().optional(), maxResults: z.number().optional() },
  }, async ({ workspaceId, query, path, maxResults }) => {
    try { return text(search({ workspaceId, query, path, maxResults }, workspaceRegistry)); } catch (e) { return errText(e.message); }
  });

  server.registerTool('git_status', {
    title: 'git_status',
    description: 'Read-only git status (--short --branch) for a bound workspace.',
    annotations: R,
    inputSchema: { workspaceId: z.string() },
  }, async ({ workspaceId }) => {
    try { return text(await gitStatus({ workspaceId }, workspaceRegistry)); } catch (e) { return errText(e.message); }
  });

  server.registerTool('git_diff', {
    title: 'git_diff',
    description: 'Read-only git diff. Only modes: worktree (default) or staged. No arbitrary revision.',
    annotations: R,
    inputSchema: { workspaceId: z.string(), mode: z.enum(['worktree', 'staged']).optional() },
  }, async ({ workspaceId, mode }) => {
    try { return text(await gitDiff({ workspaceId, mode }, workspaceRegistry)); } catch (e) { return errText(e.message); }
  });

  // ---- Codex Delegate ------------------------------------------------------
  if (appServerExecutor) {
    server.registerTool('codex_start', {
      title: 'codex_start',
      description: 'Start a Codex App Server thread + turn inside a bound workspace. May mutate the workspace.',
      annotations: M,
      inputSchema: { workspaceId: z.string(), prompt: z.string(), sandbox: z.string().optional() },
    }, async ({ workspaceId, prompt, sandbox }) => {
      try {
        const ws = workspaceRegistry.get(workspaceId);
        return text(await appServerExecutor.start({ prompt, cwd: ws.root, sandbox }));
      } catch (e) { return errText(e.message); }
    });

    server.registerTool('codex_get', {
      title: 'codex_get',
      description: 'Read structured state for a Codex job/thread/turn.',
      annotations: R,
      inputSchema: { jobId: z.string() },
    }, async ({ jobId }) => {
      try { return text(await appServerExecutor.get({ jobId })); } catch (e) { return errText(e.message); }
    });

    server.registerTool('codex_continue', {
      title: 'codex_continue',
      description: 'Continue the same Codex thread with a new instruction. May mutate the workspace.',
      annotations: M,
      inputSchema: { jobId: z.string(), instruction: z.string() },
    }, async ({ jobId, instruction }) => {
      try { return text(await appServerExecutor.continue({ jobId, instruction })); } catch (e) { return errText(e.message); }
    });

    server.registerTool('codex_interrupt', {
      title: 'codex_interrupt',
      description: 'Interrupt a running Codex turn.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: { jobId: z.string() },
    }, async ({ jobId }) => {
      try { return text(await appServerExecutor.interrupt({ jobId })); } catch (e) { return errText(e.message); }
    });

    server.registerTool('codex_respond_approval', {
      title: 'codex_respond_approval',
      description: 'Respond to a pending Codex approval (approve/deny). May authorize mutation.',
      annotations: M,
      inputSchema: { jobId: z.string(), approvalId: z.string(), decision: z.enum(['approve', 'deny']) },
    }, async ({ jobId, approvalId, decision }) => {
      try { return text(await appServerExecutor.respondApproval({ jobId, approvalId, decision })); } catch (e) { return errText(e.message); }
    });
  }

  return server;
}

export { WorkspaceError };
