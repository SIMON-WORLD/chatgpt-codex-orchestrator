import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  BootstrapError,
  validateKernelManifest,
  validateProjectProfile,
  deriveCapabilityEnvelope,
  routeRequiredOperations,
  resolveBootstrap,
  assertRepositoryMutationAuthorized,
  renderSessionName,
} from '../src/operating-model/bootstrap.js';

const manifestPath = fileURLToPath(new URL('../operating-model/kernel-manifest.json', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const SHA = '581bb2b1ecad549b25e388a10edf55f3d268e7a7';

function profile(overrides = {}) {
  return {
    schemaVersion: 1,
    projectKey: 'example-project',
    uiLabel: 'Example',
    compatibleKernelSchemaMajor: 1,
    durableSources: [
      { kind: 'project_control', pointer: 'https://github.com/example/project/blob/main/CONTROL.md' },
    ],
    overlays: [
      { kind: 'project_policy', pointer: 'https://github.com/example/project/blob/main/PROJECT_POLICY.md' },
    ],
    ...overrides,
  };
}

function obs(operation, routeFamily, overrides = {}) {
  return {
    operation,
    routeFamily,
    provider: overrides.provider || (routeFamily === 'CHATGPT_NATIVE' ? 'GitHub Connector' : 'Local MCP'),
    exposed: true,
    executable: true,
    resourceAuthorized: true,
    constraintsSufficient: true,
    ...overrides,
  };
}

test('kernel manifest is compact, versioned, canonical, and policy-pointer based', () => {
  const validated = validateKernelManifest(manifest);
  assert.equal(validated.kernelSchemaVersion, 1);
  assert.equal(validated.canonicalRepository, 'SIMON-WORLD/chatgpt-codex-orchestrator');
  assert.equal(validated.defaultRef, 'main');
  assert.ok(validated.normativeSources.includes('CAPABILITY_ROUTING.md'));
  assert.ok(validated.recoverySources.includes('PROJECT_STATUS.md'));
  assert.ok(validated.recoverySources.includes('ROADMAP.md'));
  assert.ok(validated.semanticAssertions.includes('capability_not_authority'));
  assert.equal(validated.policyPayload, undefined);
});

test('project profile carries identity and pointers but cannot carry authority or secrets', () => {
  assert.equal(validateProjectProfile(profile()).uiLabel, 'Example');
  for (const forbidden of [
    { mutableRepositories: ['example/project'] },
    { parentAuthority: true },
    { authorityToken: 'secret' },
    { credential: 'secret' },
    { taskId: 'transient' },
  ]) {
    assert.throws(() => validateProjectProfile(profile(forbidden)), BootstrapError);
  }
});

test('capability doctor requires executable/resource/constraint proof, not schema exposure', () => {
  const envelope = deriveCapabilityEnvelope({
    observedAt: '2026-09-17T10:00:00Z',
    surface: 'chatgpt-project',
    observations: [
      obs('local.read', 'CHATGPT_DIRECT_LOCAL', { executable: false, failureCode: 'FORBIDDEN' }),
      obs('github.pr.read', 'CHATGPT_NATIVE'),
    ],
  });
  assert.deepEqual(envelope.availableOperations, ['github.pr.read']);
  assert.equal(envelope.observations[0].availability, 'UNAVAILABLE');
  assert.equal(envelope.observations[1].availability, 'AVAILABLE');
});

test('fresh Project routes Native-first when Native operations are sufficient', () => {
  const envelope = deriveCapabilityEnvelope({
    observedAt: '2026-09-17T10:00:00Z', surface: 'chatgpt-project',
    observations: [obs('github.pr.read', 'CHATGPT_NATIVE'), obs('github.pr.merge', 'CHATGPT_NATIVE')],
  });
  assert.deepEqual(routeRequiredOperations(['github.pr.read', 'github.pr.merge'], envelope), {
    route: 'CHATGPT_NATIVE',
    requiredOperations: ['github.pr.read', 'github.pr.merge'],
  });
});

test('Codex is selected because of an observed capability gap, not a task label', () => {
  const envelope = deriveCapabilityEnvelope({
    observedAt: '2026-09-17T10:00:00Z', surface: 'chatgpt-project',
    observations: [
      obs('local.code.mutate', 'CODEX_DELEGATE', { provider: 'Codex App Server' }),
      obs('local.shell', 'CODEX_DELEGATE', { provider: 'Codex App Server' }),
      obs('local.test', 'CODEX_DELEGATE', { provider: 'Codex App Server' }),
    ],
  });
  assert.equal(routeRequiredOperations(['local.code.mutate', 'local.shell', 'local.test'], envelope).route, 'CODEX_DELEGATE');
});

test('current canonical kernel wins over stale project mirrors and records exact observed SHA', () => {
  const result = resolveBootstrap({
    kernelManifest: manifest,
    observedKernelRepository: 'SIMON-WORLD/chatgpt-codex-orchestrator',
    observedKernelRef: 'main',
    observedKernelSha: SHA,
    projectProfile: profile({ overlays: [{ kind: 'legacy_project_mirror', pointer: 'stale-project-instructions' }] }),
    missionAuthority: { status: 'bound', mutableRepositories: ['example/project'] },
    capabilityInput: { observedAt: '2026-09-17T10:00:00Z', surface: 'chatgpt-project', observations: [] },
  });
  assert.equal(result.kernel.observedSha, SHA);
  assert.equal(result.kernel.source, 'canonical_current_main');
  assert.equal(result.project.uiLabel, 'Example');
});

test('missing or ambiguous live authority stays read-only and unbound', () => {
  for (const missionAuthority of [null, { status: 'ambiguous' }]) {
    const result = resolveBootstrap({
      kernelManifest: manifest,
      observedKernelRepository: 'SIMON-WORLD/chatgpt-codex-orchestrator',
      observedKernelRef: 'main',
      observedKernelSha: SHA,
      projectProfile: profile(), missionAuthority,
      capabilityInput: { observedAt: '2026-09-17T10:00:00Z', surface: 'chatgpt-project', observations: [] },
    });
    assert.equal(result.authority.bound, false);
    assert.equal(result.authority.readOnly, true);
    assert.deepEqual(result.authority.mutableRepositories, []);
  }
});

test('profile repository pointers and capability availability never grant mutation authority', () => {
  const result = resolveBootstrap({
    kernelManifest: manifest,
    observedKernelRepository: 'SIMON-WORLD/chatgpt-codex-orchestrator', observedKernelRef: 'main', observedKernelSha: SHA,
    projectProfile: profile({ durableSources: [{ kind: 'repo', pointer: 'https://github.com/foreign/repo' }] }),
    missionAuthority: null,
    capabilityInput: {
      observedAt: '2026-09-17T10:00:00Z', surface: 'chatgpt-project',
      observations: [obs('github.contents.write', 'CHATGPT_NATIVE')],
    },
  });
  assert.throws(() => assertRepositoryMutationAuthorized('foreign/repo', result.authority), BootstrapError);
});

test('Repository Identity Fence allows cross-repo reads but fences writes outside mutable scope', () => {
  const authority = { bound: true, readOnly: false, mutableRepositories: ['example/project'] };
  assert.doesNotThrow(() => assertRepositoryMutationAuthorized('example/project', authority));
  assert.throws(() => assertRepositoryMutationAuthorized('foreign/repo', authority), BootstrapError);
});

test('Local plane absence does not invent Alpha.3 fallback', () => {
  const envelope = deriveCapabilityEnvelope({
    observedAt: '2026-09-17T10:00:00Z', surface: 'chatgpt-project', observations: [],
  });
  assert.throws(() => routeRequiredOperations(['local.read'], envelope), /required operations unavailable/);
});

test('reference projects cannot leak dependency or authority', () => {
  const p = validateProjectProfile(profile({
    referenceProjects: [
      { projectKey: 'academic-door', pointer: 'https://github.com/example/academic-door', role: 'dogfood_evidence_only' },
    ],
  }));
  assert.equal(p.referenceProjects[0].role, 'dogfood_evidence_only');
  assert.equal(p.referenceProjects[0].authority, undefined);
});

test('kernel schema incompatibility and exact pin mismatch fail closed', () => {
  assert.throws(() => validateProjectProfile(profile({ compatibleKernelSchemaMajor: 2 }), { kernelSchemaMajor: 1 }), BootstrapError);
  assert.throws(() => resolveBootstrap({
    kernelManifest: manifest,
    observedKernelRepository: 'SIMON-WORLD/chatgpt-codex-orchestrator', observedKernelRef: 'main', observedKernelSha: SHA,
    pinnedKernelSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    projectProfile: profile(), missionAuthority: null,
    capabilityInput: { observedAt: '2026-09-17T10:00:00Z', surface: 'chatgpt-project', observations: [] },
  }), BootstrapError);
});

test('canonical UI naming is uniform across projects', () => {
  assert.equal(renderSessionName({ kind: 'ongoing_parent', generation: 1, state: 'ACTIVE', uiLabel: 'Notion Management' }), '① 总控 · G01 · ACTIVE | Notion Management');
  assert.equal(renderSessionName({ kind: 'ongoing_parent', generation: 2, state: 'RETIRED', uiLabel: 'China Demand' }), '① 总控 · G02 · RETIRED | China Demand');
  assert.equal(renderSessionName({ kind: 'mission', issue: 9, missionType: 'IMPLEMENT', uiLabel: 'Clash Rules' }), '#9 · IMPLEMENT | Clash Rules');
  assert.equal(renderSessionName({ kind: 'bounded_parent', issue: 78, uiLabel: 'Orchestrator' }), '#78 · PARENT | Orchestrator');
  assert.throws(() => renderSessionName({ kind: 'mission', issue: 1, missionType: 'RANDOM', uiLabel: 'X' }), BootstrapError);
});
