import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  BootstrapError,
  deriveCapabilityEnvelope,
  resolveBootstrap,
  assertRepositoryMutationAuthorized,
} from '../src/operating-model/bootstrap.js';

const manifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../operating-model/kernel-manifest.json', import.meta.url)), 'utf8'));
const SHA = '581bb2b1ecad549b25e388a10edf55f3d268e7a7';

function baseProfile(overrides = {}) {
  return {
    schemaVersion: 1,
    projectKey: 'bounded-project',
    uiLabel: 'Bounded Project',
    compatibleKernelSchemaMajor: 1,
    durableSources: [{ kind: 'project_control', pointer: 'https://github.com/example/bounded/blob/main/CONTROL.md' }],
    overlays: [],
    ...overrides,
  };
}

function baseBootstrap(overrides = {}) {
  return {
    kernelManifest: manifest,
    observedKernelRepository: 'SIMON-WORLD/chatgpt-codex-orchestrator',
    observedKernelRef: 'main',
    observedKernelSha: SHA,
    projectProfile: baseProfile(),
    missionAuthority: null,
    capabilityInput: { observedAt: '2026-09-17T10:00:00Z', surface: 'chatgpt-project', observations: [] },
    ...overrides,
  };
}

test('replacement recovery depends on durable pointers, not transcript or memory payload', () => {
  const clean = resolveBootstrap(baseBootstrap());
  const noisy = resolveBootstrap({
    ...baseBootstrap(),
    transcript: 'stale conversation says another project is current',
    memory: { latestProject: 'wrong-project', mostRecentMission: 999 },
  });
  assert.deepEqual(noisy, clean);
  assert.equal(noisy.project.projectKey, 'bounded-project');
});

test('missing project profile fails closed instead of guessing a latest project', () => {
  assert.throws(
    () => resolveBootstrap(baseBootstrap({ projectProfile: null })),
    (error) => error instanceof BootstrapError && /project profile must be an object/.test(error.message),
  );
});

test('cross-repo read evidence pointer is allowed while mutation remains fenced', () => {
  const result = resolveBootstrap(baseBootstrap({
    projectProfile: baseProfile({
      durableSources: [
        { kind: 'project_control', pointer: 'https://github.com/example/bounded/blob/main/CONTROL.md' },
        { kind: 'read_only_evidence', pointer: 'https://github.com/other/reference/blob/main/README.md' },
      ],
    }),
    missionAuthority: { status: 'bound', mutableRepositories: ['example/bounded'] },
  }));

  assert.equal(result.project.durableSources[1].kind, 'read_only_evidence');
  assert.doesNotThrow(() => assertRepositoryMutationAuthorized('example/bounded', result.authority));
  assert.throws(() => assertRepositoryMutationAuthorized('other/reference', result.authority), BootstrapError);
});

test('provider/tool exposure without resource permission is unavailable and authority-neutral', () => {
  const envelope = deriveCapabilityEnvelope({
    observedAt: '2026-09-17T10:00:00Z',
    surface: 'chatgpt-project',
    observations: [{
      operation: 'github.contents.write',
      routeFamily: 'CHATGPT_NATIVE',
      provider: 'GitHub Connector',
      exposed: true,
      executable: true,
      resourceAuthorized: false,
      constraintsSufficient: true,
      failureCode: 'RESOURCE_NOT_AUTHORIZED',
    }],
  });
  assert.deepEqual(envelope.availableOperations, []);

  const result = resolveBootstrap(baseBootstrap({ capabilityInput: {
    observedAt: envelope.observedAt,
    surface: envelope.surface,
    observations: envelope.observations.map(({ availability, ...entry }) => entry),
  } }));
  assert.equal(result.authority.bound, false);
  assert.equal(result.authority.readOnly, true);
});

test('capability doctor output cannot satisfy repository mutation authorization', () => {
  const result = resolveBootstrap(baseBootstrap({
    capabilityInput: {
      observedAt: '2026-09-17T10:00:00Z',
      surface: 'chatgpt-project',
      observations: [{
        operation: 'github.contents.write',
        routeFamily: 'CHATGPT_NATIVE',
        provider: 'GitHub Connector',
        exposed: true,
        executable: true,
        resourceAuthorized: true,
        constraintsSufficient: true,
      }],
    },
  }));
  assert.deepEqual(result.capabilities.availableOperations, ['github.contents.write']);
  assert.throws(() => assertRepositoryMutationAuthorized('example/bounded', result.authority), BootstrapError);
});
