import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  resolveProjectAdoption,
  stableControlLocatorKey,
} from '../src/operating-model/adoption.js';

const manifest = JSON.parse(fs.readFileSync(
  fileURLToPath(new URL('../operating-model/kernel-manifest.json', import.meta.url)),
  'utf8',
));
const SHA = 'a24cf09122334678702362ec81c0af79a7c9bca8';

function baseInput(overrides = {}) {
  return {
    kernelManifest: manifest,
    observedKernelRepository: 'SIMON-WORLD/chatgpt-codex-orchestrator',
    observedKernelRef: 'main',
    observedKernelSha: SHA,
    projectAnchor: {
      schemaVersion: 1,
      projectKey: 'example-project',
      uiLabel: 'Example Project',
      compatibleKernelSchemaMajor: 1,
      projectRoot: { kind: 'github_repo', pointer: 'https://github.com/example/project' },
      overlays: [],
    },
    controlLocator: {
      mode: 'existing',
      kind: 'github_file',
      pointer: 'https://github.com/example/project/blob/main/CONTROL.md',
    },
    projectControlObservations: [],
    sessionRoleBinding: null,
    missionAuthority: null,
    capabilityInput: {
      observedAt: '2026-09-17T14:10:00Z',
      surface: 'chatgpt-project',
      observations: [],
    },
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
    parentBinding: { status: 'ACTIVE', provenance: 'EXISTING_PROJECT' },
    lifecycle: 'ACTIVE',
    activeMissionRef: null,
    nextSafeAction: 'continue the current project plan',
    pointers: [],
    ...overrides,
  };
}

test('stable locator key exists before provider creates the final control object', () => {
  const locator = {
    mode: 'scoped_identity',
    container: { kind: 'notion_page', pointer: 'https://notion.so/project-root' },
    identity: 'notion-management-control',
  };
  assert.equal(
    stableControlLocatorKey(locator),
    'scoped_identity:notion_page:https://notion.so/project-root#notion-management-control',
  );
});

test('fresh conversation is unbound by default even when control is readable', () => {
  const input = baseInput();
  input.projectControlObservations = [{
    locatorKey: stableControlLocatorKey(input.controlLocator),
    resolvedControlPointer: input.controlLocator.pointer,
    control: control(),
  }];
  const result = resolveProjectAdoption(input);
  assert.equal(result.adoption.mode, 'EXISTING_CONTROL');
  assert.equal(result.sessionRole.role, 'unbound');
  assert.equal(result.sessionRole.readOnly, true);
  assert.equal(result.control.revision, 'CTRL-0001');
});

test('existing mature control adopts kernel without GENESIS or control reset', () => {
  const input = baseInput({
    projectAnchor: {
      ...baseInput().projectAnchor,
      projectKey: 'china-demand',
      uiLabel: 'China Demand',
    },
  });
  input.projectControlObservations = [{
    locatorKey: stableControlLocatorKey(input.controlLocator),
    resolvedControlPointer: input.controlLocator.pointer,
    control: control({ projectKey: 'china-demand', revision: 'CTRL-0005' }),
  }];
  input.sessionRoleBinding = {
    status: 'bound',
    role: 'ongoing_parent',
    provenance: 'DESTINATION_CONTROL_PARENT_BINDING',
  };
  const result = resolveProjectAdoption(input);
  assert.equal(result.adoption.mode, 'EXISTING_CONTROL');
  assert.equal(result.adoption.requiresGenesis, false);
  assert.equal(result.control.revision, 'CTRL-0005');
  assert.equal(result.sessionRole.role, 'ongoing_parent');
});

test('provider-real GENESIS uses stable container identity and returns exact provider readback', () => {
  const locator = {
    mode: 'scoped_identity',
    container: { kind: 'notion_page', pointer: 'https://notion.so/project-root' },
    identity: 'notion-management-control',
  };
  const result = resolveProjectAdoption(baseInput({
    controlLocator: locator,
    adoptionAuthorization: {
      status: 'authorized',
      mode: 'new_genesis',
      projectKey: 'example-project',
      locatorKey: stableControlLocatorKey(locator),
      grantedBy: 'HUMAN_PRINCIPAL',
      permittedAction: 'CREATE_MINIMAL_PROJECT_CONTROL',
      charter: { purpose: 'manage the project', hardBoundaries: ['no bulk destructive mutation'] },
    },
    projectControlObservations: [{
      locatorKey: stableControlLocatorKey(locator),
      containerPointer: locator.container.pointer,
      controlIdentity: locator.identity,
      resolvedControlPointer: 'https://notion.so/notion-management-control-created-id',
      control: control(),
    }],
  }));
  assert.equal(result.adoption.mode, 'EXISTING_CONTROL');
  assert.equal(result.adoption.resolvedControlPointer, 'https://notion.so/notion-management-control-created-id');
});

