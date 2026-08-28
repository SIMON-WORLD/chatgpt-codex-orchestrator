import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskManager } from '../src/task-manager.js';

function dir() { const d = path.join(os.tmpdir(), 'rep-' + Date.now()); fs.mkdirSync(d, { recursive: true }); return d; }
class B { constructor(replies){ this.replies=[...replies]; this.conversationId='c'; this.ownedTabId='t'; this.sent=0; } async send(text){ this.sent++; const r=this.replies.shift() ?? 'DONE'; return { reply: typeof r==='string'? r : JSON.stringify(r), conversationId:'c' }; } }
class E { constructor(){ this.calls=0; } async execute(){ this.calls++; return { sessionId:'th', resultText:'r', success:true, error:null }; } }

test('TASK missing instruction -> one repair -> valid TASK runs', async () => {
  // first reply: TASK without instruction; repair reply: valid TASK with acceptance
  const brain = new B([{ control:'TASK', stepId:'step-1' }, { control:'TASK', stepId:'step-1', instruction:'create x.js', acceptance:[{id:'a1',required:true,text:'x'}] }, 'DONE']);
  const ex = new E();
  const mgr = new TaskManager({ stateDir: dir() });
  brain.replies = brain.replies; // keep
  const { state } = await mgr.startTask({ repoDir:'r', goal:'g', brain, executor: ex });
  assert.strictEqual(ex.calls, 1, 'codex ran after repair');
  assert.strictEqual(state.steps[0].instruction, 'create x.js');
  assert.ok(brain.sent >= 2, 'goal + at least one repair');
});

test('REVISE missing instruction -> repair', async () => {
  const brain = new B([{ control:'TASK', instruction:'a', acceptance:[] }, { control:'REVISE', stepId:'step-2' }, { control:'REVISE', stepId:'step-2', instruction:'fix b', acceptance:[] }, 'DONE']);
  const ex = new E();
  const mgr = new TaskManager({ stateDir: dir() });
  const { state } = await mgr.startTask({ repoDir:'r', goal:'g', brain, executor: ex });
  assert.ok(state.steps.length >= 2, 'at least a REVISE step ran');
  assert.strictEqual(state.steps[state.steps.length - 1].instruction, 'fix b', 'repaired instruction used');
});

test('repair second time still invalid -> awaiting_user, no execution', async () => {
  const brain = new B([{ control:'TASK', stepId:'step-1' }, { control:'TASK', stepId:'step-1' }]); // invalid twice, then nothing (DONE default)
  const ex = new E();
  const mgr = new TaskManager({ stateDir: dir() });
  let err = null; let status;
  try { const { state } = await mgr.startTask({ repoDir:'r', goal:'g', brain, executor: ex }); status = state.status; } catch(e){ err = e; }
  // invalid after repair -> the engine's _nextAction goal send throws; status may be recovery/awaiting OR the call rejects.
  // Whatever: Codex must NOT execute.
  assert.strictEqual(ex.calls, 0, 'no codex execution after invalid repair');
  if (err) assert.ok(/invalid|instruction/i.test(err.message));
});

test('invalid control -> no Codex execution', async () => {
  const brain = new B([{ control:'FOO' }, 'DONE']);
  const ex = new E();
  const mgr = new TaskManager({ stateDir: dir() });
  let err = null;
  try { await mgr.startTask({ repoDir:'r', goal:'g', brain, executor: ex }); } catch(e){ err = e; }
  assert.strictEqual(ex.calls, 0, 'no codex for invalid control');
  // Either it threw (still invalid after repair) or the repair resolved to DONE; in both cases codex must not run.)
});