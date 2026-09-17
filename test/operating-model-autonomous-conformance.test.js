import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { BootstrapError } from '../src/operating-model/bootstrap.js';
import { resolveAutonomousBootstrap } from '../src/operating-model/autonomous-bootstrap.js';

const manifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../operating-model/kernel-manifest.json', import.meta.url)), 'utf8'));
const seedText = fs.readFileSync(fileURLToPath(new URL('../docs/project-bootstrap-seed.md', import.meta.url)), 'utf8');
const SHA = '353684ff47f087c887273e9eeb8544243ba13e89';

function anchor(overrides = {}) {
  return {
    schemaVersion: 1,
    projectKey: 'operator-project',
    uiLabel: 'Operator Project',
    compatibleKernelSchemaMajor: 1,
    projectRoot: { kind: 'project_root', pointer: 'provider://operator-project' },
    controlRoot: { kind: 'project_control', pointer: 'provider://operator-project/control' },
    overlays: [],
    ...overrides,
  };
}

function control(overrides = {}) {
  return {
    schemaVersion: 1,
    projectKey: 'operator-project',
    controlId: 'primary',
    revision: 'CTRL-0001',
    freshness: 'current',
    writerState: 'clear',
    parentBinding: { status: 'ACTIVE', provenance: 'DOWNSTREAM_PROJECT_CONTROL' },
    lifecycle: 'ACTIVE',
    activeMissionRef: null,
    nextSafeAction: 'inspect durable evidence and create the next bounded mission',
    pointers: [],
    ...overrides,
  };
}

function observation(value, overrides = {}) {
  return { controlRootPointer: 'provider://operator-project/control', control: value, ...overrides };
}

function capabilities(observations = [], observedAt = '2026-09-17T12:10:00Z') {
  return { observedAt, surface: 'chatgpt-project', observations };
}

function run(overrides = {}) {
  return resolveAutonomousBootstrap({
    kernelManifest: manifest,
    observedKernelRepository: 'SIMON-WORLD/chatgpt-codex-orchestrator',
    observedKernelRef: 'main',
    observedKernelSha: SHA,
    projectAnchor: anchor(),
    projectControlObservations: [observation(control())],
    missionAuthority: null,
    capabilityInput: capabilities(),
    ...overrides,
  });
}

test('Notion-native brand-new project enters bounded GENESIS from one stable anchor without GitHub', () => {
  const notionAnchor = anchor({
    projectKey: 'notion-management', uiLabel: 'Notion Management',
    projectRoot: { kind: 'notion_page', pointer: 'notion://workspace/personal-os' },
    controlRoot: { kind: 'notion_page', pointer: 'notion://workspace/notion-management-control' },
  });
  const result = run({
    projectAnchor: notionAnchor,
    projectControlObservations: [],
    genesisAuthorization: {
      status: 'authorized', projectKey: 'notion-management',
      controlRootPointer: notionAnchor.controlRoot.pointer,
      grantedBy: 'HUMAN_PRINCIPAL', permittedAction: 'CREATE_MINIMAL_PROJECT_CONTROL',
      charter: { purpose: 'manage Notion autonomously', hardBoundaries: ['no destructive bulk mutation during genesis'] },
    },
  });
  assert.equal(result.genesis.authorized, true);
  assert.equal(result.project.controlRoot.kind, 'notion_page');
  assert.equal(result.authority.bound, false);
});

test('China-Demand-style mature control recovers none + next_safe_action', () => {
  const result = run({
    projectAnchor: anchor({ projectKey: 'china-demand', uiLabel: 'China Demand' }),
    projectControlObservations: [observation(control({
      projectKey: 'china-demand', revision: 'CTRL-0042',
      nextSafeAction: 'create the next bounded evidence mission',
    }))],
  });
  assert.equal(result.control.revision, 'CTRL-0042');
  assert.deepEqual(result.missionDiscovery, { mode: 'NEXT_SAFE_ACTION', nextSafeAction: 'create the next bounded evidence mission' });
});

