// chatgpt-codex-orchestrator: MCP v0.2 tool registration.
// Tool groups: Direct Local (read-only + bounded edit + verify), Capability Router /
// Governance, and Codex Delegate. No general bash or unconstrained local mutation;
// workspace authorization is enforced on all workspace-scoped operations.

import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { readFileWithDesktopCommander } from '../local/read.js';
import { searchWithOptions } from '../local/search.js';
import { fileInfoWithDesktopCommander, filenameSearchWithDesktopCommander, listDirectoryWithDesktopCommander, readMultipleFilesWithDesktopCommander } from '../local/filesystem.js';
import { gitStatus, gitDiff } from '../local/git.js';
import { DesktopCommanderChild, COMPOSITE_EDIT_BOUNDARY_BLOCKED } from '../local/desktop-commander-child.js';
import { WorkspaceError } from '../local/workspace.js';
import { ChangeSetService } from '../local/change-set.js';
import { FilesystemMutationService } from '../local/filesystem-mutation.js';
import { ExcelMutationService } from '../local/excel-mutation.js';
import { DocxMutationService } from '../local/docx-mutation.js';
import { PdfMutationService } from '../local/pdf-mutation.js';
import { OperationState } from '../state/operation-state.js';
import { VerifyService } from '../local/verify.js';
import { createCapabilityRouter } from '../router/capability-router.js';
import { createGovernanceService } from '../governance/index.js';
import { performContinuityTakeover } from '../governance/durable.js';
import {
  STRUCTURED_READ_LIMITS,
  readImageWithDesktopCommander,
  readExcelWithDesktopCommander,
  searchExcelWithDesktopCommander,
  readPdfWithDesktopCommander,
  readDocxWithDesktopCommander,
} from '../local/structured-read.js';

const R = { readOnlyHint: true };
const M = { readOnlyHint: false, destructiveHint: true };
const DIRECT_LOCAL_DESTRUCTIVE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
const DIRECT_LOCAL_DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const DIRECT_LOCAL_ADDITIVE_IDEMPOTENT_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const GOVERNANCE_PLAN_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const GOVERNANCE_TASK_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
const GOVERNANCE_TAKEOVER_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
const GOVERNANCE_TRANSITION_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

function text(result) { return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }; }
function structured(result) {
  return {
    structuredContent: result.structuredContent,
    content: [
      { type: 'text', text: JSON.stringify(result.structuredContent, null, 2) },
      ...(Array.isArray(result.content) ? result.content : []),
    ],
  };
}
function errText(message) { return { content: [{ type: 'text', text: 'error: ' + message }], isError: true }; }

const workspaceIdSchema = z.string().min(1);
const mutationPathSchema = z.string().min(1).max(4096);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/iu);
const directLocalMutationAuthFields = {
  taskId: z.string().optional(),
  authorityToken: z.string().optional(),
  executionToken: z.string().optional(),
};
const excelCellSchema = z.union([z.string().max(1024 * 1024), z.number().finite(), z.boolean(), z.null()]);
const excelValuesSchema = z.array(z.array(excelCellSchema).min(1).max(50000)).min(1).max(2000);
const pdfOperationsSchema = z.array(z.union([
  z.object({
    type: z.literal('delete_pages'),
    pages: z.array(z.number().int().min(1).max(32)).min(1).max(32),
  }).strict(),
  z.object({
    type: z.literal('insert_pdf'),
    atPage: z.number().int().min(1).max(33),
    sourcePath: mutationPathSchema,
  }).strict(),
])).min(1).max(16);

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

