import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROCESS_LIMITS,
  ProcessService,
} from '../../src/local/process.js';
import {
  DesktopCommanderChild,
  DesktopCommanderChildError,
} from '../../src/local/desktop-commander-child.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';

function fixture() {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'issue161-process-'));
  const first = path.join(outer, 'first');
  const second = path.join(outer, 'second');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  const registry = new WorkspaceRegistry({ allowedRoots: [outer] });
  return {
    outer,
    registry,
    first: registry.open({ path: first }),
    second: registry.open({ path: second }),
  };
}

test('process service owns opaque handles, selects PowerShell on Windows, and fences workspace context', async () => {
  const f = fixture();
  const calls = [];
  const child = {
    startProcess: async (args) => {
      calls.push({ name: 'start', args });
      return { pid: 4242, status: 'running', output: 'ready\n', exitCode: null, truncated: false };
    },
    readProcessOutput: async (args) => {
      calls.push({ name: 'read', args });
      return { status: 'completed', output: 'done\n', exitCode: 0, truncated: false };
    },
    forceTerminate: async (args) => {
      calls.push({ name: 'terminate', args });
      return { terminated: true };
    },
  };
  const service = new ProcessService({ workspaceRegistry: f.registry, desktopCommanderChild: child, platform: 'win32' });
  try {
    const started = await service.start({
      workspaceId: f.first.workspaceId,
      command: 'Write-Output issue161',
      shell: 'powershell',
      timeoutMs: 250,
    });
    assert.equal(started.status, 'running');
    assert.match(started.processHandle, /^[0-9a-f-]{36}$/u);
    assert.equal('pid' in started, false);
    assert.equal(JSON.stringify(started).includes('4242'), false);
    assert.equal(calls[0].args.shell, 'powershell.exe');
    assert.equal(calls[0].args.timeoutMs, 250);
    assert.match(calls[0].args.command, /^Set-Location -LiteralPath /u);
    assert.match(calls[0].args.command, /; Write-Output issue161$/u);

    await assert.rejects(
      () => service.readOutput({ workspaceId: f.second.workspaceId, processHandle: started.processHandle }),
      /process handle is not valid for this workspace/iu,
    );
    await assert.rejects(
      () => service.readOutput({ workspaceId: f.first.workspaceId, processHandle: '00000000-0000-0000-0000-000000000000' }),
      /process handle is not valid for this workspace/iu,
    );

    const read = await service.readOutput({
      workspaceId: f.first.workspaceId,
      processHandle: started.processHandle,
      offset: 0,
      length: 20,
      timeoutMs: 100,
    });
    assert.equal(read.status, 'completed');
    assert.equal(read.completed, true);
    assert.equal(read.exitCode, 0);
    assert.equal(read.output, 'done\n');
    assert.equal('pid' in read, false);
    assert.equal(calls[1].args.pid, 4242);
  } finally {
    await service.close();
    fs.rmSync(f.outer, { recursive: true, force: true });
  }
});

