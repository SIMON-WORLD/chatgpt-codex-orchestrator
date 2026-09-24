import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { RelayError } from './core.js';
import { PROCESS_LIMITS } from '../local/process.js';
import { STRUCTURED_READ_LIMITS } from '../local/structured-read.js';

const R = { readOnlyHint: true };
const M = { readOnlyHint: false, destructiveHint: true };
const DIRECT_LOCAL_DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
const DIRECT_LOCAL_DESTRUCTIVE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const DIRECT_LOCAL_ADDITIVE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const PROCESS_START = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
const PROCESS_TERMINATE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const workspaceIdSchema = z.string().min(1);
const mutationPathSchema = z.string().min(1).max(4096);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/iu);
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

function relayFail(code, message = code, status = 400) {
  throw new RelayError(code, message, status);
}

function publicDevice(state) {
  return {
    deviceId: state.deviceId,
    displayName: state.displayName,
    online: state.online,
    executorReady: state.executorReady,
    ready: state.ready,
    lastSeenAt: state.lastSeenAt,
  };
}

function parsedResult(response) {
  if (response?.structuredContent && typeof response.structuredContent === 'object') return response.structuredContent;
  const text = response?.content?.find?.((item) => item?.type === 'text')?.text;
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return null; }
}

function rewriteValue(value, replacements) {
  if (Array.isArray(value)) return value.map((item) => rewriteValue(item, replacements));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = rewriteValue(item, replacements);
    return out;
  }
  if (typeof value === 'string' && replacements.has(value)) return replacements.get(value);
  return value;
}

function rewriteResponse(response, replacements) {
  if (!response || typeof response !== 'object') return response;
  const out = { ...response };
  if (out.structuredContent && typeof out.structuredContent === 'object') {
    out.structuredContent = rewriteValue(out.structuredContent, replacements);
  }
  if (Array.isArray(out.content)) {
    out.content = out.content.map((item) => {
      if (item?.type !== 'text' || typeof item.text !== 'string') return item;
      try {
        const parsed = JSON.parse(item.text);
        return { ...item, text: JSON.stringify(rewriteValue(parsed, replacements), null, 2) };
      } catch {
        return item;
      }
    });
  }
  return out;
}

function errorResult(error) {
  const code = typeof error?.code === 'string' ? error.code : 'RELAY_TOOL_FAILED';
  const message = typeof error?.message === 'string' ? error.message : code;
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }, null, 2) }],
    isError: true,
  };
}

export class RelayMcpFacade {
  constructor({ core } = {}) {
    if (!core?.store) throw new TypeError('RelayMcpFacade requires RelayCore');
    this.core = core;
    this.store = core.store;
  }

  listDevices(accountId) {
    return this.store.listDevices(accountId)
      .filter((row) => !row.revoked_at)
      .map((row) => publicDevice(this.core.summary(row)));
  }

  selectReadyDevice(accountId, requestedDeviceId = null) {
    if (requestedDeviceId) {
      const row = this.store.deviceForAccount(accountId, requestedDeviceId);
      if (!row || row.revoked_at) relayFail('DEVICE_NOT_FOUND', 'device not found', 404);
      const state = this.core.summary(row);
      if (!state.ready) relayFail(state.online ? 'DEVICE_NOT_READY' : 'DEVICE_OFFLINE', state.online ? 'device not ready' : 'device offline', 409);
      return state;
    }
    const ready = this.store.listDevices(accountId)
      .filter((row) => !row.revoked_at)
      .map((row) => this.core.summary(row))
      .filter((state) => state.ready);
    if (ready.length === 0) relayFail('NO_READY_DEVICE', 'no Ready device is available', 409);
    if (ready.length > 1) relayFail('DEVICE_SELECTION_REQUIRED', 'multiple Ready devices require an explicit deviceId', 409);
    return ready[0];
  }

  async workspaceOpen(accountId, args) {
    const { deviceId = null, ...localArgs } = args || {};
    const device = this.selectReadyDevice(accountId, deviceId);
    const response = await this.core.dispatchForAccount({
      accountId,
      deviceId: device.deviceId,
      payload: { method: 'tools/call', params: { name: 'workspace_open', arguments: localArgs } },
    });
    if (response?.isError) return response;
    const parsed = parsedResult(response);
    const localWorkspaceId = parsed?.workspaceId;
    if (typeof localWorkspaceId !== 'string' || !localWorkspaceId) relayFail('LOCAL_WORKSPACE_HANDLE_MISSING', 'device did not return a workspaceId', 502);
    const affinity = this.store.createWorkspaceAffinity({
      accountId,
      deviceId: device.deviceId,
      runtimeId: device.runtimeId,
      localWorkspaceId,
      now: this.core.now(),
    });
    return rewriteResponse(response, new Map([[localWorkspaceId, affinity.relay_workspace_id]]));
  }

