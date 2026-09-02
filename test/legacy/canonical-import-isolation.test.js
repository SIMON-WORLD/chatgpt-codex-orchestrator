// chatgpt-codex-orchestrator: canonical v0.2 import-isolation gate (M6 Phase D).
// Proves the canonical v0.2 runtime import closure does NOT include src/legacy/** or any
// legacy IAB / Alpha.4 module. If the canonical path regresses and imports legacy, this
// test fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const srcDir = path.join(repoRoot, 'src');
const legacyDir = path.join(srcDir, 'legacy');

const CANONICAL_ENTRY = [
  'src/transport/brain-local.js',
  'src/mcp/server.js',
  'src/mcp/tools.js',
  'src/router/capability-router.js',
  'src/router/decide.js',
  'src/governance/index.js',
  'src/executor/app-server-client.js',
  'src/executor/app-server-executor.js',
  'src/local/workspace.js',
  'src/local/read.js',
  'src/local/search.js',
  'src/local/git.js',
  'src/local/change-set.js',
  'src/local/verify.js',
  'src/local/sensitive.js',
  'src/state/mutation-owner.js',
  'src/state/operation-state.js',
  'src/state/handoff.js',
  'scripts/v0.2-start.mjs',
];

// Modules that are canonical/shared and must NOT be considered legacy even if co-located in src/.
const LEGACY_MODS = new Set([
  'iab-transport', 'atomic-turn', 'direct-mode', 'direct-run-controller', 'loop-controller',
  'codex-executor', 'task-manager', 'task-service', 'worker-client',
]);

function resolveFile(spec, fromFile) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null; // package/node builtin
  const abs = path.resolve(path.dirname(fromFile), spec);
  let p = abs;
  if (!fs.existsSync(p)) {
    if (fs.existsSync(p + '.js')) p = p + '.js';
    else if (fs.existsSync(path.join(p, 'index.js'))) p = path.join(p, 'index.js');
    else return null;
  }
  return p;
}

function importsOf(file) {
  const s = fs.readFileSync(file, 'utf8');
  const out = [];
  const re = /(?:import|export)\s[^'"]*from\s*['"]([^'"]+)['"]/g;
  let m; while ((m = re.exec(s))) out.push(m[1]);
  // Also handle `import 'x'` side-effect? Ignore here (no side-effect-only in this codebase).
  return out;
}

function canonicalClosure() {
  const visited = new Set();
  const stack = CANONICAL_ENTRY.map((f) => path.join(repoRoot, f));
  const resolved = new Set();
  while (stack.length) {
    const file = stack.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    resolved.add(file);
    for (const spec of importsOf(file)) {
      const r = resolveFile(spec, file);
      if (r) stack.push(r);
    }
  }
  return { resolved, visited };
}

test('canonical v0.2 runtime import closure excludes src/legacy/** and legacy modules', () => {
  const { resolved } = canonicalClosure();
  const legacyHits = [];
  for (const f of resolved) {
    const rel = path.relative(repoRoot, f).replace(/\\/g, '/');
    if (rel.startsWith('src/legacy/')) legacyHits.push(rel);
    else {
      const base = path.basename(f, '.js');
      if (LEGACY_MODS.has(base)) legacyHits.push(rel + ' (legacy symbol: ' + base + ')');
    }
  }
  assert.deepEqual(legacyHits, [], 'canonical v0.2 runtime must not import legacy: ' + legacyHits.join(', '));
});

test('canonical closure is non-empty and reaches Governance/Codex/MCP', () => {
  const { resolved } = canonicalClosure();
  const rels = [...resolved].map((f) => path.relative(repoRoot, f).replace(/\\/g, '/'));
  assert.ok(rels.some((r) => r === 'src/transport/brain-local.js'));
  assert.ok(rels.some((r) => r === 'src/governance/index.js'));
  assert.ok(rels.some((r) => r === 'src/mcp/tools.js'));
  assert.ok(rels.some((r) => r === 'src/executor/app-server-executor.js'));
  assert.ok(!rels.some((r) => r.startsWith('src/legacy/')));
});
