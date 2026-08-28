import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newBrainContext, ProjectStore } from '../src/brain-context.js';

function dir() { const d = path.join(os.tmpdir(), 'bc-' + Date.now()); fs.mkdirSync(d, { recursive: true }); return d; }

test('bindProject -> getProjectBinding roundtrip, normalized repoDir', () => {
  const store = new ProjectStore({ bindDir: path.join(dir(), 'projects') });
  const rec = store.bindProject('C:/Users/x/proj', newBrainContext({ instructions: 'repo rules', conversationMode: 'current', metadata: { owner: 'simon' } }));
  assert.strictEqual(rec.repoDir, path.resolve('C:/Users/x/proj'));
  const got = store.getProjectBinding(rec.repoDir);
  assert.strictEqual(got.brainProfile.instructions, 'repo rules');
  assert.strictEqual(got.brainProfile.conversationMode, 'current');
  assert.ok(got.projectId);
});

test('getProjectBinding returns null for unbounded repo', () => {
  const store = new ProjectStore({ bindDir: path.join(dir(), 'projects') });
  assert.strictEqual(store.getProjectBinding('/no/repo'), null);
});