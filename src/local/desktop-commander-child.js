// Narrow, parent-owned supervisor for the pinned DesktopCommander MCP child.
// The parent remains authoritative for workspace, governance, mutation-owner,
// and repository-identity checks. This module owns only the stdio child
// lifecycle and the bounded upstream calls used by read/search/git.

import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export const DESKTOP_COMMANDER_PACKAGE = '@wonderwhy-er/desktop-commander';
export const DESKTOP_COMMANDER_VERSION = '0.2.51';
export const DESKTOP_COMMANDER_UPSTREAM_COMMIT = '092ce0b841e86455f12e41f4dc36399a7522ecb5';
export const DESKTOP_COMMANDER_LICENSE = 'MIT';
export const COMPOSITE_EDIT_BOUNDARY_BLOCKED = 'COMPOSITE_EDIT_BOUNDARY_BLOCKED';

// These are the only upstream tools required by the adapter. write_file and
// edit_block are deliberately absent: the existing ChangeSetService remains
// the sole Direct Local edit engine for this phase.
export const DESKTOP_COMMANDER_REQUIRED_TOOLS = Object.freeze([
  'read_file',
  'read_multiple_files',
  'list_directory',
  'get_file_info',
  'start_search',
  'get_more_search_results',
  'stop_search',
  'start_process',
  'read_process_output',
  'force_terminate',
]);

const READ_MAX_BYTES = 4 * 1024 * 1024;
const GIT_MAX_OUTPUT = 200 * 1024;
const SAFE_FAILURE_CODES = new Set([
  'CHILD_CLOSED',
  'CHILD_EXITED',
  'CHILD_TRANSPORT_ERROR',
  'CHILD_CALL_FAILED',
  'CHILD_START_FAILED',
  'MISSING_REQUIRED_TOOL',
  'UPSTREAM_TOOL_ERROR',
  'UPSTREAM_TOOL_NOT_ALLOWED',
  'GIT_COMMAND_FAILED',
  'GIT_COMMAND_TIMEOUT',
]);

function resolvePackageEntry() {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve(`${DESKTOP_COMMANDER_PACKAGE}/package.json`);
  const metadata = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
  if (metadata.name !== DESKTOP_COMMANDER_PACKAGE || metadata.version !== DESKTOP_COMMANDER_VERSION || metadata.license !== DESKTOP_COMMANDER_LICENSE) {
    throw new DesktopCommanderChildError('CHILD_START_FAILED', 'DesktopCommander package provenance mismatch');
  }
  return fileURLToPath(import.meta.resolve(`${DESKTOP_COMMANDER_PACKAGE}/dist/index.js`));
}

function safeFailureCode(code, fallback = 'CHILD_UNAVAILABLE') {
  return SAFE_FAILURE_CODES.has(code) ? code : fallback;
}

function quoteCommandPath(value) {
  if (process.platform === 'win32') return `'${String(value).replace(/'/g, "''")}'`;
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function fixedGitArgs(mode) {
  if (mode === 'status') return ['status', '--short', '--branch'];
  if (mode === 'staged') return ['diff', '--cached', '--no-ext-diff'];
  if (mode === 'worktree') return ['diff', '--no-ext-diff'];
  throw new DesktopCommanderChildError('GIT_COMMAND_FAILED');
}

// The only command string ever sent to DesktopCommander start_process. The
// caller supplies a canonical workspace root and a fixed operation selector,
// never shell text or argv supplied by a user.
export function fixedGitCommand(workspaceRoot, mode) {
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot) || /[\r\n\0]/u.test(workspaceRoot)) {
    throw new DesktopCommanderChildError('GIT_COMMAND_FAILED', 'git workspace root must be an absolute safe path');
  }
  return ['git', '-C', quoteCommandPath(workspaceRoot), '--no-pager', ...fixedGitArgs(mode)].join(' ');
}

async function closePair(client, transport) {
  const pid = transport?.pid;
  try { await client?.close?.(); } catch {}
  try { await transport?.close?.(); } catch {}
  // StdioClientTransport.close() closes the protocol stream; explicitly reap
  // the pinned local child as well so normal server shutdown cannot orphan it.
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
}