  resolveWorkspace(accountId, relayWorkspaceId) {
    const affinity = this.store.workspaceAffinity(accountId, relayWorkspaceId);
    if (!affinity) relayFail('WORKSPACE_HANDLE_NOT_FOUND', 'workspace handle is invalid for this account', 404);
    if (affinity.invalidated_at) relayFail('STALE_WORKSPACE_HANDLE', 'workspace handle has been invalidated', 409);
    const row = this.store.deviceForAccount(accountId, affinity.device_id);
    if (!row) relayFail('WORKSPACE_HANDLE_NOT_FOUND', 'workspace handle is invalid for this account', 404);
    if (row.revoked_at) relayFail('DEVICE_REVOKED', 'device revoked', 403);
    if (!row.last_runtime_id || row.last_runtime_id !== affinity.runtime_id) {
      relayFail('STALE_WORKSPACE_HANDLE', 'device runtime changed; workspace handle is stale', 409);
    }
    return { affinity, device: this.core.summary(row) };
  }

  resolveProcess(accountId, relayWorkspaceId, relayProcessHandle) {
    const workspace = this.resolveWorkspace(accountId, relayWorkspaceId);
    const process = this.store.processAffinity(accountId, relayProcessHandle);
    if (!process) relayFail('PROCESS_HANDLE_NOT_FOUND', 'process handle is invalid for this account', 404);
    if (process.invalidated_at) relayFail('STALE_PROCESS_HANDLE', 'process handle has been invalidated', 409);
    if (process.relay_workspace_id !== relayWorkspaceId ||
        process.device_id !== workspace.affinity.device_id ||
        process.runtime_id !== workspace.affinity.runtime_id) {
      relayFail('PROCESS_HANDLE_MISMATCH', 'process handle does not belong to this workspace/device/runtime', 409);
    }
    return { ...workspace, process };
  }

  async workspaceTool(accountId, name, args) {
    const relayWorkspaceId = args?.workspaceId;
    const resolved = this.resolveWorkspace(accountId, relayWorkspaceId);
    const localArgs = { ...args, workspaceId: resolved.affinity.local_workspace_id };
    const replacements = new Map([[resolved.affinity.local_workspace_id, relayWorkspaceId]]);

    if (name === 'process_read_output' || name === 'process_terminate') {
      const process = this.resolveProcess(accountId, relayWorkspaceId, args?.processHandle);
      localArgs.processHandle = process.process.local_process_handle;
      replacements.set(process.process.local_process_handle, args.processHandle);
      this.store.touchProcessAffinity(process.process.relay_process_handle, this.core.now());
    }

    const response = await this.core.dispatchForAccount({
      accountId,
      deviceId: resolved.affinity.device_id,
      payload: { method: 'tools/call', params: { name, arguments: localArgs } },
    });

    if (name === 'process_start' && !response?.isError) {
      const parsed = parsedResult(response);
      const localProcessHandle = parsed?.processHandle;
      if (typeof localProcessHandle !== 'string' || !localProcessHandle) relayFail('LOCAL_PROCESS_HANDLE_MISSING', 'device did not return a processHandle', 502);
      const process = this.store.createProcessAffinity({
        accountId,
        deviceId: resolved.affinity.device_id,
        runtimeId: resolved.affinity.runtime_id,
        relayWorkspaceId,
        localProcessHandle,
        now: this.core.now(),
      });
      replacements.set(localProcessHandle, process.relay_process_handle);
    }

    this.store.touchWorkspaceAffinity(relayWorkspaceId, this.core.now());
    return rewriteResponse(response, replacements);
  }
}

function register(server, facade, accountId, name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try { return await handler(args); }
    catch (error) { return errorResult(error); }
  });
}

