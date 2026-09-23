import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startMcpServer } from '../../src/mcp/server.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';

function textOf(result) {
  const block = result?.content?.find((item) => item.type === 'text');
  return block?.text || '';
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { result, text: textOf(result) };
}

test('Issue #161 exposes exactly three typed process actions with truthful metadata and no Governance fields', async (t) => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'issue161-mcp-schema-'));
  const root = path.join(outer, 'workspace');
  fs.mkdirSync(root);
  const registry = new WorkspaceRegistry({ allowedRoots: [outer] });
  const fakeChild = {
    health: () => ({ state: 'ready', version: '0.2.51', generation: 1 }),
    startProcess: async () => ({ pid: 9090, status: 'running', output: 'started\n', exitCode: null, truncated: false }),
    readProcessOutput: async () => ({ status: 'completed', output: 'finished\n', exitCode: 0, truncated: false }),
    forceTerminate: async () => ({ terminated: true }),
    callTool: async () => { throw new Error('generic process seam must not be used'); },
  };

  const server = await startMcpServer({
    workspaceRegistry: registry,
    desktopCommanderChild: fakeChild,
    host: '127.0.0.1',
    port: 0,
  });
  const client = new Client({ name: 'issue161-schema', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(server.url));
  t.after(async () => {
    try { await client.close(); } catch {}
    try { await server.close(); } catch {}
    fs.rmSync(outer, { recursive: true, force: true });
  });

  const listed = await client.listTools();
  const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
  const processActions = listed.tools.map((tool) => tool.name).filter((name) => name.startsWith('process_')).sort();
  assert.deepEqual(processActions, ['process_read_output', 'process_start', 'process_terminate']);
  for (const raw of ['start_process', 'read_process_output', 'force_terminate']) {
    assert.equal(Object.hasOwn(byName, raw), false, raw + ' must remain private to the pinned child adapter');
  }

  assert.deepEqual(byName.process_start.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  });
  assert.deepEqual(byName.process_read_output.annotations, { readOnlyHint: true });
  assert.deepEqual(byName.process_terminate.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  });
  assert.equal(Object.hasOwn(byName.process_start.annotations, 'idempotentHint'), false);

  assert.deepEqual(Object.keys(byName.process_start.inputSchema.properties).sort(), ['command', 'shell', 'timeoutMs', 'workspaceId']);
  assert.deepEqual(Object.keys(byName.process_read_output.inputSchema.properties).sort(), ['length', 'offset', 'processHandle', 'timeoutMs', 'workspaceId']);
  assert.deepEqual(Object.keys(byName.process_terminate.inputSchema.properties).sort(), ['processHandle', 'workspaceId']);
  for (const name of processActions) {
    for (const field of ['taskId', 'stepId', 'authorityToken', 'executionToken']) {
      assert.equal(Object.hasOwn(byName[name].inputSchema.properties, field), false, name + ' must not expose ' + field);
    }
  }

  assert.match(byName.process_start.description, /mutate device state/iu);
  assert.match(byName.process_start.description, /Stable Runtime OS user/iu);
  assert.match(byName.process_start.description, /not a shell sandbox/iu);
  assert.match(byName.process_read_output.description, /Raw OS process identifiers are never accepted or returned/iu);
  assert.match(byName.process_terminate.description, /Arbitrary OS PIDs are never accepted/iu);
});