test('Clash-style recovery uses exact active mission and never guesses among open work items', () => {
  const active = { kind: 'github_issue', pointer: 'https://github.com/example/clash/issues/7', displayRef: '#7' };
  const result = run({
    projectAnchor: anchor({ projectKey: 'clash-rules', uiLabel: 'Clash Rules' }),
    projectControlObservations: [observation(control({
      projectKey: 'clash-rules', activeMissionRef: active, nextSafeAction: null,
      pointers: [
        { kind: 'open_work_item', pointer: 'https://github.com/example/clash/issues/300' },
        { kind: 'open_work_item', pointer: 'https://github.com/example/clash/issues/99' },
        { kind: 'real_device_gate', pointer: 'device://windows-primary/required' },
      ],
    }))],
    missionAuthority: { status: 'bound', missionRef: active.pointer, mutableRepositories: ['example/clash'] },
  });
  assert.equal(result.missionDiscovery.activeMissionRef.pointer, active.pointer);
});

test('stable anchor is unchanged while control progresses #80 -> #90 -> #300', () => {
  const stable = anchor({ projectKey: 'progression', uiLabel: 'Progression' });
  const results = [80, 90, 300].map((issue, index) => {
    const mission = { kind: 'github_issue', pointer: `https://github.com/example/project/issues/${issue}`, displayRef: `#${issue}` };
    return run({
      projectAnchor: stable,
      projectControlObservations: [observation(control({ projectKey: 'progression', revision: `CTRL-${index + 1}`, activeMissionRef: mission, nextSafeAction: null }))],
      missionAuthority: { status: 'bound', missionRef: mission.pointer, mutableRepositories: ['example/project'] },
    });
  });
  assert.deepEqual(results[0].project, results[1].project);
  assert.deepEqual(results[1].project, results[2].project);
  assert.equal(results[2].missionDiscovery.activeMissionRef.displayRef, '#300');
});

test('fresh replacement reuses stable root but rediscovers capability', () => {
  const stable = anchor({ projectKey: 'replacement', uiLabel: 'Replacement' });
  const observedControl = observation(control({ projectKey: 'replacement' }));
  const available = [{ operation: 'provider.read', routeFamily: 'CHATGPT_NATIVE', provider: 'Provider A', exposed: true, executable: true, resourceAuthorized: true, constraintsSufficient: true }];
  const first = run({ projectAnchor: stable, projectControlObservations: [observedControl], capabilityInput: capabilities(available, '2026-09-17T12:00:00Z') });
  const replacement = run({ projectAnchor: stable, projectControlObservations: [observedControl], capabilityInput: capabilities([], '2026-09-17T12:30:00Z') });
  assert.deepEqual(first.project, replacement.project);
  assert.deepEqual(first.missionDiscovery, replacement.missionDiscovery);
  assert.deepEqual(first.capabilities.availableOperations, ['provider.read']);
  assert.deepEqual(replacement.capabilities.availableOperations, []);
});

test('control discovery fails closed on duplicate, stale, or foreign-root observations', () => {
  assert.throws(() => run({ projectControlObservations: [observation(control()), observation(control({ revision: 'CTRL-0002' }))] }), /project control discovery is ambiguous/);
  assert.throws(() => run({ projectControlObservations: [observation(control({ freshness: 'stale' }))] }), /project control is not current and conflict-free/);
  assert.throws(() => run({ projectControlObservations: [observation(control(), { controlRootPointer: 'provider://foreign/control' })] }), /no project control observation matches the stable control root/);
});

test('capability remains authority-neutral and no central registry appears', () => {
  const write = [{ operation: 'provider.write', routeFamily: 'CHATGPT_NATIVE', provider: 'Provider A', exposed: true, executable: true, resourceAuthorized: true, constraintsSufficient: true }];
  const result = run({ capabilityInput: capabilities(write) });
  assert.deepEqual(result.capabilities.availableOperations, ['provider.write']);
  assert.equal(result.authority.bound, false);
  assert.equal(result.authority.readOnly, true);
  assert.equal(result.registry, undefined);
});

test('preferred seed is stable and contains no live mission pointer', () => {
  assert.match(seedText, /<PROJECT_ROOT_POINTER>/);
  assert.match(seedText, /<PROJECT_CONTROL_ROOT_POINTER>/);
  assert.doesNotMatch(seedText, /ACTIVE_MISSION_POINTER_OR_NONE/);
  assert.doesNotMatch(seedText, /Optional current mission\/Issue pointer/);
  assert.match(seedText, /project-local durable control/);
});