export function createRelayToolsServer({ facade, accountId } = {}) {
  if (!(facade instanceof RelayMcpFacade)) throw new TypeError('createRelayToolsServer requires RelayMcpFacade');
  if (!accountId) throw new TypeError('createRelayToolsServer requires authenticated accountId');
  const server = new McpServer({ name: 'chatgpt-codex-orchestrator-relay', version: '0.2.0-dev' });

  register(server, facade, accountId, 'list_devices', {
    description: 'List only non-revoked paired devices belonging to the authenticated account. Device credentials, account tokens, local filesystem policy, runtime ids, and connection metadata are not exposed.',
    annotations: R,
    inputSchema: z.object({}).strict(),
  }, async () => ({
    content: [{ type: 'text', text: JSON.stringify({ devices: facade.listDevices(accountId) }, null, 2) }],
  }));

  register(server, facade, accountId, 'workspace_open', {
    description: 'Open a workspace on one exact Ready paired device. If deviceId is omitted exactly one Ready device is required. The returned workspaceId is relay-owned and opaque.',
    annotations: R,
    inputSchema: z.object({
      path: z.string().optional(),
      fixture: z.string().optional(),
      secondaryReadGrants: z.array(z.string()).max(16).optional(),
      deviceId: z.string().min(1).optional(),
    }).strict(),
  }, (args) => facade.workspaceOpen(accountId, args));

  const route = (name) => (args) => facade.workspaceTool(accountId, name, args);

  register(server, facade, accountId, 'process_start', {
    description: 'Start one bounded command on the device bound to relay workspaceId. Returns a relay-owned opaque processHandle.',
    annotations: PROCESS_START,
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      command: z.string().min(1).max(PROCESS_LIMITS.commandBytes),
      shell: z.enum(['default', 'powershell', 'pwsh', 'cmd', 'sh']).optional(),
      timeoutMs: z.number().int().min(1).max(PROCESS_LIMITS.startTimeoutMs).optional(),
    }).strict(),
  }, route('process_start'));

  register(server, facade, accountId, 'process_read_output', {
    description: 'Read output only through a relay-owned processHandle bound to the same account, device, runtime and workspace.',
    annotations: R,
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      processHandle: z.string().min(1).max(128),
      offset: z.number().int().min(-PROCESS_LIMITS.maxOffset).max(PROCESS_LIMITS.maxOffset).optional(),
      length: z.number().int().min(1).max(PROCESS_LIMITS.maxReadLines).optional(),
      timeoutMs: z.number().int().min(1).max(PROCESS_LIMITS.readTimeoutMs).optional(),
    }).strict(),
  }, route('process_read_output'));

  register(server, facade, accountId, 'process_terminate', {
    description: 'Terminate only a relay-owned processHandle bound to the same account, device, runtime and workspace.',
    annotations: PROCESS_TERMINATE,
    inputSchema: z.object({ workspaceId: workspaceIdSchema, processHandle: z.string().min(1).max(128) }).strict(),
  }, route('process_terminate'));

  const simple = [
    ['read', R, z.object({ workspaceId: workspaceIdSchema, path: z.string(), offset: z.number().int().nonnegative().optional(), maxLines: z.number().int().positive().max(2000).optional(), maxBytes: z.number().int().positive().max(4 * 1024 * 1024).optional() }).strict()],
    ['read_multiple', R, z.object({ workspaceId: workspaceIdSchema, paths: z.array(z.string()).min(1).max(16), maxLines: z.number().int().positive().max(2000).optional(), maxBytes: z.number().int().positive().max(4 * 1024 * 1024).optional() }).strict()],
    ['list_directory', R, z.object({ workspaceId: workspaceIdSchema, path: z.string().optional(), depth: z.number().int().min(1).max(3).optional(), maxResults: z.number().int().positive().max(1000).optional() }).strict()],
    ['file_info', R, z.object({ workspaceId: workspaceIdSchema, path: z.string() }).strict()],
    ['filename_search', R, z.object({ workspaceId: workspaceIdSchema, query: z.string(), path: z.string().optional(), maxResults: z.number().int().positive().max(1000).optional() }).strict()],
    ['search', R, z.object({ workspaceId: workspaceIdSchema, query: z.string(), path: z.string().optional(), maxResults: z.number().int().positive().max(1000).optional() }).strict()],
    ['git_status', R, z.object({ workspaceId: workspaceIdSchema }).strict()],
    ['git_diff', R, z.object({ workspaceId: workspaceIdSchema, mode: z.enum(['worktree', 'staged']).optional() }).strict()],
    ['edit', DIRECT_LOCAL_DESTRUCTIVE, z.object({
      workspaceId: workspaceIdSchema,
      mode: z.enum(['preview', 'apply']),
      changeSetId: z.string().optional(),
      change: z.object({
        path: z.string(),
        baseHash: z.string().nullable().optional(),
        replacements: z.array(z.object({ oldText: z.string(), newText: z.string(), expectedOccurrences: z.number().int().positive().optional() })).optional(),
        createContent: z.string().nullable().optional(),
      }).strict().optional(),
    }).strict()],
    ['filesystem_create_directory', DIRECT_LOCAL_ADDITIVE_IDEMPOTENT, z.object({ workspaceId: workspaceIdSchema, path: mutationPathSchema }).strict()],
    ['filesystem_move', DIRECT_LOCAL_DESTRUCTIVE_IDEMPOTENT, z.object({ workspaceId: workspaceIdSchema, source: mutationPathSchema, destination: mutationPathSchema }).strict()],
    ['verify', M, z.object({ workspaceId: workspaceIdSchema, check: z.string() }).strict()],
  ];
  for (const [name, annotations, inputSchema] of simple) {
    register(server, facade, accountId, name, {
      description: 'Forward the existing device-local ' + name + ' operation to the exact device bound by relay workspaceId; device-local authorization remains authoritative.',
      annotations,
      inputSchema,
    }, route(name));
  }

  register(server, facade, accountId, 'read_image', {
    description: 'Forward the existing device-local bounded image read through relay workspace affinity.',
    annotations: R,
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      path: z.string(),
      maxInputBytes: z.number().int().positive().max(STRUCTURED_READ_LIMITS.image.inputBytes).optional(),
      maxOutputBytes: z.number().int().positive().max(STRUCTURED_READ_LIMITS.image.outputBytes).optional(),
    }).strict(),
  }, route('read_image'));

  register(server, facade, accountId, 'read_excel', {
    description: 'Forward the existing device-local bounded Excel read through relay workspace affinity.',
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
  }, route('read_excel'));

  register(server, facade, accountId, 'search_excel', {
    description: 'Forward the existing device-local bounded Excel search through relay workspace affinity.',
    annotations: R,
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      path: z.string(),
      query: z.string().min(1).max(512),
      maxResults: z.number().int().positive().max(STRUCTURED_READ_LIMITS.excel.results).optional(),
      maxInputBytes: z.number().int().positive().max(STRUCTURED_READ_LIMITS.excel.inputBytes).optional(),
      maxOutputBytes: z.number().int().positive().max(STRUCTURED_READ_LIMITS.excel.outputBytes).optional(),
    }).strict(),
  }, route('search_excel'));

  register(server, facade, accountId, 'read_pdf', {
    description: 'Forward the existing device-local bounded PDF read through relay workspace affinity.',
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
  }, route('read_pdf'));

  register(server, facade, accountId, 'read_docx', {
    description: 'Forward the existing device-local bounded DOCX read through relay workspace affinity.',
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
  }, route('read_docx'));

  register(server, facade, accountId, 'excel_write_range', {
    description: 'Forward the existing bounded Excel mutation to the exact device; device-local stale-write and mutation ownership remain authoritative.',
    annotations: DIRECT_LOCAL_DESTRUCTIVE,
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      path: mutationPathSchema,
      range: z.string().min(3).max(256),
      values: excelValuesSchema,
      expectedBaseSha256: sha256Schema,
    }).strict(),
  }, route('excel_write_range'));

  register(server, facade, accountId, 'docx_edit_text', {
    description: 'Forward the existing bounded DOCX edit to the exact device; device-local stale-write and mutation ownership remain authoritative.',
    annotations: DIRECT_LOCAL_DESTRUCTIVE_IDEMPOTENT,
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      path: mutationPathSchema,
      find: z.string().min(1).max(64 * 1024),
      replace: z.string().max(64 * 1024),
      expectedOccurrences: z.number().int().min(1).max(100),
      expectedBaseSha256: sha256Schema,
    }).strict(),
  }, route('docx_edit_text'));

  register(server, facade, accountId, 'docx_create_text', {
    description: 'Forward the existing bounded DOCX creation to the exact device; device-local workspace policy remains authoritative.',
    annotations: DIRECT_LOCAL_ADDITIVE_IDEMPOTENT,
    inputSchema: z.object({ workspaceId: workspaceIdSchema, path: mutationPathSchema, text: z.string().max(1024 * 1024) }).strict(),
  }, route('docx_create_text'));

  register(server, facade, accountId, 'pdf_mutate_pages', {
    description: 'Forward the existing bounded PDF mutation to the exact device; device-local stale-write and mutation ownership remain authoritative.',
    annotations: DIRECT_LOCAL_DESTRUCTIVE,
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      path: mutationPathSchema,
      operations: pdfOperationsSchema,
      expectedBaseSha256: sha256Schema,
    }).strict(),
  }, route('pdf_mutate_pages'));

  return server;
}