test('process service keeps portable default/sh behavior and enforces public bounds before child dispatch', async () => {
  const f = fixture();
  const calls = [];
  const child = {
    startProcess: async (args) => {
      calls.push(args);
      return { pid: 7, status: 'running', output: '', exitCode: null, truncated: false };
    },
    readProcessOutput: async () => ({ status: 'running', output: '', exitCode: null, truncated: false }),
    forceTerminate: async () => ({ terminated: true }),
  };
  const service = new ProcessService({ workspaceRegistry: f.registry, desktopCommanderChild: child, platform: 'linux' });
  try {
    const started = await service.start({
      workspaceId: f.first.workspaceId,
      command: "printf 'issue161\\n'",
      shell: 'default',
    });
    assert.equal(calls[0].shell, '/bin/sh');
    assert.match(calls[0].command, /^cd '/u);
    assert.match(calls[0].command, / && printf 'issue161\\n'$/u);

    await assert.rejects(
      () => service.start({ workspaceId: f.first.workspaceId, command: 'x'.repeat(PROCESS_LIMITS.commandBytes + 1) }),
      /command exceeds/iu,
    );
    await assert.rejects(
      () => service.start({ workspaceId: f.first.workspaceId, command: 'true', timeoutMs: PROCESS_LIMITS.startTimeoutMs + 1 }),
      /timeoutMs/iu,
    );
    await assert.rejects(
      () => service.readOutput({ workspaceId: f.first.workspaceId, processHandle: started.processHandle, length: PROCESS_LIMITS.maxReadLines + 1 }),
      /length/iu,
    );
    assert.equal(calls.length, 1, 'invalid bounded calls must fail before upstream dispatch');
  } finally {
    await service.close();
    fs.rmSync(f.outer, { recursive: true, force: true });
  }
});

test('upstream blocked/policy failures propagate without minting a process handle', async () => {
  const f = fixture();
  const child = {
    startProcess: async () => { throw new DesktopCommanderChildError('UPSTREAM_TOOL_ERROR'); },
    readProcessOutput: async () => { throw new Error('unexpected'); },
    forceTerminate: async () => ({ terminated: true }),
  };
  const service = new ProcessService({ workspaceRegistry: f.registry, desktopCommanderChild: child });
  try {
    await assert.rejects(
      () => service.start({ workspaceId: f.first.workspaceId, command: 'blocked-command' }),
      (error) => error?.code === 'UPSTREAM_TOOL_ERROR',
    );
    assert.equal(service.activeHandleCount, 0);
  } finally {
    await service.close();
    fs.rmSync(f.outer, { recursive: true, force: true });
  }
});

test('terminate accepts only active owned handles and shutdown cleanup reaps remaining public processes', async () => {
  const f = fixture();
  let nextPid = 100;
  const terminated = [];
  const child = {
    startProcess: async () => ({ pid: nextPid++, status: 'running', output: '', exitCode: null, truncated: false }),
    readProcessOutput: async () => ({ status: 'running', output: '', exitCode: null, truncated: false }),
    forceTerminate: async ({ pid }) => {
      terminated.push(pid);
      return { terminated: true };
    },
  };
  const service = new ProcessService({ workspaceRegistry: f.registry, desktopCommanderChild: child });
  const first = await service.start({ workspaceId: f.first.workspaceId, command: 'long-one' });
  const second = await service.start({ workspaceId: f.first.workspaceId, command: 'long-two' });

  const stopped = await service.terminate({ workspaceId: f.first.workspaceId, processHandle: first.processHandle });
  assert.deepEqual(stopped, { processHandle: first.processHandle, status: 'terminated' });
  await assert.rejects(
    () => service.terminate({ workspaceId: f.first.workspaceId, processHandle: first.processHandle }),
    /process is not active/iu,
  );
  assert.deepEqual(terminated, [100]);
  assert.equal(service.activeHandleCount, 1);

  await service.close();
  assert.deepEqual(terminated, [100, 101]);
  assert.equal(service.activeHandleCount, 0);
  await assert.rejects(
    () => service.readOutput({ workspaceId: f.first.workspaceId, processHandle: second.processHandle }),
    /PROCESS_SERVICE_CLOSED/u,
  );
  fs.rmSync(f.outer, { recursive: true, force: true });
});

test('real pinned DesktopCommander process path runs a simple command and terminates a long-running process', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue161-real-process-'));
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const workspace = registry.open({ path: root });
  const child = new DesktopCommanderChild();
  const service = new ProcessService({ workspaceRegistry: registry, desktopCommanderChild: child });
  try {
    const simple = await service.start({
      workspaceId: workspace.workspaceId,
      command: `${process.execPath} -e "console.log('issue161-real-ok')"`,
      shell: 'default',
      timeoutMs: 5000,
    });
    let simpleState = simple;
    let simpleOutput = simple.output;
    for (let i = 0; i < 8 && simpleState.status === 'running'; i += 1) {
      simpleState = await service.readOutput({
        workspaceId: workspace.workspaceId,
        processHandle: simple.processHandle,
        offset: 0,
        length: 100,
        timeoutMs: 500,
      });
      simpleOutput += simpleState.output;
    }
    assert.equal(simpleState.status, 'completed');
    assert.equal(simpleState.exitCode, 0);
    assert.match(simpleOutput, /issue161-real-ok/u);
    assert.equal('pid' in simpleState, false);

    const long = await service.start({
      workspaceId: workspace.workspaceId,
      command: `${process.execPath} -e "console.log('issue161-running'); setInterval(() => {}, 1000)"`,
      shell: 'default',
      timeoutMs: 250,
    });
    assert.equal(long.status, 'running');
    const page = await service.readOutput({
      workspaceId: workspace.workspaceId,
      processHandle: long.processHandle,
      offset: -10,
      length: 10,
      timeoutMs: 250,
    });
    assert.match(long.output + page.output, /issue161-running/u);
    const terminated = await service.terminate({
      workspaceId: workspace.workspaceId,
      processHandle: long.processHandle,
    });
    assert.equal(terminated.status, 'terminated');
  } finally {
    await service.close();
    await child.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
