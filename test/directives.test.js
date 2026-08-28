import { test } from 'node:test';
import assert from 'node:assert';
import { parseControl, extractDirective } from '../src/directives.js';

test('parseControl detects DONE / ASK_USER / REVISE / TASK', () => {
  assert.strictEqual(parseControl('DONE'), 'DONE');
  assert.strictEqual(parseControl('ASK_USER: need input'), 'ASK_USER');
  assert.strictEqual(parseControl('REVISE: add trim'), 'REVISE');
  assert.strictEqual(parseControl('TASK: create foo.js'), 'TASK');
  assert.strictEqual(parseControl('Here is a plan.\nTASK: create foo.js'), 'TASK');
  assert.strictEqual(parseControl('no control here'), null);
});

test('extractDirective returns the text after the control token', () => {
  assert.strictEqual(extractDirective('TASK: create foo.js', 'TASK'), 'create foo.js');
  assert.strictEqual(extractDirective('REVISE: add trim\nand tests', 'REVISE'), 'add trim\nand tests');
  assert.strictEqual(extractDirective('TASK - implement median', 'TASK'), 'implement median');
});