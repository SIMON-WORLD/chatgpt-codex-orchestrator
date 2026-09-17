import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveProjectAdoption, stableControlLocatorKey } from '../src/operating-model/adoption.js';

const manifest = JSON.parse(fs.readFileSync(
  fileURLToPath(new URL('../operating-model/kernel-manifest.json', import.meta.url)),
  'utf8',
));

test('ongoing Parent role remains separate from mutation authority', () => {
  const locator = {
    mode: 'existing',
    kind: 'github_file',
    pointer: 'https://github.com/example/project/blob/main/CONTROL.md',
  };
  const result = resolveProjectAdoption({
    kernelManifest: manifest,
    observedKernelRepository: 'SIMON-WORLD/chatgpt-codex-orchestrator',
    observedKernelRef: 'main',
    observedKernelSha: 'a24cf09122334678702362ec81c0af79a7c9bca8',
    projectAnchor: {
      schemaVersion: 1,
      projectKey: 'example-project',
      uiLabel: 'Example Project',
      compatibleKernelSchemaMajor: 1,
      projectRoot: { kind: 'github_repo', pointer: 'https://github.com/example/project' },
      overlays: [],
    },
    controlLocator: locator,
    projectControlObservations: [{
      locatorKey: stableControlLocatorKey(locator),
      resolvedControlPointer: locator.pointer,
      control: {
        schemaVersion: 1,
        projectKey: 'example-project',
        controlId: 'primary',
        revision: 'CTRL-0001',
        freshness: 'current',
        writerState: 'clear',
        parentBinding: { status: 'ACTIVE', provenance: 'DESTINATION_CONTROL' },
        lifecycle: 'ACTIVE',
        activeMissionRef: null,
        nextSafeAction: 'continue accepted project work',
        pointers: [],
      },
    }],
    sessionRoleBinding: {
      status: 'bound',
      role: 'ongoing_parent',
      provenance: 'DESTINATION_CONTROL',
    },
    missionAuthority: null,
    capabilityInput: {
      observedAt: '2026-09-17T14:30:00Z',
      surface: 'chatgpt-project',
      observations: [{
        operation: 'repository.write',
        routeFamily: 'CHATGPT_NATIVE',
        provider: 'GitHub',
        exposed: true,
        executable: true,
        resourceAuthorized: true,
        constraintsSufficient: true,
      }],
    },
  });

  assert.equal(result.sessionRole.role, 'ongoing_parent');
  assert.equal(result.sessionRole.bound, true);
  assert.equal(result.capabilities.availableOperations.includes('repository.write'), true);
  assert.equal(result.authority.bound, false);
  assert.equal(result.authority.readOnly, true);
  assert.deepEqual(result.authority.mutableRepositories, []);
});
