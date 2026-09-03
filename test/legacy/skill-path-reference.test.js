// chatgpt-codex-orchestrator: M6 R2 — machine-facing docs / Skill path-reference gate.
// Ensures that operational docs and Skills do not reference src/** or scripts/** paths
// that no longer exist. This specifically guards against the M6 src/legacy/** move
// leaving a stale `src/<moved-module>.js` reference behind (e.g. src/direct-run-controller.js),
// which would silently break the runtime wiring described in the Skill.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

// Files that describe runtime wiring / architecture and must reference existing paths.
const MACHINE_FACING = [
  'skills/brain-command/SKILL.md',
  'SKILL.md',
  'README.md',
  'README.en.md',
  'docs/architecture.md',
];

// Capture src/... and scripts/... file references in prose or code fences.
function collectPathRefs(text) {
  const re = /(?:src|scripts)\/[A-Za-z0-9_\-./]+\.(?:js|mjs)/g;
  const out = new Set();
  let m;
  while ((m = re.exec(text))) out.add(m[0]);
  return [...out];
}

test('machine-facing docs/Skills reference only existing src/ and scripts/ paths', () => {
  const missing = [];
  for (const rel of MACHINE_FACING) {
    const file = path.join(repoRoot, rel);
    const text = fs.readFileSync(file, 'utf8');
    for (const ref of collectPathRefs(text)) {
      const target = path.join(repoRoot, ref);
      if (!fs.existsSync(target)) missing.push(rel + ' => ' + ref);
    }
  }
  assert.deepEqual(missing, [], 'machine-facing docs/Skills reference non-existent paths:\n' + missing.join('\n'));
});