test('MCP process handles survive stateless requests, fence workspaces, never expose PID, and terminate by opaque handle', async (t) => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'issue161-mcp-flow-'));
  const firstRoot = path.join(outer, 'first');
  const secondRoot = path.join(outer, 'second');
  fs.mkdirSync(firstRoot);
  fs.mkdirSync(secondRoot);
  const registry = new WorkspaceRegistry({ allowedRoots: [outer] });
  const calls = [];
  let nextPid = 5100;
  const fakeChild = {
    health: () => ({ state: 'ready', version: '0.2.51', generation: 1 }),
    startProcess: async (args) => {
      calls.push({ name: 'start', args });
      return { pid: nextPid++, status: 'running', output: 'initial\n', exitCode: null, truncated: false };
    },
    readProcessOutput: async (args) => {
      calls.push({ name: 'read', args });
      return { status: 'completed', output: 'complete\n', exitCode: 0, truncated: false };
    },
    forceTerminate: async (args) => {
      calls.push({ name: 'terminate', args });
      return { terminated: true };
    },
  };

  const server = await startMcpServer({
    workspaceRegistry: registry,
    desktopCommanderChild: fakeChild,
    host: '127.0.0.1',
    port: 0,
  });
  let closed = false;
  const client = new Client({ name: 'issue161-flow', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(server.url));
  t.after(async () => {
    try { await client.close(); } catch {}
    if (!closed) {
      try { await server.close(); } catch {}
    }
    fs.rmSync(outer, { recursive: true, force: true });
  });

  const first = JSON.parse((await call(client, 'workspace_open', { path: firstRoot })).text);
  const second = JSON.parse((await call(client, 'workspace_open', { path: secondRoot })).text);

  const startedCall = await call(client, 'process_start', {
    workspaceId: first.workspaceId,
    command: 'echo issue161',
    shell: 'default',
    timeoutMs: 100,
  });
  assert.equal(startedCall.result.isError, undefined);
  const started = JSON.parse(startedCall.text);
  assert.equal(started.status, 'running');
  assert.match(started.processHandle, /^[0-9a-f-]{36}$/u);
  assert.equal('pid' in started, false);
  assert.equal(startedCall.text.includes('5100'), false);

  const crossWorkspace = await call(client, 'process_read_output', {
    workspaceId: second.workspaceId,
    processHandle: started.processHandle,
  });
  assert.equal(crossWorkspace.result.isError, true);
  assert.match(crossWorkspace.text, /not valid for this workspace/iu);

  const unknown = await call(client, 'process_terminate', {
    workspaceId: first.workspaceId,
    processHandle: '00000000-0000-0000-0000-000000000000',
  });
  assert.equal(unknown.result.isError, true);
  assert.match(unknown.text, /not valid for this workspace/iu);

  const readCall = await call(client, 'process_read_output', {
    workspaceId: first.workspaceId,
    processHandle: started.processHandle,
    offset: 0,
    length: 50,
    timeoutMs: 100,
  });
  const read = JSON.parse(readCall.text);
  assert.equal(read.status, 'completed');
  assert.equal(read.exitCode, 0);
  assert.equal(read.output, 'complete\n');
  assert.equal('pid' in read, false);
  assert.equal(calls.find((entry) => entry.name === 'read').args.pid, 5100);

  const longCall = await call(client, 'process_start', {
    workspaceId: first.workspaceId,
    command: 'long-running',
    shell: 'default',
    timeoutMs: 100,
  });
  const long = JSON.parse(longCall.text);
  const terminatedCall = await call(client, 'process_terminate', {
    workspaceId: first.workspaceId,
    processHandle: long.processHandle,
  });
  const terminated = JSON.parse(terminatedCall.text);
  assert.deepEqual(terminated, { processHandle: long.processHandle, status: 'terminated' });
  assert.equal(calls.filter((entry) => entry.name === 'terminate').at(-1).args.pid, 5101);

  const cleanupCall = await call(client, 'process_start', {
    workspaceId: first.workspaceId,
    command: 'cleanup-on-shutdown',
  });
  const cleanup = JSON.parse(cleanupCall.text);
  assert.equal(cleanup.status, 'running');
  await server.close();
  closed = true;
  assert.equal(calls.filter((entry) => entry.name === 'terminate').some((entry) => entry.args.pid === 5102), true);
});

test('strict process schemas reject Governance fields and bounded overflows before dispatch', async (t) => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'issue161-mcp-bounds-'));
  const root = path.join(outer, 'workspace');
  fs.mkdirSync(root);
  const registry = new WorkspaceRegistry({ allowedRoots: [outer] });
  let starts = 0;
  const fakeChild = {
    health: () => ({ state: 'ready', version: '0.2.51', generation: 1 }),
    startProcess: async () => {
      starts += 1;
      return { pid: 1, status: 'running', output: '', exitCode: null, truncated: false };
    },
    readProcessOutput: async () => ({ status: 'running', output: '', exitCode: null, truncated: false }),
    forceTerminate: async () => ({ terminated: true }),
  };
  const server = await startMcpServer({
    workspaceRegistry: registry,
    desktopCommanderChild: fakeChild,
    host: '127.0.0.1',
    port: 0,
  });
  const client = new Client({ name: 'issue161-bounds', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(server.url));
  t.after(async () => {
    try { await client.close(); } catch {}
    try { await server.close(); } catch {}
    fs.rmSync(outer, { recursive: true, force: true });
  });
  const ws = JSON.parse((await call(client, 'workspace_open', { path: root })).text);

  const gov = await call(client, 'process_start', {
    workspaceId: ws.workspaceId,
    command: 'echo no-governance',
    authorityToken: 'must-not-be-accepted',
  });
  assert.equal(gov.result.isError, true);

  const tooLong = await call(client, 'process_start', {
    workspaceId: ws.workspaceId,
    command: 'x'.repeat(32 * 1024 + 1),
  });
  assert.equal(tooLong.result.isError, true);

  const tooSlow = await call(client, 'process_start', {
    workspaceId: ws.workspaceId,
    command: 'echo bounded',
    timeoutMs: 10_001,
  });
  assert.equal(tooSlow.result.isError, true);
  assert.equal(starts, 0);
});