function clipUtf8(text, maxBytes) {
  const buf = Buffer.from(String(text ?? ''), 'utf8');
  if (buf.length <= maxBytes) return { text: buf.toString('utf8'), truncated: false };
  return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

function stripInitialOutput(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  const marker = normalized.match(/Initial output:\s*\n?/iu);
  return marker ? normalized.slice(marker.index + marker[0].length) : normalized;
}

function processPid(text) {
  const match = String(text || '').match(/\bPID\s+(\d+)/iu);
  return match ? Number(match[1]) : null;
}

function processComplete(text) {
  return /Process completed with exit code\s+(-?\d+)/iu.test(String(text || ''));
}

function processExitCode(text) {
  const match = String(text || '').match(/Process completed with exit code\s+(-?\d+)/iu);
  return match ? Number(match[1]) : null;
}

function processRunning(text) {
  return /Process is running|process is still running|Process still running/iu.test(String(text || '')) && !processComplete(text);
}

function processOutput(text) {
  let output = stripInitialOutput(text);
  output = output.replace(/^\[Reading [^\n]*\]\n\n/u, '');
  output = output.replace(/\n?\s*(?:⏳\s*)?Process is running\.?.*$/isu, '');
  output = output.replace(/\n?\s*✅\s*Process completed with exit code\s+-?\d+[^\n]*$/iu, '');
  output = output.replace(/\n?\s*Process completed with exit code\s+-?\d+[^\n]*$/iu, '');
  return output;
}

export class DesktopCommanderChildError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'DesktopCommanderChildError';
    this.code = safeFailureCode(code);
  }
}

export function extractTextContent(result) {
  if (!result || result.isError) throw new DesktopCommanderChildError('UPSTREAM_TOOL_ERROR');
  const content = Array.isArray(result.content) ? result.content : [];
  return content.filter((item) => item && item.type === 'text').map((item) => String(item.text ?? '')).join('\n');
}

export const extractText = extractTextContent;

export function compositeEditBoundaryVerdict() {
  return COMPOSITE_EDIT_BOUNDARY_BLOCKED;
}

export class DesktopCommanderChild {
  #entryPoint;
  #environmentOverrides;
  #client = null;
  #transport = null;
  #startPromise = null;
  #closed = false;
  #state = 'idle';
  #generation = 0;
  #availableTools = new Set();
  #listedTools = [];
  #lastFailureCode = null;

  constructor({ entryPoint = null, environmentOverrides = {} } = {}) {
    this.#entryPoint = entryPoint || resolvePackageEntry();
    this.#environmentOverrides = { ...environmentOverrides };
  }

