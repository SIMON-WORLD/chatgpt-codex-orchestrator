import crypto from 'node:crypto';
import process from 'node:process';
import { DesktopCommanderChildError } from './desktop-commander-child.js';
import { WorkspaceError } from './workspace.js';

export const PROCESS_LIMITS = Object.freeze({
  commandBytes: 32 * 1024,
  startTimeoutMs: 10_000,
  readTimeoutMs: 10_000,
  maxReadLines: 2_000,
  maxOffset: 1_000_000,
  initialOutputBytes: 64 * 1024,
  readOutputBytes: 256 * 1024,
});

const SHELLS = new Set(['default', 'powershell', 'pwsh', 'cmd', 'sh']);

function utf8Bytes(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

function clipUtf8(value, maxBytes) {
  const buf = Buffer.from(String(value ?? ''), 'utf8');
  if (buf.length <= maxBytes) return { output: buf.toString('utf8'), truncated: false };
  return { output: buf.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteSh(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function quoteCmd(value) {
  const text = String(value);
  if (/["\r\n\0]/u.test(text)) throw new ProcessCapabilityError('PROCESS_INVALID_WORKSPACE', 'workspace path cannot be represented safely for cmd');
  return `"${text}"`;
}

function shellConfig(shell = 'default', platform = process.platform) {
  if (!SHELLS.has(shell)) throw new ProcessCapabilityError('PROCESS_INVALID_SHELL', 'unsupported process shell');
  if (shell === 'powershell') {
    if (platform !== 'win32') throw new ProcessCapabilityError('PROCESS_INVALID_SHELL', 'powershell is supported only on Windows');
    return { upstreamShell: 'powershell.exe', family: 'powershell' };
  }
  if (shell === 'pwsh') return { upstreamShell: platform === 'win32' ? 'pwsh.exe' : 'pwsh', family: 'powershell' };
  if (shell === 'cmd') {
    if (platform !== 'win32') throw new ProcessCapabilityError('PROCESS_INVALID_SHELL', 'cmd is supported only on Windows');
    return { upstreamShell: 'cmd.exe', family: 'cmd' };
  }
  if (shell === 'sh') {
    if (platform === 'win32') throw new ProcessCapabilityError('PROCESS_INVALID_SHELL', 'sh is supported only on Unix-like hosts');
    return { upstreamShell: '/bin/sh', family: 'sh' };
  }
  return platform === 'win32'
    ? { upstreamShell: 'cmd.exe', family: 'cmd' }
    : { upstreamShell: '/bin/sh', family: 'sh' };
}

function commandWithInitialCwd(workspaceRoot, command, family) {
  if (family === 'powershell') return `Set-Location -LiteralPath ${quotePowerShellLiteral(workspaceRoot)}; ${command}`;
  if (family === 'cmd') return `cd /d ${quoteCmd(workspaceRoot)} && ${command}`;
  return `cd ${quoteSh(workspaceRoot)} && ${command}`;
}

function assertTimeout(value, max, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new ProcessCapabilityError('PROCESS_LIMIT_EXCEEDED', `${label} must be an integer between 1 and ${max}`);
  }
  return value;
}

function assertReadPaging({ offset = 0, length = 1000 } = {}) {
  if (!Number.isInteger(offset) || offset < -PROCESS_LIMITS.maxOffset || offset > PROCESS_LIMITS.maxOffset) {
    throw new ProcessCapabilityError('PROCESS_LIMIT_EXCEEDED', `offset must be between -${PROCESS_LIMITS.maxOffset} and ${PROCESS_LIMITS.maxOffset}`);
  }
  if (!Number.isInteger(length) || length < 1 || length > PROCESS_LIMITS.maxReadLines) {
    throw new ProcessCapabilityError('PROCESS_LIMIT_EXCEEDED', `length must be between 1 and ${PROCESS_LIMITS.maxReadLines}`);
  }
  return { offset, length };
}

function publicState(record, extra = {}) {
  const result = {
    processHandle: record.processHandle,
    status: record.status,
    ...extra,
  };
  if (Number.isInteger(record.exitCode)) result.exitCode = record.exitCode;
  return result;
}

export class ProcessCapabilityError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ProcessCapabilityError';
    this.code = code;
  }
}

export class ProcessService {
  #workspaceRegistry;
  #child;
  #platform;
  #handles = new Map();
  #closed = false;

  constructor({ workspaceRegistry, desktopCommanderChild, platform = process.platform } = {}) {
    if (!workspaceRegistry) throw new Error('ProcessService requires workspaceRegistry');
    if (!desktopCommanderChild) throw new Error('ProcessService requires desktopCommanderChild');
    this.#workspaceRegistry = workspaceRegistry;
    this.#child = desktopCommanderChild;
    this.#platform = platform;
  }

  get activeHandleCount() {
    let count = 0;
    for (const record of this.#handles.values()) if (record.status === 'running') count += 1;
    return count;
  }

  async start({ workspaceId, command, shell = 'default', timeoutMs } = {}) {
    if (this.#closed) throw new ProcessCapabilityError('PROCESS_SERVICE_CLOSED');
    if (typeof command !== 'string' || command.trim() === '' || /\0/u.test(command)) {
      throw new ProcessCapabilityError('PROCESS_INVALID_COMMAND', 'command must be a non-empty bounded string');
    }
    if (utf8Bytes(command) > PROCESS_LIMITS.commandBytes) {
      throw new ProcessCapabilityError('PROCESS_LIMIT_EXCEEDED', `command exceeds ${PROCESS_LIMITS.commandBytes} UTF-8 bytes`);
    }
    const ws = this.#workspaceRegistry.get(workspaceId);
    const timeout = assertTimeout(timeoutMs, PROCESS_LIMITS.startTimeoutMs, 5000, 'timeoutMs');
    const resolvedShell = shellConfig(shell, this.#platform);
    const upstreamCommand = commandWithInitialCwd(ws.root, command, resolvedShell.family);
    let started;
    try {
      started = await this.#child.startProcess({
        command: upstreamCommand,
        timeoutMs: timeout,
        shell: resolvedShell.upstreamShell,
      });
    } catch (error) {
      if (error instanceof DesktopCommanderChildError) throw error;
      throw new ProcessCapabilityError('PROCESS_START_FAILED');
    }
    if (!Number.isInteger(started?.pid) || started.pid <= 0) throw new ProcessCapabilityError('PROCESS_START_FAILED');

    const processHandle = crypto.randomUUID();
    const record = {
      processHandle,
      workspaceId,
      pid: started.pid,
      status: started.status === 'completed' ? 'completed' : 'running',
      exitCode: Number.isInteger(started.exitCode) ? started.exitCode : null,
    };
    this.#handles.set(processHandle, record);
    const clipped = clipUtf8(started.output, PROCESS_LIMITS.initialOutputBytes);
    return publicState(record, {
      output: clipped.output,
      truncated: !!started.truncated || clipped.truncated,
      completed: record.status === 'completed',
    });
  }

  async readOutput({ workspaceId, processHandle, offset = 0, length = 1000, timeoutMs } = {}) {
    if (this.#closed) throw new ProcessCapabilityError('PROCESS_SERVICE_CLOSED');
    const record = this.#getOwned(workspaceId, processHandle);
    const page = assertReadPaging({ offset, length });
    const timeout = assertTimeout(timeoutMs, PROCESS_LIMITS.readTimeoutMs, 1000, 'timeoutMs');
    let read;
    try {
      read = await this.#child.readProcessOutput({
        pid: record.pid,
        offset: page.offset,
        length: page.length,
        timeoutMs: timeout,
      });
    } catch (error) {
      if (error instanceof DesktopCommanderChildError) throw error;
      throw new ProcessCapabilityError('PROCESS_READ_FAILED');
    }
    if (read?.status === 'completed') record.status = 'completed';
    if (Number.isInteger(read?.exitCode)) record.exitCode = read.exitCode;
    const clipped = clipUtf8(read?.output, PROCESS_LIMITS.readOutputBytes);
    return publicState(record, {
      output: clipped.output,
      truncated: !!read?.truncated || clipped.truncated,
      completed: record.status === 'completed',
      offset: page.offset,
      length: page.length,
    });
  }

  async terminate({ workspaceId, processHandle } = {}) {
    if (this.#closed) throw new ProcessCapabilityError('PROCESS_SERVICE_CLOSED');
    const record = this.#getOwned(workspaceId, processHandle);
    if (record.status !== 'running') throw new ProcessCapabilityError('PROCESS_NOT_ACTIVE', 'process is not active');
    try {
      await this.#child.forceTerminate({ pid: record.pid });
    } catch (error) {
      if (error instanceof DesktopCommanderChildError) throw error;
      throw new ProcessCapabilityError('PROCESS_TERMINATE_FAILED');
    }
    record.status = 'terminated';
    return publicState(record);
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const active = [...this.#handles.values()].filter((record) => record.status === 'running');
    await Promise.allSettled(active.map(async (record) => {
      try { await this.#child.forceTerminate({ pid: record.pid }); } catch {}
      record.status = 'terminated';
    }));
    this.#handles.clear();
  }

  #getOwned(workspaceId, processHandle) {
    if (!workspaceId) throw new WorkspaceError('workspaceId is required for process operations');
    this.#workspaceRegistry.get(workspaceId);
    const record = typeof processHandle === 'string' ? this.#handles.get(processHandle) : null;
    if (!record || record.workspaceId !== workspaceId) {
      throw new ProcessCapabilityError('PROCESS_HANDLE_NOT_FOUND', 'process handle is not valid for this workspace');
    }
    return record;
  }
}

export function createProcessService(options = {}) {
  return new ProcessService(options);
}
