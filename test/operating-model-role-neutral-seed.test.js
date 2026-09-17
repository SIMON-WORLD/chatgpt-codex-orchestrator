import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const seed = fs.readFileSync(
  fileURLToPath(new URL('../docs/project-bootstrap-seed.md', import.meta.url)),
  'utf8',
);

test('Project-wide seed is explicitly role-neutral and live-state free', () => {
  assert.match(seed, /role-neutral/i);
  assert.match(seed, /fresh conversation is unbound\/read-only/i);
  assert.match(seed, /does NOT grant any conversation ongoing-Parent/i);
  assert.match(seed, /<PROJECT_KEY>/);
  assert.match(seed, /<PROJECT_ROOT_POINTER>/);
  assert.match(seed, /<CONTROL_LOCATOR>/);
  assert.doesNotMatch(seed, /ACTIVE_MISSION_POINTER_OR_NONE/);
  assert.doesNotMatch(seed, /current Issue\s*=\s*#\d+/i);
  assert.doesNotMatch(seed, /you are .*ongoing Parent/i);
});

test('existing-project adoption requires no special recovery teaching prompt', () => {
  assert.match(seed, /one Project Settings edit/i);
  assert.match(seed, /Do not send the ongoing Parent a special `learn orchestrator`, `recover`, `continue`/i);
  assert.match(seed, /current shared kernel -> its existing project control -> its current role\/mission -> fresh capabilities -> act/i);
});