  get state() { return this.#state; }
  get generation() { return this.#generation; }

  health() {
    return {
      state: this.#state,
      version: DESKTOP_COMMANDER_VERSION,
      generation: this.#generation,
    };
  }

  async ensureReady() {
    if (this.#closed) throw new DesktopCommanderChildError('CHILD_CLOSED', 'DesktopCommander child is closed');
    if (this.#state === 'ready' && this.#client && this.#transport) return this;
    if (!this.#startPromise) this.#startPromise = this.#start().finally(() => { this.#startPromise = null; });
    await this.#startPromise;
    return this;
  }

  async close() {
    this.#closed = true;
    this.#state = 'stopping';
    try { await this.#startPromise; } catch {}
    const pair = this.#detachCurrent();
    await closePair(pair.client, pair.transport);
    this.#availableTools.clear();
    this.#listedTools = [];
    this.#state = 'stopped';
  }

  async listTools() {
    await this.ensureReady();
    return { tools: this.#listedTools.map((tool) => ({ ...tool })) };
  }

  // Test-only lifecycle hook. It is not part of the MCP surface.
  terminateForTest() {
    const pid = this.#transport?.pid;
    if (!pid) return false;
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  }

  killForTest() { return this.terminateForTest(); }

  async readFile({ path: filePath, offset = 0, maxLines = 2000, maxBytes = READ_MAX_BYTES } = {}) {
    const result = await this.#callTool('read_file', {
      path: filePath,
      isUrl: false,
      offset,
      length: maxLines,
      origin: 'llm',
    });
    // The parent reapplies byte and line bounds. Keep the child response itself
    // bounded as well so a pathological single line cannot cross the adapter's
    // hard read ceiling before normalization.
    const clipped = clipUtf8(extractTextContent(result), Math.min(READ_MAX_BYTES + 1, maxBytes + 1));
    return clipped.text;
  }

  // Internal structured-read seam. The MCP surface never exposes arbitrary
  // upstream tool calls; structured-read.js supplies the parent-owned
  // extension, authority, and byte/page/cell budgets before using this exact
  // pinned child read_file path. Return the raw MCP result so image blocks are
  // not flattened into base64 text.
  async readFileStructured({ path: filePath, offset = 0, maxLines = 2000, sheet, range } = {}) {
    const args = {
      path: filePath,
      isUrl: false,
      offset,
      length: maxLines,
      origin: 'llm',
    };
    if (sheet !== undefined) args.sheet = sheet;
    if (range !== undefined) args.range = range;
    return this.#callTool('read_file', args);
  }

  // A parent timeout must invalidate the current generation before the next
  // request can lazily restart it. Pair-identity checks in #callTool/#markDead
  // prevent a late response from an old child from killing a new generation.
  async recoverAfterTimeout() {
    if (this.#closed) return;
    const pair = this.#detachCurrent();
    this.#state = 'dead';
    this.#lastFailureCode = 'CHILD_CALL_FAILED';
    await closePair(pair.client, pair.transport);
  }

  async readMultipleFiles({ paths = [] } = {}) {
    const result = await this.#callTool('read_multiple_files', { paths, origin: 'llm' });
    return clipUtf8(extractTextContent(result), READ_MAX_BYTES + (64 * 1024)).text;
  }

  async listDirectory({ path: directoryPath, depth = 1 } = {}) {
    const result = await this.#callTool('list_directory', { path: directoryPath, depth, origin: 'llm' });
    const clipped = clipUtf8(extractTextContent(result), 256 * 1024);
    return { output: clipped.text, truncated: clipped.truncated };
  }

  async getFileInfo({ path: filePath } = {}) {
    const result = await this.#callTool('get_file_info', { path: filePath, origin: 'llm' });
    return clipUtf8(extractTextContent(result), 64 * 1024).text;
  }

  async startSearch(args = {}) {
    return extractTextContent(await this.#callTool('start_search', args));
  }

  async getMoreSearchResults(args = {}) {
    return extractTextContent(await this.#callTool('get_more_search_results', args));
  }

  async stopSearch(args = {}) {
    return extractTextContent(await this.#callTool('stop_search', args));
  }

  async runGit({ workspaceRoot, mode = 'worktree' } = {}) {
    const command = fixedGitCommand(workspaceRoot, mode);
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
    const startedText = extractTextContent(await this.#callTool('start_process', {
      command,
      timeout_ms: 5000,
      shell,
      origin: 'llm',
    }, { internal: true }));
    let text = startedText;
    let pid = processPid(text);
    let truncated = false;
    let collected = processOutput(text);

    for (let attempt = 0; attempt < 8 && pid && !processComplete(text); attempt += 1) {
      if (!processRunning(text) && attempt > 0) break;
      const output = extractTextContent(await this.#callTool('read_process_output', {
        pid,
        offset: 0,
        length: 5000,
        timeout_ms: 1000,
      }, { internal: true }));
      text = output;
      const page = processOutput(output);
      if (page && !/^\(No output in requested range\)$/u.test(page.trim())) collected = page;
      if (processComplete(text)) break;
      if (!processRunning(text)) break;
    }

    if (pid && !processComplete(text) && processRunning(text)) {
      truncated = true;
      try { await this.#callTool('force_terminate', { pid }, { internal: true }); } catch {}
      throw new DesktopCommanderChildError('GIT_COMMAND_TIMEOUT');
    }
    if (processExitCode(text) !== null && processExitCode(text) !== 0) {
      throw new DesktopCommanderChildError('GIT_COMMAND_FAILED');
    }
    const clipped = clipUtf8(collected, GIT_MAX_OUTPUT);
    return { output: clipped.text, truncated: truncated || clipped.truncated };
  }

  async callTool(name, args = {}) {
    // Process/session tools stay behind the fixed internal git boundary. The
    // wrapper never becomes a general shell surface.
    if (name === 'start_process' || name === 'read_process_output' || name === 'force_terminate') {
      throw new DesktopCommanderChildError('UPSTREAM_TOOL_NOT_ALLOWED');
    }
    return this.#callTool(name, args);
  }

  async #callTool(name, args = {}, { internal = false } = {}) {
    const processTool = name === 'start_process' || name === 'read_process_output' || name === 'force_terminate';
    if (!DESKTOP_COMMANDER_REQUIRED_TOOLS.includes(name) || (processTool && !internal)) {
      throw new DesktopCommanderChildError('UPSTREAM_TOOL_NOT_ALLOWED');
    }
    let client = null;
    let transport = null;
    try {
      await this.ensureReady();
      client = this.#client;
      transport = this.#transport;
      if (!client) throw new DesktopCommanderChildError('CHILD_CLOSED');
      const result = await client.callTool({ name, arguments: args });
      if (result?.isError) throw new DesktopCommanderChildError('UPSTREAM_TOOL_ERROR');
      return result;
    } catch (error) {
      if (error instanceof DesktopCommanderChildError) {
        if (!this.#closed && error.code !== 'UPSTREAM_TOOL_ERROR') this.#markDead(error.code, client, transport);
        throw error;
      }
      if (!this.#closed) this.#markDead('CHILD_CALL_FAILED', client, transport);
      throw new DesktopCommanderChildError('CHILD_CALL_FAILED');
    }
  }

  async #start() {
    this.#state = 'starting';
    this.#lastFailureCode = null;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [this.#entryPoint, '--no-onboarding'],
      env: {
        ...process.env,
        ...this.#environmentOverrides,
        DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
      },
      stderr: 'pipe',
    });
    // Drain child diagnostics without forwarding them to MCP responses or
    // retaining paths/errors in parent state.
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'chatgpt-codex-orchestrator-child', version: '0.2.0' });

    this.#transport = transport;
    this.#client = client;
    transport.onclose = () => {
      if (this.#transport !== transport) return;
      this.#transport = null;
      this.#client = null;
      if (!this.#closed) {
        this.#state = 'dead';
        this.#lastFailureCode = 'CHILD_EXITED';
      }
    };
    transport.onerror = () => {
      if (!this.#closed) this.#lastFailureCode = 'CHILD_TRANSPORT_ERROR';
    };

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const names = Array.isArray(listed?.tools)
        ? listed.tools
          .filter((tool) => tool && typeof tool.name === 'string' && tool.inputSchema && typeof tool.inputSchema === 'object')
          .map((tool) => tool.name)
        : [];
      this.#availableTools = new Set(names);
      this.#listedTools = Array.isArray(listed?.tools) ? listed.tools : [];
      const missing = DESKTOP_COMMANDER_REQUIRED_TOOLS.filter((name) => !this.#availableTools.has(name));
      if (missing.length > 0) throw new DesktopCommanderChildError('MISSING_REQUIRED_TOOL');
      const serverVersion = client.getServerVersion?.();
      if (!serverVersion || serverVersion.name !== 'desktop-commander' || serverVersion.version !== DESKTOP_COMMANDER_VERSION) {
        throw new DesktopCommanderChildError('CHILD_START_FAILED', 'DesktopCommander server version mismatch');
      }
      if (this.#closed || this.#transport !== transport) throw new DesktopCommanderChildError('CHILD_CLOSED');
      this.#generation += 1;
      this.#state = 'ready';
    } catch (error) {
      const safe = error instanceof DesktopCommanderChildError
        ? error
        : new DesktopCommanderChildError('CHILD_START_FAILED');
      this.#lastFailureCode = safe.code;
      if (this.#transport === transport) {
        this.#transport = null;
        this.#client = null;
      }
      this.#listedTools = [];
      await closePair(client, transport);
      if (!this.#closed) this.#state = 'failed';
      throw safe;
    }
  }

  #detachCurrent() {
    const pair = { client: this.#client, transport: this.#transport };
    this.#client = null;
    this.#transport = null;
    return pair;
  }

  #markDead(code, expectedClient = null, expectedTransport = null) {
    if (this.#closed) return;
    if (expectedClient && this.#client !== expectedClient) return;
    if (expectedTransport && this.#transport !== expectedTransport) return;
    const pair = this.#detachCurrent();
    this.#state = 'dead';
    this.#lastFailureCode = safeFailureCode(code, 'CHILD_CALL_FAILED');
    void closePair(pair.client, pair.transport);
  }
}

export function createDesktopCommanderChild(options = {}) {
  return new DesktopCommanderChild(options);
}
