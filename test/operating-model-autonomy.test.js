import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  BootstrapError,
  validateProjectProfile,
  resolveBootstrap,
  renderSessionName,
} from '../src/operating-model/bootstrap.js';

const manifest = JSON.parse(fs.readFileSync(
  fileURLToPath(new URL('../operating-model/kernel-manifest.json', import.meta.url)),
  'utf8',
));
const SHA = '353684ff47f087c887273e9eeb8544243ba13e89';

function profileV2(overrides = {}) {
  return {
    schemaVersion: 2,
    projectKey: 'example-project',
    uiLabel: 'Example Project',
    compatibleKernelSchemaMajor: 1,
    projectRoot: { kind: 'project_root', pointer: 'provider://example-project' },
    controlRoot: { kind: 'project_control', pointer: 'provider://example-project/control' },
    durableSources: [],
    overlays: [],
    ...overrides,
  };
}

function control(overrides = {}) {
  return {
    schemaVersion: 1,
    projectKey: 'example-project',
    controlId: 'primary',
    revision: 'CTRL-0001',
    freshness: 'current',
    writerState: 'clear',
    parentBinding: { status: 'ACTIVE', provenance: 'HUMAN_PRINCIPAL' },
    lifecycle: 'ACTIVE',
    activeMissionRef: null,
    nextSafeAction: 'inspect project evidence and create the next bounded mission',
    pointers: [],
    ...overrides,
  };
}

function bootstrap(overrides = {}) {
  return {
    kernelManifest: manifest,
    observedKernelRepository: 'SIMON-WORLD/chatgpt-codex-orchestrator',
    observedKernelRef: 'main',
    observedKernelSha: SHA,
    projectProfile: profileV2(),
    projectControl: control(),
    missionAuthority: null,
    capabilityInput: {
      observedAt: '2026-09-17T11:50:00Z',
      surface: 'chatgpt-project',
      observations: [],
    },
    ...overrides,
  };
}

test('preferred profile v2 exposes one stable project root and one stable control root', () => {
  const validated = validateProjectProfile(profileV2(), { kernelSchemaMajor: 1 });
  assert.deepEqual(validated.projectRoot, {
    kind: 'project_root',
    pointer: 'provider://example-project',
  });
  assert.deepEqual(validated.controlRoot, {
    kind: 'project_control',
    pointer: 'provider://example-project/control',
  });
  assert.deepEqual(validated.durableSources, []);
});

test('persistent project profile rejects live mission and next-action state', () => {
  for (const forbidden of [
    { activeMissionRef: { kind: 'github_issue', pointer: 'https://github.com/example/project/issues/90' } },
    { nextSafeAction: 'do the next mission' },
    { currentIssue: 90 },
  ]) {
    assert.throws(
      () => validateProjectProfile(profileV2(forbidden), { kernelSchemaMajor: 1 }),
      (error) => error instanceof BootstrapError
        && /project profile cannot carry authority, live mission, secrets, or transient execution state/.test(error.message),
    );
  }
});

test('mature project recovers next safe action from project-local durable control', () => {
  const result = resolveBootstrap(bootstrap());
  assert.equal(result.control.projectKey, 'example-project');
  assert.equal(result.control.revision, 'CTRL-0001');
  assert.deepEqual(result.control.activeMissionRef, null);
  assert.equal(result.missionDiscovery.mode, 'NEXT_SAFE_ACTION');
  assert.equal(result.missionDiscovery.nextSafeAction, 'inspect project evidence and create the next bounded mission');
  assert.equal(result.authority.bound, false);
  assert.equal(result.authority.readOnly, true);
});

test('active mission is discovered from project control and must match bound mission authority', () => {
  const missionRef = {
    kind: 'github_issue',
    pointer: 'https://github.com/example/project/issues/42',
    displayRef: '#42',
  };
  const result = resolveBootstrap(bootstrap({
    projectControl: control({ activeMissionRef: missionRef, nextSafeAction: null }),
    missionAuthority: {
      status: 'bound',
      missionRef: missionRef.pointer,
      mutableRepositories: ['example/project'],
    },
  }));
  assert.equal(result.missionDiscovery.mode, 'ACTIVE_MISSION');
  assert.deepEqual(result.missionDiscovery.activeMissionRef, missionRef);
  assert.equal(result.authority.bound, true);
  assert.equal(result.authority.missionRef, missionRef.pointer);

  assert.throws(
    () => resolveBootstrap(bootstrap({
      projectControl: control({ activeMissionRef: missionRef, nextSafeAction: null }),
      missionAuthority: {
        status: 'bound',
        missionRef: 'https://github.com/example/project/issues/99',
        mutableRepositories: ['example/project'],
      },
    })),
    /bound mission authority does not match project control active mission/,
  );
});

test('brand-new project can enter bounded genesis without receiving general mutation authority', () => {
  const result = resolveBootstrap(bootstrap({
    projectControl: null,
    genesisAuthorization: {
      status: 'authorized',
      projectKey: 'example-project',
      controlRootPointer: 'provider://example-project/control',
      grantedBy: 'HUMAN_PRINCIPAL',
      permittedAction: 'CREATE_MINIMAL_PROJECT_CONTROL',
      charter: {
        purpose: 'manage the project autonomously',
        hardBoundaries: ['no destructive mutation without explicit authority'],
      },
    },
  }));
  assert.equal(result.genesis.required, true);
  assert.equal(result.genesis.authorized, true);
  assert.equal(result.genesis.controlRootPointer, 'provider://example-project/control');
  assert.equal(result.authority.bound, false);
  assert.equal(result.authority.readOnly, true);
});

test('genesis cannot silently rebind an existing project control', () => {
  assert.throws(
    () => resolveBootstrap(bootstrap({
      genesisAuthorization: {
        status: 'authorized',
        projectKey: 'example-project',
        controlRootPointer: 'provider://example-project/control',
        grantedBy: 'HUMAN_PRINCIPAL',
        permittedAction: 'CREATE_MINIMAL_PROJECT_CONTROL',
        charter: { purpose: 'replace it', hardBoundaries: ['none'] },
      },
    })),
    /genesis cannot rebind existing project control/,
  );
});

test('stale, ambiguous, or conflicting project control fails closed', () => {
  for (const projectControl of [
    control({ freshness: 'stale' }),
    control({ freshness: 'ambiguous' }),
    control({ writerState: 'conflict' }),
  ]) {
    assert.throws(
      () => resolveBootstrap(bootstrap({ projectControl })),
      /project control is not current and conflict-free/,
    );
  }
});

test('canonical mission naming supports provider-neutral project-local references', () => {
  assert.equal(
    renderSessionName({
      kind: 'mission',
      missionRef: 'M-07',
      missionType: 'INVESTIGATE',
      uiLabel: 'Notion Management',
    }),
    'M-07 · INVESTIGATE | Notion Management',
  );
  assert.equal(
    renderSessionName({ kind: 'bounded_parent', missionRef: 'M-07', uiLabel: 'Notion Management' }),
    'M-07 · PARENT | Notion Management',
  );
  assert.equal(
    renderSessionName({ kind: 'mission', issue: 42, missionType: 'IMPLEMENT', uiLabel: 'GitHub Project' }),
    '#42 · IMPLEMENT | GitHub Project',
  );
});