test('new GENESIS remains authorized before first control exists without a second Project Settings edit', () => {
  const locator = {
    mode: 'scoped_identity',
    container: { kind: 'notion_page', pointer: 'https://notion.so/project-root' },
    identity: 'notion-management-control',
  };
  const result = resolveProjectAdoption(baseInput({
    controlLocator: locator,
    adoptionAuthorization: {
      status: 'authorized', mode: 'new_genesis', projectKey: 'example-project',
      locatorKey: stableControlLocatorKey(locator), grantedBy: 'HUMAN_PRINCIPAL',
      permittedAction: 'CREATE_MINIMAL_PROJECT_CONTROL',
      charter: { purpose: 'manage the project', hardBoundaries: ['no bulk destructive mutation'] },
    },
  }));
  assert.equal(result.adoption.mode, 'NEW_GENESIS');
  assert.equal(result.adoption.requiresControlCreation, true);
  assert.equal(result.sessionRole.role, 'unbound');
});

test('mature no-control project can only materialize minimal control under narrow authorization', () => {
  const locator = {
    mode: 'scoped_identity',
    container: { kind: 'github_repo', pointer: 'https://github.com/example/project' },
    identity: 'PROJECT_CONTROL.md',
  };
  const result = resolveProjectAdoption(baseInput({
    controlLocator: locator,
    adoptionAuthorization: {
      status: 'authorized', mode: 'materialize_control', projectKey: 'example-project',
      locatorKey: stableControlLocatorKey(locator), grantedBy: 'HUMAN_PRINCIPAL',
      permittedAction: 'MATERIALIZE_MINIMAL_PROJECT_CONTROL',
      sourceTruthPointers: [
        'https://github.com/example/project/issues/7',
        'https://github.com/example/project/pull/8',
      ],
    },
  }));
  assert.equal(result.adoption.mode, 'MATERIALIZE_CONTROL');
  assert.equal(result.adoption.requiresGenesis, false);
  assert.equal(result.adoption.locatorKey, 'scoped_identity:github_repo:https://github.com/example/project#PROJECT_CONTROL.md');
  assert.deepEqual(result.adoption.sourceTruthPointers, [
    'https://github.com/example/project/issues/7',
    'https://github.com/example/project/pull/8',
  ]);
});

test('materialize control rejects a nonexistent final-file locator encoded as existing', () => {
  const locator = baseInput().controlLocator;
  assert.throws(
    () => resolveProjectAdoption(baseInput({
      controlLocator: locator,
      adoptionAuthorization: {
        status: 'authorized', mode: 'materialize_control', projectKey: 'example-project',
        locatorKey: stableControlLocatorKey(locator), grantedBy: 'HUMAN_PRINCIPAL',
        permittedAction: 'MATERIALIZE_MINIMAL_PROJECT_CONTROL',
        sourceTruthPointers: ['https://github.com/example/project/issues/7'],
      },
    })),
    /materialize_control requires a provider-real scoped_identity locator/,
  );
});

test('replacement candidate is read-only until destination takeover commits', () => {
  const input = baseInput();
  input.projectControlObservations = [{
    locatorKey: stableControlLocatorKey(input.controlLocator),
    resolvedControlPointer: input.controlLocator.pointer,
    control: control(),
  }];
  input.sessionRoleBinding = {
    status: 'candidate',
    role: 'replacement_parent',
    provenance: 'FRESH_REPLACEMENT_INVOCATION',
  };
  const result = resolveProjectAdoption(input);
  assert.equal(result.sessionRole.role, 'replacement_parent');
  assert.equal(result.sessionRole.readOnly, true);
  assert.equal(result.sessionRole.takeoverCommitted, false);
});

test('ambiguous scoped control observations fail closed and capability never grants authority', () => {
  const locator = {
    mode: 'scoped_identity',
    container: { kind: 'notion_page', pointer: 'https://notion.so/root' },
    identity: 'control',
  };
  const obs = (pointer) => ({
    locatorKey: stableControlLocatorKey(locator),
    containerPointer: locator.container.pointer,
    controlIdentity: locator.identity,
    resolvedControlPointer: pointer,
    control: control(),
  });
  assert.throws(
    () => resolveProjectAdoption(baseInput({
      controlLocator: locator,
      projectControlObservations: [obs('provider://one'), obs('provider://two')],
      capabilityInput: {
        observedAt: '2026-09-17T14:10:00Z', surface: 'chatgpt-project', observations: [{
          operation: 'provider.write', routeFamily: 'CHATGPT_NATIVE', provider: 'Notion',
          exposed: true, executable: true, resourceAuthorized: true, constraintsSufficient: true,
        }],
      },
    })),
    /project control discovery is ambiguous/,
  );
});
