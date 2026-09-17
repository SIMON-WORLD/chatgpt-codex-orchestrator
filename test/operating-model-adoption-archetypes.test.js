import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveProjectAdoption, stableControlLocatorKey } from '../src/operating-model/adoption.js';

const manifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../operating-model/kernel-manifest.json', import.meta.url)), 'utf8'));
const SHA = 'a24cf09122334678702362ec81c0af79a7c9bca8';

function capabilities() {
  return { observedAt: '2026-09-17T14:20:00Z', surface: 'chatgpt-project', observations: [] };
}

function control(projectKey, overrides = {}) {
  return {
    schemaVersion: 1, projectKey, controlId: 'primary', revision: 'CTRL-0001',
    freshness: 'current', writerState: 'clear',
    parentBinding: { status: 'ACTIVE', provenance: 'DESTINATION_PROJECT' },
    lifecycle: 'ACTIVE', activeMissionRef: null, nextSafeAction: 'continue existing accepted project state',
    pointers: [], ...overrides,
  };
}

function existingProject({ projectKey, uiLabel, root, controlPointer, projectControl, role = null }) {
  const locator = { mode: 'existing', kind: 'github_file', pointer: controlPointer };
  return resolveProjectAdoption({
    kernelManifest: manifest,
    observedKernelRepository: 'SIMON-WORLD/chatgpt-codex-orchestrator',
    observedKernelRef: 'main', observedKernelSha: SHA,
    projectAnchor: {
      schemaVersion: 1, projectKey, uiLabel, compatibleKernelSchemaMajor: 1,
      projectRoot: { kind: 'github_repo', pointer: root }, overlays: [],
    },
    controlLocator: locator,
    projectControlObservations: [{
      locatorKey: stableControlLocatorKey(locator), resolvedControlPointer: controlPointer, control: projectControl,
    }],
    sessionRoleBinding: role,
    missionAuthority: null,
    capabilityInput: capabilities(),
  });
}

test('China-Demand-like CONTROL adoption preserves existing parent/control and next safe action', () => {
  const result = existingProject({
    projectKey: 'china-demand', uiLabel: 'China Demand',
    root: 'https://github.com/SIMON-WORLD/research-china-demand',
    controlPointer: 'https://github.com/SIMON-WORLD/research-china-demand/blob/main/CONTROL.md',
    projectControl: control('china-demand', {
      revision: 'CTRL-0005',
      nextSafeAction: 'perform E1 on a non-sensitive disposable fixture',
      parentBinding: { status: 'ACTIVE', provenance: 'PAPER_PARENT generation 1 / PB-0001' },
    }),
    role: { status: 'bound', role: 'ongoing_parent', provenance: 'PAPER_PARENT generation 1 / PB-0001' },
  });
  assert.equal(result.adoption.mode, 'EXISTING_CONTROL');
  assert.equal(result.adoption.requiresGenesis, false);
  assert.equal(result.control.revision, 'CTRL-0005');
  assert.match(result.missionDiscovery.nextSafeAction, /E1/);
});

test('Upstream-like control adoption preserves active generation and does not replay public-write approval', () => {
  const result = existingProject({
    projectKey: 'upstream-contribution-control', uiLabel: 'GitHub 上游贡献',
    root: 'https://github.com/SIMON-WORLD/upstream-contribution-control',
    controlPointer: 'https://github.com/SIMON-WORLD/upstream-contribution-control/blob/main/AGENTS.md',
    projectControl: control('upstream-contribution-control', {
      revision: 'G01',
      nextSafeAction: 'reacquire live upstream state before any material action; public writes remain JIT approval gated',
      parentBinding: { status: 'ACTIVE', provenance: 'Active Brain generation G01' },
      pointers: [{ kind: 'case_registry', pointer: 'https://github.com/SIMON-WORLD/upstream-contribution-control/blob/main/CASES.md' }],
    }),
    role: { status: 'bound', role: 'ongoing_parent', provenance: 'Active Brain generation G01' },
  });
  assert.equal(result.control.revision, 'G01');
  assert.match(result.missionDiscovery.nextSafeAction, /JIT approval gated/);
  assert.equal(result.authority.bound, false);
});

function materializeProject({ projectKey, uiLabel, root, sourceTruthPointers }) {
  const locator = {
    mode: 'scoped_identity',
    container: { kind: 'github_repo', pointer: root },
    identity: 'PROJECT_CONTROL.md',
  };
  return resolveProjectAdoption({
    kernelManifest: manifest,
    observedKernelRepository: 'SIMON-WORLD/chatgpt-codex-orchestrator',
    observedKernelRef: 'main', observedKernelSha: SHA,
    projectAnchor: {
      schemaVersion: 1, projectKey, uiLabel, compatibleKernelSchemaMajor: 1,
      projectRoot: { kind: 'github_repo', pointer: root }, overlays: [],
    },
    controlLocator: locator,
    projectControlObservations: [],
    adoptionAuthorization: {
      status: 'authorized', mode: 'materialize_control', projectKey,
      locatorKey: stableControlLocatorKey(locator), grantedBy: 'HUMAN_PRINCIPAL',
      permittedAction: 'MATERIALIZE_MINIMAL_PROJECT_CONTROL', sourceTruthPointers,
    },
    missionAuthority: null,
    capabilityInput: capabilities(),
  });
}

test('Clash-like adoption materializes pointers to current Issue/PR truth without inventing work', () => {
  const pointers = [
    'https://github.com/SIMON-WORLD/clash-rules-collab/issues/7',
    'https://github.com/SIMON-WORLD/clash-rules-collab/pull/8',
    'https://github.com/SIMON-WORLD/clash-rules-collab/issues/9',
    'https://github.com/SIMON-WORLD/clash-rules-collab/pull/10',
    'https://github.com/SIMON-WORLD/clash-rules-collab/issues/11',
    'https://github.com/SIMON-WORLD/clash-rules-collab/pull/12',
    'https://github.com/SIMON-WORLD/clash-rules-collab/pull/12#issuecomment-5716511194',
  ];
  const result = materializeProject({
    projectKey: 'clash-rules-collab', uiLabel: 'Clash',
    root: 'https://github.com/SIMON-WORLD/clash-rules-collab',
    sourceTruthPointers: pointers,
  });
  assert.equal(result.adoption.mode, 'MATERIALIZE_CONTROL');
  assert.equal(result.controlLocator.mode, 'scoped_identity');
  assert.equal(result.controlLocator.container.kind, 'github_repo');
  assert.equal(result.controlLocator.identity, 'PROJECT_CONTROL.md');
  assert.deepEqual(result.adoption.sourceTruthPointers, pointers);
  assert.equal(result.missionDiscovery.mode, 'CONTROL_MATERIALIZATION_REQUIRED');
});

test('DSH-like adoption preserves strategy gate and cannot silently start Recipe 002', () => {
  const gate = 'https://github.com/SIMON-WORLD/dsh-research-handbook/issues/5';
  const result = materializeProject({
    projectKey: 'dsh-research-handbook', uiLabel: 'DSH Research Handbook',
    root: 'https://github.com/SIMON-WORLD/dsh-research-handbook',
    sourceTruthPointers: [gate],
  });
  assert.equal(result.adoption.mode, 'MATERIALIZE_CONTROL');
  assert.equal(result.controlLocator.mode, 'scoped_identity');
  assert.deepEqual(result.adoption.sourceTruthPointers, [gate]);
  assert.equal(result.authority.bound, false);
  assert.equal(result.sessionRole.role, 'unbound');
});