export function createToolsServer({ workspaceRegistry, appServerExecutor = null, mutationOwner = null, changeSetService = null, filesystemMutationService = null, excelMutationService = null, docxMutationService = null, pdfMutationService = null, verifyService = null, operationState = null, verifyChecks = {}, capabilityRouter = null, governanceService = null, worktreeService = null, desktopCommanderChild = null } = {}) {
  const child = desktopCommanderChild || new DesktopCommanderChild();
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
  if (filesystemMutationService && (!owner || filesystemMutationService.owner !== owner)) throw new Error('filesystemMutationService.mutationOwner must be shared; refusing unsafe concurrency');
  if (excelMutationService && (!owner || excelMutationService.owner !== owner)) throw new Error('excelMutationService.mutationOwner must be shared; refusing unsafe concurrency');
  if (docxMutationService && (!owner || docxMutationService.owner !== owner)) throw new Error('docxMutationService.mutationOwner must be shared; refusing unsafe concurrency');
  if (pdfMutationService && (!owner || pdfMutationService.owner !== owner)) throw new Error('pdfMutationService.mutationOwner must be shared; refusing unsafe concurrency');
  const filesystemMutation = filesystemMutationService || (owner ? new FilesystemMutationService({ workspaceRegistry, mutationOwner: owner, desktopCommanderChild: child }) : null);
  const excelMutation = excelMutationService || (owner ? new ExcelMutationService({ workspaceRegistry, mutationOwner: owner, desktopCommanderChild: child }) : null);
  const docxMutation = docxMutationService || (owner ? new DocxMutationService({ workspaceRegistry, mutationOwner: owner, desktopCommanderChild: child }) : null);
  const pdfMutation = pdfMutationService || (owner ? new PdfMutationService({ workspaceRegistry, mutationOwner: owner, desktopCommanderChild: child }) : null);
  const verify = verifyService || (owner && hasVerifyChecks ? new VerifyService({ workspaceRegistry, mutationOwner: owner, verifyChecks }) : null);

  const server = new McpServer({ name: 'chatgpt-codex-orchestrator', version: '0.2.0-dev' });
  const router = capabilityRouter || createCapabilityRouter();
  const governance = governanceService || createGovernanceService();

  const secondaryReadGrantsFor = (workspaceId) => {
    try { return workspaceRegistry.getSecondaryReadGrants(workspaceId); }
    catch { return []; }
  };

  // ---- Direct Local (read-only + mutation) --------------------------------
  server.registerTool('workspace_open', {
    description: 'Bind one primary workspace context and, optionally, an explicit bounded set of secondary read-only file/root grants for this workspace handle. Grants stay inside the configured host trust ceiling and never widen write/process/network authority.',
    annotations: R,
    inputSchema: z.object({
      path: z.string().optional(),
      fixture: z.string().optional(),
      secondaryReadGrants: z.array(z.string()).max(16).optional(),
    }),
  },
  async ({ path, fixture, secondaryReadGrants }) => {
    try { return text(workspaceRegistry.open({ path, fixture, secondaryReadGrants })); }
    catch (e) { return errText(e.message); }
  });

  server.registerTool('read', { description: 'Bounded read or continuation range of a primary-workspace file or an explicitly granted secondary read-only file.', annotations: R, inputSchema: z.object({ workspaceId: workspaceIdSchema, path: z.string(), offset: z.number().int().nonnegative().optional(), maxLines: z.number().int().positive().max(2000).optional(), maxBytes: z.number().int().positive().max(4 * 1024 * 1024).optional() }) },
    async ({ workspaceId, path, offset, maxLines, maxBytes }) => { try { return text(await readFileWithDesktopCommander({ workspaceId, path, offset, maxLines, maxBytes, secondaryReadGrants: secondaryReadGrantsFor(workspaceId) }, workspaceRegistry, child)); } catch (e) { return errText(e.message); } });

  server.registerTool('read_multiple', { description: 'Read a small explicit set of authorized ordinary files in one fail-closed operation; no implicit directory enumeration.', annotations: R, inputSchema: z.object({ workspaceId: workspaceIdSchema, paths: z.array(z.string()).min(1).max(16), maxLines: z.number().int().positive().max(2000).optional(), maxBytes: z.number().int().positive().max(4 * 1024 * 1024).optional() }) },
    async ({ workspaceId, paths, maxLines, maxBytes }) => { try { return text(await readMultipleFilesWithDesktopCommander({ workspaceId, paths, maxLines, maxBytes, secondaryReadGrants: secondaryReadGrantsFor(workspaceId) }, workspaceRegistry, child)); } catch (e) { return errText(e.message); } });

  server.registerTool('list_directory', { description: 'Bounded browse/list of a primary-workspace directory or one exact granted secondary directory; no parent/trust-root enumeration.', annotations: R, inputSchema: z.object({ workspaceId: workspaceIdSchema, path: z.string().optional(), depth: z.number().int().min(1).max(3).optional(), maxResults: z.number().int().positive().max(1000).optional() }) },
    async ({ workspaceId, path, depth, maxResults }) => { try { return text(await listDirectoryWithDesktopCommander({ workspaceId, path, depth, maxResults, secondaryReadGrants: secondaryReadGrantsFor(workspaceId) }, workspaceRegistry, child)); } catch (e) { return errText(e.message); } });

  server.registerTool('file_info', { description: 'Safe metadata for one exact authorized ordinary file. Sensitive and special-format targets remain blocked.', annotations: R, inputSchema: z.object({ workspaceId: workspaceIdSchema, path: z.string() }) },
    async ({ workspaceId, path }) => { try { return text(await fileInfoWithDesktopCommander({ workspaceId, path, secondaryReadGrants: secondaryReadGrantsFor(workspaceId) }, workspaceRegistry, child)); } catch (e) { return errText(e.message); } });

  server.registerTool('filename_search', { description: 'Bounded filename/path-name search inside the primary workspace or one exact granted secondary directory.', annotations: R, inputSchema: z.object({ workspaceId: workspaceIdSchema, query: z.string(), path: z.string().optional(), maxResults: z.number().int().positive().max(1000).optional() }) },
    async ({ workspaceId, query, path, maxResults }) => { try { return text(await filenameSearchWithDesktopCommander({ workspaceId, query, path, maxResults, secondaryReadGrants: secondaryReadGrantsFor(workspaceId) }, workspaceRegistry, child)); } catch (e) { return errText(e.message); } });

  server.registerTool('search', { description: 'Bounded text search in the primary workspace or one exact explicitly granted secondary directory root.', annotations: R, inputSchema: z.object({ workspaceId: workspaceIdSchema, query: z.string(), path: z.string().optional(), maxResults: z.number().int().positive().max(1000).optional() }) },
    async ({ workspaceId, query, path, maxResults }) => { try { return text(await searchWithOptions({ workspaceId, query, path, maxResults, secondaryReadGrants: secondaryReadGrantsFor(workspaceId) }, workspaceRegistry, { child })); } catch (e) { return errText(e.message); } });

  server.registerTool('read_image', {
    description: 'Read one authorized local PNG/JPEG/GIF/WebP/BMP through the exact pinned DesktopCommander image path. Parent-owned signature, authority, input/output byte bounds, and typed MCP image content. SVG is blocked.',
    annotations: R,
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      path: z.string(),
      maxInputBytes: z.number().int().positive().max(STRUCTURED_READ_LIMITS.image.inputBytes).optional(),
      maxOutputBytes: z.number().int().positive().max(STRUCTURED_READ_LIMITS.image.outputBytes).optional(),
    }).strict(),
  }, async (args) => {
    try {
      return structured(await readImageWithDesktopCommander({
        ...args,
        secondaryReadGrants: secondaryReadGrantsFor(args.workspaceId),
      }, workspaceRegistry, child));
    } catch (e) { return errText(e.message); }
  });

  server.registerTool('read_excel', {
    description: 'Read authorized .xlsx/.xlsm workbook metadata or bounded sheet/range values through a private parent-owned stable snapshot and the exact pinned child ExcelJS path. Successful results include the whole-file baseSha256 for expectedBaseSha256 composition. Parent owns ZIP, authority, row/cell/input/result budgets. Legacy .xls and all writes/formula creation are blocked.',
    annotations: R,
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      path: z.string(),
      mode: z.enum(['metadata', 'values']).optional(),
      sheet: z.string().max(256).optional(),
      range: z.string().max(256).optional(),
      offset: z.number().int().nonnegative().max(1048575).optional(),
      maxRows: z.number().int().positive().max(STRUCTURED_READ_LIMITS.excel.rows).optional(),
      maxCells: z.number().int().positive().max(STRUCTURED_READ_LIMITS.excel.cells).optional(),
      maxInputBytes: z.number().int().positive().max(STRUCTURED_READ_LIMITS.excel.inputBytes).optional(),
      maxOutputBytes: z.number().int().positive().max(STRUCTURED_READ_LIMITS.excel.outputBytes).optional(),
    }).strict(),
  }, async (args) => {
    try {
      return structured(await readExcelWithDesktopCommander({
        ...args,
        secondaryReadGrants: secondaryReadGrantsFor(args.workspaceId),
      }, workspaceRegistry, child));
    } catch (e) { return errText(e.message); }
  });

  server.registerTool('search_excel', {
    description: 'Targeted literal content search in one authorized .xlsx/.xlsm workbook through the pinned child ExcelJS path. Parent owns authority and result/input budgets; no recursive arbitrary search and no .xls/write surface.',
    annotations: R,
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      path: z.string(),
      query: z.string().min(1).max(512),
      maxResults: z.number().int().positive().max(STRUCTURED_READ_LIMITS.excel.results).optional(),
      maxInputBytes: z.number().int().positive().max(STRUCTURED_READ_LIMITS.excel.inputBytes).optional(),
      maxOutputBytes: z.number().int().positive().max(STRUCTURED_READ_LIMITS.excel.outputBytes).optional(),
    }).strict(),
  }, async (args) => {
    try {
      return structured(await searchExcelWithDesktopCommander({
        ...args,
        secondaryReadGrants: secondaryReadGrantsFor(args.workspaceId),
      }, workspaceRegistry, child));
    } catch (e) { return errText(e.message); }
  });

  server.registerTool('read_pdf', {
    description: 'Read bounded pages and text from one authorized local PDF through a private parent-owned stable snapshot and the exact pinned child PDF path, preserving typed bounded embedded image blocks. Successful results include the whole-file baseSha256 for expectedBaseSha256 composition. Parent owns page/text/image/input/output budgets, timeout/recovery, authority, and local-only dispatch. No metadata-only shortcut, creation, or mutation.',
    annotations: R,
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      path: z.string(),
      pageOffset: z.number().int().nonnegative().max(1000000).optional(),
      pageCount: z.number().int().positive().max(STRUCTURED_READ_LIMITS.pdf.pages).optional(),
      maxTextBytes: z.number().int().positive().max(STRUCTURED_READ_LIMITS.pdf.textBytes).optional(),
      maxImages: z.number().int().positive().max(STRUCTURED_READ_LIMITS.pdf.images).optional(),
      maxImageBytes: z.number().int().positive().max(STRUCTURED_READ_LIMITS.pdf.imageBytes).optional(),
      maxOutputBytes: z.number().int().positive().max(STRUCTURED_READ_LIMITS.pdf.outputBytes).optional(),
      maxInputBytes: z.number().int().positive().max(STRUCTURED_READ_LIMITS.pdf.inputBytes).optional(),
      timeoutMs: z.number().int().positive().max(STRUCTURED_READ_LIMITS.pdf.timeoutMs).optional(),
      includeImages: z.boolean().optional(),
    }).strict(),
  }, async (args) => {
    try {
      return structured(await readPdfWithDesktopCommander({
        ...args,
        secondaryReadGrants: secondaryReadGrantsFor(args.workspaceId),
      }, workspaceRegistry, child));
    } catch (e) { return errText(e.message); }
  });

  server.registerTool('read_docx', {
    description: 'Read an authorized .docx outline, bounded raw XML page, or safe bounded info through a private parent-owned stable snapshot and the exact pinned child DOCX path. Successful results include the whole-file baseSha256 for expectedBaseSha256 composition. Parent owns authority, ZIP/decompressed/XML/output/timeout budgets and recovery. No arbitrary XML edit, text edit, or create surface.',
    annotations: R,
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      path: z.string(),
      mode: z.enum(['outline', 'xml', 'info']).optional(),
      offset: z.number().int().nonnegative().max(9999).optional(),
      maxLines: z.number().int().positive().max(STRUCTURED_READ_LIMITS.docx.lines).optional(),
      maxXmlBytes: z.number().int().positive().max(STRUCTURED_READ_LIMITS.docx.xmlBytes).optional(),
      maxInputBytes: z.number().int().positive().max(STRUCTURED_READ_LIMITS.docx.inputBytes).optional(),
      maxOutputBytes: z.number().int().positive().max(STRUCTURED_READ_LIMITS.docx.outputBytes).optional(),
      timeoutMs: z.number().int().positive().max(STRUCTURED_READ_LIMITS.docx.timeoutMs).optional(),
    }).strict(),
  }, async (args) => {
    try {
      return structured(await readDocxWithDesktopCommander({
        ...args,
        secondaryReadGrants: secondaryReadGrantsFor(args.workspaceId),
      }, workspaceRegistry, child));
    } catch (e) { return errText(e.message); }
  });

  server.registerTool('git_status', { description: 'Read-only git status for a bound workspace.', annotations: R, inputSchema: z.object({ workspaceId: workspaceIdSchema }) },
    async ({ workspaceId }) => { try { return text(await gitStatus({ workspaceId }, workspaceRegistry, { child })); } catch (e) { return errText(e.message); } });

  server.registerTool('git_diff', { description: 'Read-only git diff (worktree|staged).', annotations: R, inputSchema: z.object({ workspaceId: workspaceIdSchema, mode: z.enum(['worktree', 'staged']).optional() }) },
    async ({ workspaceId, mode }) => { try { return text(await gitDiff({ workspaceId, mode }, workspaceRegistry, { child })); } catch (e) { return errText(e.message); } });

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

  // ---- Direct Local bounded edit (M3) -------------------------------------
  if (changeSet) {
    server.registerTool('edit', {
      description: 'Two-phase bounded Direct Local edit (preview or apply). One target file, base-hash stale-write protection, atomic apply. Durable apply accepts current Parent authority or a current-step bounded execution claim.',
      annotations: DIRECT_LOCAL_DESTRUCTIVE_ANNOTATIONS,
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

  // ---- Direct Local typed filesystem mutation (Issue #137) ---------------
  // Only these narrow parent-owned operations may reach the child mutation
  // wrappers. The public generic child callTool seam remains unavailable.
  if (filesystemMutation) {
    server.registerTool('filesystem_create_directory', {
      description: 'Create one bounded directory inside the primary workspace through the exact pinned DesktopCommander child. The destination must not already exist; no existing entry is overwritten. Parent owns containment, symlink/junction checks, collision checks, MutationOwner, and deterministic post-readback. Secondary writes and traversal are rejected.',
      annotations: DIRECT_LOCAL_ADDITIVE_IDEMPOTENT_ANNOTATIONS,
      inputSchema: z.object({
        workspaceId: workspaceIdSchema,
        path: z.string().min(1).max(4096),
        taskId: z.string().optional(),
        authorityToken: z.string().optional(),
        executionToken: z.string().optional(),
      }).strict(),
    }, async ({ workspaceId, path: directoryPath, taskId, authorityToken, executionToken }) => {
      try {
        requireDirectLocalMutationAuth(governance, workspaceRegistry, { workspaceId, taskId, authorityToken, executionToken });
        return text(await filesystemMutation.createDirectory({ workspaceId, path: directoryPath }));
      } catch (e) { return errText(e.message); }
    });

    server.registerTool('filesystem_move', {
      description: 'Move one bounded primary-workspace file or directory through the exact pinned DesktopCommander child. Parent owns source/destination containment, symlink/junction checks, collision/type checks, MutationOwner, and deterministic post-readback. Cross-root, traversal, secondary, and delete-like destinations are rejected.',
      annotations: DIRECT_LOCAL_DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS,
      inputSchema: z.object({
        workspaceId: workspaceIdSchema,
        source: z.string().min(1).max(4096),
        destination: z.string().min(1).max(4096),
        taskId: z.string().optional(),
        authorityToken: z.string().optional(),
        executionToken: z.string().optional(),
      }).strict(),
    }, async ({ workspaceId, source, destination, taskId, authorityToken, executionToken }) => {
      try {
        requireDirectLocalMutationAuth(governance, workspaceRegistry, { workspaceId, taskId, authorityToken, executionToken });
        return text(await filesystemMutation.movePath({ workspaceId, source, destination }));
      } catch (e) { return errText(e.message); }
    });
  }

  if (excelMutation) {
    server.registerTool('excel_write_range', {
      description: 'Write a bounded primary-workspace .xlsx/.xlsm cell range through the exact pinned DesktopCommander child or the bounded .xlsm fidelity path. Leading-equals strings remain literal values; formula creation, legacy .xls, secondary writes, and arbitrary child arguments are unsupported. Requires a matching base hash and Direct Local mutation authorization.',
      annotations: DIRECT_LOCAL_DESTRUCTIVE_ANNOTATIONS,
      inputSchema: z.object({
        workspaceId: workspaceIdSchema,
        path: mutationPathSchema,
        range: z.string().min(3).max(256),
        values: excelValuesSchema,
        expectedBaseSha256: sha256Schema,
        ...directLocalMutationAuthFields,
      }).strict(),
    }, async ({ workspaceId, path: filePath, range, values, expectedBaseSha256, taskId, authorityToken, executionToken }) => {
      try {
        requireDirectLocalMutationAuth(governance, workspaceRegistry, { workspaceId, taskId, authorityToken, executionToken });
        return text(await excelMutation.mutateRange({ workspaceId, path: filePath, range, values, expectedBaseSha256 }));
      } catch (e) { return errText(e.message); }
    });
  }

  if (docxMutation) {
    server.registerTool('docx_edit_text', {
      description: 'Replace an exact bounded number of visible text occurrences in a primary-workspace .docx through the exact pinned DesktopCommander child and atomic parent-owned temporary package. Raw XML mutation, secondary writes, and arbitrary child arguments are unsupported. Requires a matching base hash and Direct Local mutation authorization.',
      annotations: DIRECT_LOCAL_DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS,
      inputSchema: z.object({
        workspaceId: workspaceIdSchema,
        path: mutationPathSchema,
        find: z.string().min(1).max(64 * 1024),
        replace: z.string().max(64 * 1024),
        expectedOccurrences: z.number().int().min(1).max(100),
        expectedBaseSha256: sha256Schema,
        ...directLocalMutationAuthFields,
      }).strict(),
    }, async ({ workspaceId, path: filePath, find, replace, expectedOccurrences, expectedBaseSha256, taskId, authorityToken, executionToken }) => {
      try {
        requireDirectLocalMutationAuth(governance, workspaceRegistry, { workspaceId, taskId, authorityToken, executionToken });
        return text(await docxMutation.editText({ workspaceId, path: filePath, find, replace, expectedOccurrences, expectedBaseSha256 }));
      } catch (e) { return errText(e.message); }
    });

    server.registerTool('docx_create_text', {
      description: 'Create one bounded text-based .docx in the primary workspace through the exact pinned DesktopCommander child and atomic parent-owned temporary package. The destination must not already exist; no existing document is overwritten. PDF/browser creation, raw XML mutation, secondary writes, and arbitrary child arguments are unsupported. Requires Direct Local mutation authorization.',
      annotations: DIRECT_LOCAL_ADDITIVE_IDEMPOTENT_ANNOTATIONS,
      inputSchema: z.object({
        workspaceId: workspaceIdSchema,
        path: mutationPathSchema,
        text: z.string().max(1024 * 1024),
        ...directLocalMutationAuthFields,
      }).strict(),
    }, async ({ workspaceId, path: filePath, text: content, taskId, authorityToken, executionToken }) => {
      try {
        requireDirectLocalMutationAuth(governance, workspaceRegistry, { workspaceId, taskId, authorityToken, executionToken });
        return text(await docxMutation.createText({ workspaceId, path: filePath, text: content }));
      } catch (e) { return errText(e.message); }
    });
  }

  if (pdfMutation) {
    server.registerTool('pdf_mutate_pages', {
      description: 'Delete pages or insert an existing PDF into a primary-workspace .pdf using bounded 1-based operations through the exact pinned DesktopCommander child and atomic parent-owned temporary output. Insert sources may use the workspace handle’s explicit secondary read grants; destinations are always primary-only. Markdown/browser creation, cheap metadata, SVG, and arbitrary child arguments are unsupported.',
      annotations: DIRECT_LOCAL_DESTRUCTIVE_ANNOTATIONS,
      inputSchema: z.object({
        workspaceId: workspaceIdSchema,
        path: mutationPathSchema,
        operations: pdfOperationsSchema,
        expectedBaseSha256: sha256Schema,
        ...directLocalMutationAuthFields,
      }).strict(),
    }, async ({ workspaceId, path: filePath, operations, expectedBaseSha256, taskId, authorityToken, executionToken }) => {
      try {
        requireDirectLocalMutationAuth(governance, workspaceRegistry, { workspaceId, taskId, authorityToken, executionToken });
        return text(await pdfMutation.mutatePages({ workspaceId, path: filePath, operations, expectedBaseSha256 }));
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
    const invokeGovernanceTransition = (args) => {
      const txArgs = { ...args };
      if (txArgs.workspaceId) {
        if (governance && typeof governance.authorizeMutation === 'function') txArgs.workspaceRoot = workspaceRegistry.get(txArgs.workspaceId).root;
        delete txArgs.workspaceId;
      }
      return governance.transition(txArgs);
    };

    server.registerTool('governance_plan', {
      description: 'Record only a Parent Brain PLAN control through the existing Governance transition implementation. This is a closed-world, non-read-only, non-destructive admission/control-state operation; durable Governance authority, admission scanning, canonical workspace binding, and fencing remain authoritative.',
      annotations: GOVERNANCE_PLAN_ANNOTATIONS,
      inputSchema: z.object({
        taskId: z.string(),
        projectKey: z.string().optional(),
        identity: z.string().optional(),
        authorityToken: z.string().optional(),
        workspaceId: workspaceIdSchema.optional(),
        route: z.enum(['CHATGPT_NATIVE', 'CHATGPT_DIRECT_LOCAL', 'CODEX_DELEGATE', 'HYBRID']).optional(),
        localRoute: z.enum(['CHATGPT_DIRECT_LOCAL', 'CODEX_DELEGATE']).optional(),
      }).strict(),
    }, async (args) => {
      try { return text(invokeGovernanceTransition({ ...args, control: 'PLAN' })); }
      catch (e) { return errText(e.message); }
    });


    server.registerTool('governance_task', {
      description: "Advance only a Parent-authorized Governance TASK through the existing transition implementation. Any prior current step must already be hard-ready (executorStatus=success and machineGate=pass); advancing marks that prior step brainAcceptance='accepted', mutates durable Governance control/task-step state, creates/selects the new pending execution step, updates route/localRoute when supplied, appends durable control history, and fences any prior bounded execution claim. This action does not directly mutate workspace file contents, publish, terminate, replan, or invalidate acceptance/proofs. Requires current Parent authority for the established task; bounded execution claims never authorize this tool.",
      annotations: GOVERNANCE_TASK_ANNOTATIONS,
      inputSchema: z.object({
        taskId: z.string(),
        stepId: z.string(),
        authorityToken: z.string(),
        workspaceId: workspaceIdSchema.optional(),
        route: z.enum(['CHATGPT_NATIVE', 'CHATGPT_DIRECT_LOCAL', 'CODEX_DELEGATE', 'HYBRID']).optional(),
        localRoute: z.enum(['CHATGPT_DIRECT_LOCAL', 'CODEX_DELEGATE']).optional(),
        acceptance: z.array(z.object({ id: z.string(), required: z.boolean().optional(), requiredEvidenceLevel: z.string().optional() })).optional(),
      }).strict(),
    }, async (args) => {
      try { return text(invokeGovernanceTransition({ ...args, control: 'TASK' })); }
      catch (e) { return errText(e.message); }
    });

    server.registerTool('governance_transition', {
      description: 'Record a Parent Brain governance control (PLAN/TASK/REVISE/REPLAN/ASK_USER/PUBLISH/DONE) with acceptance contract and revise delta. Requires Parent authority in durable Governance; bounded execution claims never authorize this tool.',
      annotations: GOVERNANCE_TRANSITION_ANNOTATIONS,
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
      try { return text(invokeGovernanceTransition(args)); }
      catch (e) { return errText(e.message); }
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
      description: 'Parent continuity re-entry for exactly one uniquely resolved durable Governance task. Resolution requires at least one semantic selector among taskId/projectKey/identity. A successful takeover increments/rotates the durable Parent authority generation, mints a new opaque Parent token, fences prior Parent authority, and fences any prior bounded Direct Local execution claim. authorityToken is optional; when supplied it is a current/stale-authority guard, not a required Human handoff credential. workspaceId is optional and is a canonical workspace validation/binding selector that supports the existing bounded Codex recovery path. Returns the bounded Context Capsule and execution summary. Codex reconciliation, when applicable, uses only the existing recover path; reconciliation may report failure/recovery-required after authority rotation is already committed, and that authority rotation is not rolled back. Bounded execution claims never authorize takeover.',
      annotations: GOVERNANCE_TAKEOVER_ANNOTATIONS,
      inputSchema: z.object({
        taskId: z.string().optional(),
        projectKey: z.string().optional(),
        identity: z.string().optional(),
        authorityToken: z.string().optional(),
        workspaceId: workspaceIdSchema.optional(),
      }).strict(),
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

export { WorkspaceError, COMPOSITE_EDIT_BOUNDARY_BLOCKED };
