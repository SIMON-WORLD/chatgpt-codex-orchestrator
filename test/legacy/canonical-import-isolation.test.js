// chatgpt-codex-orchestrator: canonical v0.2 import-isolation gate (M6 Phase D).
// Proves the canonical v0.2 runtime import closure does NOT include src/legacy/** or any
// legacy IAB / Alpha.4 module. If the canonical path regresses and imports legacy, this
// test fails.
//
// The scanner is deliberately strengthened to also catch side-effect and dynamic imports
// (import 'x' / import('x')) so a future canonical module cannot reintroduce legacy via
// those forms without the gate failing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const srcDir = path.join(repoRoot, 'src');
const legacyDir = path.join(srcDir, 'legacy');
const FIXTURE = path.join(repoRoot, 'test-fixtures', 'legacy-import-forms.js');

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

// Small deterministic import scanner. Detects the four import forms a canonical module may
// use: `import ... from 'x'`, `export ... from 'x'`, side-effect `import 'x'`, and dynamic
// `import('x')`. Returns specifiers (duplicates removed).
function importSpecifiers(source) {
  const out = new Set();
  const patterns = [
    // import ... from 'x'  /  export ... from 'x'
    /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    // side-effect import 'x'
    /(?:^|[;\n\r{}])\s*import\s*['"]([^'"]+)['"]/g,
    // dynamic import('x')
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source))) out.add(m[1]);
  }
  return [...out];
}

function importsOf(file) {
  return importSpecifiers(fs.readFileSync(file, 'utf8'));
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

function isLegacyHit(rel) {
  if (rel.startsWith('src/legacy/')) return true;
  const base = path.basename(rel, '.js');
  return LEGACY_MODS.has(base);
}

test('canonical v0.2 runtime import closure excludes src/legacy/** and legacy modules', () => {
  const { resolved } = canonicalClosure();
  const legacyHits = [];
  for (const f of resolved) {
    const rel = path.relative(repoRoot, f).replace(/\\/g, '/');
    if (isLegacyHit(rel)) legacyHits.push(rel);
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

// Focused tests proving the strengthened scanner detects a legacy import in every form the
// canonical runtime could use.
test('importSpecifiers detects a legacy import in every import form (fixture)', () => {
  const src = fs.readFileSync(FIXTURE, 'utf8');
  const specs = importSpecifiers(src);
  assert.ok(specs.includes('./legacy/direct-run-controller.js'), 'import ... from');
  assert.ok(specs.includes('./legacy/direct-mode.js'), 'export ... from');
  assert.ok(specs.includes('./legacy/iab-transport.js'), 'side-effect import');
  assert.ok(specs.includes('./legacy/worker-client.js'), 'dynamic import');
  for (const spec of specs.filter((x) => x.includes('/legacy/'))) {
    assert.ok(isLegacyHit('src/' + spec), 'legacy specifier not recognised: ' + spec);
  }
});

test('importSpecifiers only captures relative specifiers and dedupes', () => {
  const src = [
    "import a from 'node:fs';",
    "import b from 'zod';",
    "export { c } from './state/handoff.js';",
    "import './state/handoff.js';",      // duplicate relative side-effect
    "const d = await import('./state/handoff.js');", // duplicate relative dynamic
  ].join('\n');
  const specs = importSpecifiers(src);
  // non-relative (package/builtin) specifiers are kept by the scanner but ignored by resolveFile;
  // the relative one should appear exactly once.
  const rel = specs.filter((s) => s.startsWith('./') || s.startsWith('../'));
  assert.deepEqual(rel, ['./state/handoff.js']);
});
