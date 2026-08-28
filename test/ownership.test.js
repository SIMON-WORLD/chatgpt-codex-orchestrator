import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskManager } from '../src/task-manager.js';
import { loadState } from '../src/task-state.js';

function dir() { const d = path.join(os.tmpdir(), 'owner-' + Date.now()); fs.mkdirSync(d, { recursive: true }); return d; }
class B { constructor(c){this.conversationId='conv-1';this.ownedTabId='tab-1';} async send(){ return { reply: 'DONE', conversationId: 'conv-1' }; } }
class E { async execute(){ return { sessionId:'t', resultText:'', success:true, error:null }; } }

test('adopted flag and conversationMode recorded for current', async () => {
  const d = dir();
  const mgr = new TaskManager({ stateDir: d });
  const { taskId, state } = await mgr.startTask({ goal:'g', repoDir:'r', brain:new B(), executor:new E(), conversationMode:'current', adopted:true });
  assert.strictEqual(state.adopted, true);
  assert.strictEqual(state.conversationMode, 'current');
  const reloaded = loadState(d, taskId);
  assert.strictEqual(reloaded.adopted, true);
});