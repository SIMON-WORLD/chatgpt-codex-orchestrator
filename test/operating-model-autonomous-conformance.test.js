import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  BootstrapError,
  resolveAutonomousBootstrap,
} from '../src/operating-model/bootstrap.js';

const manifest = JSON.parse(fs.readFileSync(
  fileURLToPath(new URL('../operating-model/kernel-manifest.json', import.meta.url)),
  'utf8',
));
const seedText = fs.readFileSync(
  fileURLToPath(new URL('../docs/project-bootstrap-seed.md', import.meta.url)),
  'utf8',
);
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

function observation(controlValue, overrides = {}) {
  return {
    controlRootPointer: 'provider://operator-project/control',
    control: controlValue,
    ...overrides,
  };
}

function capabilityInput(overrides = {}) {
  return {
    observedAt: '2026-09-17T12:10:00Z',
    surface: 'chatgpt-project',
    observations: [],
    ...overrides,
  };
}

function autonomous(overrides = {}) {
  return resolveAutonomousBootstrap({
    kernelManifest: manifest,
    observedKernelRepository: 'SIMON-WORLD/chatgpt-codex-orchestrator',
    observedKernelRef: 'main',
    observedKernelSha: SHA,
    projectAnchor: anchor(),
    projectControlObservations: [observation(control())],
    missionAuthority: null,
    capabilityInput: capabilityInput(),
    ...overrides,
  });
}

test('Notion-native brand-new project enters bounded GENESIS from one stable anchor without a GitHub repo requirement', () => {
  const notionAnchor = anchor({
    projectKey: 'notion-management',
    uiLabel: 'Notion Management',
    projectRoot: { kind: 'notion_page', pointer: 'notion://workspace/personal-os' },
    controlRoot: { kind: 'notion_page', pointer: 'notion://workspace/notion-management-control' },
  });
  const result = autonomous({
    projectAnchor: notionAnchor,
    projectControlObservations: [],
    genesisAuthorization: {
      status: 'authorized',
      projectKey: 'notion-management',
      controlRootPointer: notionAnchor.controlRoot.pointer,
      grantedBy: 'HUMAN_PRINCIPAL',
      permittedAction: 'CREATE_MINIMAL_PROJECT_CONTROL',
      charter: {
        purpose: 'maintain a low-friction Notion information architecture',
        hardBoundaries: ['no destructive bulk mutation during genesis'],
      },
    },
  });

  assert.equal(result.genesis.required, true);
  assert.equal(result.genesis.authorized, true);
  assert.equal(result.project.controlRoot.kind, 'notion_page');
  assert.equal(result.authority.bound, false);
  assert.equal(result.authority.readOnly, true);
});

test('China-Demand-style mature project recovers none + next_safe_action from the unique current control head', () => {
  const result = autonomous({
    projectAnchor: anchor({ projectKey: 'china-demand', uiLabel: 'China Demand' }),
    projectControlObservations: [observation(control({
      projectKey: 'china-demand',
      revision: 'CTRL-0042',
      nextSafeAction: 'open a bounded evidence mission for the next accepted roadmap item',
    }))],
  });

  assert.equal(result.control.revision, 'CTRL-0042');
  assert.equal(result.missionDiscovery.mode, 'NEXT_SAFE_ACTION');
  assert.equal(result.missionDiscovery.nextSafeAction, 'open a bounded evidence mission for the next accepted roadmap item');
});

test('Clash-style recovery uses the exact active mission from control and never guesses among other work items', () => {
  const activeMission = {
    kind: 'github_issue',
    pointer: 'https://github.com/example/clash/issues/7',
    displayRef: '#7',
  };
  const result = autonomous({
    projectAnchor: anchor({ projectKey: 'clash-rules', uiLabel: 'Clash Rules' }),
    projectControlObservations: [observation(control({
      projectKey: 'clash-rules',
      activeMissionRef: activeMission,
      nextSafeAction: null,
      pointers: [
        { kind: 'open_work_item', pointer: 'https://github.com/example/clash/issues/300' },
        { kind: 'open_work_item', pointer: 'https://github.com/example/clash/issues/99' },
        { kind: 'real_device_gate', pointer: 'device://windows-primary/required' },
      ],
    }))],
    missionAuthority: {
      status: 'bound',
      missionRef: activeMission.pointer,
      mutableRepositories: ['example/clash'],
    },
  });

  assert.equal(result.missionDiscovery.mode, 'ACTIVE_MISSION');
  assert.equal(result.missionDiscovery.activeMissionRef.pointer, activeMission.pointer);
  assert.notEqual(result.missionDiscovery.activeMissionRef.pointer, 'https://github.com/example/clash/issues/300');
});

test('persistent stable anchor is unchanged while project control progresses across #80 -> #90 -> #300', () => {
  const stable = anchor({ projectKey: 'mission-progression', uiLabel: 'Mission Progression' });
  const refs = [80, 90, 300].map((issue) => ({
    kind: 'github_issue',
    pointer: `https://github.com/example/project/issues/${issue}`,
    displayRef: `#${issue}`,
  }));

  const results = refs.map((missionRef, index) => autonomous({
    projectAnchor: stable,
    projectControlObservations: [observation(control({
      projectKey: 'mission-progression',
      revision: `CTRL-000${index + 1}`,
      activeMissionRef: missionRef,
      nextSafeAction: null,
    }))],
    missionAuthority: {
      status: 'bound',
      missionRef: missionRef.pointer,
      mutableRepositories: ['example/project'],
    },
  }));

  assert.deepEqual(results[0].project, results[1].project);
  assert.deepEqual(results[1].project, results[2].project);
  assert.equal(results[2].missionDiscovery.activeMissionRef.displayRef, '#300');
});

test('fresh replacement recovers from the same stable anchor while runtime capability is rediscovered per session', () => {
  const stable = anchor({ projectKey: 'replacement', uiLabel: 'Replacement' });
  const currentControl = observation(control({ projectKey: 'replacement' }));
  const first = autonomous({
    projectAnchor: stable,
    projectControlObservations: [currentControl],
    capabilityInput: capabilityInput({
      observedAt: '2026-09-17T12:00:00Z',
      observations: [{
        operation: 'provider.read', routeFamily: 'CHATGPT_NATIVE', provider: 'Provider A',
        exposed: true, executable: true, resourceAuthorized: true, constraintsSufficient: true,
      }],
    }),
  });
  const replacement = autonomous({
    projectAnchor: stable,
    projectControlObservations: [currentControl],
    capabilityInput: capabilityInput({ observedAt: '2026-09-17T12:30:00Z', observations: [] }),
  });

  assert.deepEqual(replacement.project, first.project);
  assert.deepEqual(replacement.missionDiscovery, first.missionDiscovery);
  assert.deepEqual(first.capabilities.availableOperations, ['provider.read']);
  assert.deepEqual(replacement.capabilities.availableOperations, []);
});

test('control-head discovery fails closed on duplicate, stale, or foreign-root observations instead of recency guessing', () => {
  assert.throws(
    () => autonomous({ projectControlObservations: [observation(control()), observation(control({ revision: 'CTRL-0002' }))] }),
    /project control discovery is ambiguous/,
  );
  assert.throws(
    () => autonomous({ projectControlObservations: [observation(control({ freshness: 'stale' }))] }),
    /project control is not current and conflict-free/,
  );
  assert.throws(
    () => autonomous({
      projectControlObservations: [observation(control(), { controlRootPointer: 'provider://foreign/control' })],
    }),
    /no project control observation matches the stable control root/,
  );
});

test('capability remains authority-neutral and autonomous bootstrap has no central registry dependency', () => {
  const result = autonomous({
    missionAuthority: null,
    capabilityInput: capabilityInput({
      observations: [{
        operation: 'provider.write', routeFamily: 'CHATGPT_NATIVE', provider: 'Provider A',
        exposed: true, executable: true, resourceAuthorized: true, constraintsSufficient: true,
      }],
    }),
  });
  assert.deepEqual(result.capabilities.availableOperations, ['provider.write']);
  assert.equal(result.authority.bound, false);
  assert.equal(result.authority.readOnly, true);
  assert.equal(result.registry, undefined);
});

test('preferred persistent Project seed contains stable root/control only and no changing mission pointer', () => {
  assert.match(seedText, /<PROJECT_ROOT_POINTER>/);
  assert.match(seedText, /<PROJECT_CONTROL_ROOT_POINTER>/);
  assert.doesNotMatch(seedText, /ACTIVE_MISSION_POINTER_OR_NONE/);
  assert.doesNotMatch(seedText, /Optional current mission\/Issue pointer/);
  assert.match(seedText, /project-local durable control/);
});
