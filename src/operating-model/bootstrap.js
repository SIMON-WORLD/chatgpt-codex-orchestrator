const SHA_RE = /^[0-9a-f]{40}$/i;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ROUTE_FAMILIES = Object.freeze(['CHATGPT_NATIVE', 'CHATGPT_DIRECT_LOCAL', 'CODEX_DELEGATE']);
const MISSION_TYPES = Object.freeze(['IMPLEMENT', 'DOGFOOD', 'REVIEW', 'RUNTIME', 'INVESTIGATE']);
const FORBIDDEN_PROFILE_KEYS = new Set([
  'mutableRepositories',
  'primaryMutableRepository',
  'parentAuthority',
  'missionAuthority',
  'acceptance',
  'activeMission',
  'activeMissionRef',
  'currentMission',
  'currentIssue',
  'missionPointer',
  'nextSafeAction',
  'authorityToken',
  'executionToken',
  'token',
  'credential',
  'credentials',
  'secret',
  'secrets',
  'taskId',
  'jobId',
  'stepId',
  'threadId',
  'turnId',
  'workspaceId',
]);

export class BootstrapError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BootstrapError';
    this.details = details;
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BootstrapError(`${label} must be an object`);
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BootstrapError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new BootstrapError(`${label} must be a positive integer`);
  }
  return value;
}

function exactSha(value, label) {
  const sha = nonEmptyString(value, label).toLowerCase();
  if (!SHA_RE.test(sha)) throw new BootstrapError(`${label} must be an exact 40-hex commit SHA`);
  return sha;
}

function canonicalRepository(value, label = 'repository') {
  const repo = nonEmptyString(value, label);
  if (!REPO_RE.test(repo)) throw new BootstrapError(`${label} must be canonical owner/name`);
  return repo;
}

function stringArray(value, label, { nonEmpty = true } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new BootstrapError(`${label} must be ${nonEmpty ? 'a non-empty' : 'an'} array`);
  }
  const out = value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
  if (new Set(out).size !== out.length) throw new BootstrapError(`${label} must not contain duplicates`);
  return out;
}

function assertNoForbiddenProfileKeys(value, path = 'profile') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenProfileKeys(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_PROFILE_KEYS.has(key)) {
      throw new BootstrapError(
        'project profile cannot carry authority, live mission, secrets, or transient execution state',
        { path: `${path}.${key}` },
      );
    }
    assertNoForbiddenProfileKeys(entry, `${path}.${key}`);
  }
}

function validatePointerRecord(value, label) {
  const item = assertObject(value, label);
  return {
    kind: nonEmptyString(item.kind, `${label}.kind`),
    pointer: nonEmptyString(item.pointer, `${label}.pointer`),
  };
}

function validatePointerRecords(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new BootstrapError(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
  }
  return value.map((entry, index) => validatePointerRecord(entry, `${label}[${index}]`));
}

function validateMissionRef(value, label = 'missionRef') {
  const item = validatePointerRecord(value, label);
  const result = { ...item };
  if (value.displayRef !== undefined) {
    const displayRef = nonEmptyString(value.displayRef, `${label}.displayRef`);
    if (/\r|\n|\|/.test(displayRef)) throw new BootstrapError(`${label}.displayRef must be a safe single-line label`);
    result.displayRef = displayRef;
  }
  return result;
}

export function validateKernelManifest(input) {
  const manifest = assertObject(input, 'kernel manifest');
  if ('policyPayload' in manifest) {
    throw new BootstrapError('kernel manifest must point to policy sources rather than duplicate policy payload');
  }

  const kernelSchemaVersion = positiveInteger(manifest.kernelSchemaVersion, 'kernelSchemaVersion');
  const canonicalRepo = canonicalRepository(manifest.canonicalRepository, 'canonicalRepository');
  const defaultRef = nonEmptyString(manifest.defaultRef, 'defaultRef');
  if (defaultRef !== 'main') throw new BootstrapError('defaultRef must be current main');

  return {
    kernelSchemaVersion,
    canonicalRepository: canonicalRepo,
    defaultRef,
    normativeSources: stringArray(manifest.normativeSources, 'normativeSources'),
    recoverySources: stringArray(manifest.recoverySources, 'recoverySources'),
    semanticAssertions: stringArray(manifest.semanticAssertions, 'semanticAssertions'),
    missionTypes: stringArray(manifest.missionTypes, 'missionTypes'),
  };
}

export function validateProjectProfile(input, { kernelSchemaMajor = null } = {}) {
  const source = assertObject(input, 'project profile');
  assertNoForbiddenProfileKeys(source);

  const schemaVersion = positiveInteger(source.schemaVersion, 'profile.schemaVersion');
  if (![1, 2].includes(schemaVersion)) throw new BootstrapError('unsupported project profile schemaVersion');

  const compatibleKernelSchemaMajor = positiveInteger(
    source.compatibleKernelSchemaMajor,
    'profile.compatibleKernelSchemaMajor',
  );
  if (kernelSchemaMajor !== null && compatibleKernelSchemaMajor !== kernelSchemaMajor) {
    throw new BootstrapError('project profile is incompatible with observed kernel schema major', {
      compatibleKernelSchemaMajor,
      kernelSchemaMajor,
    });
  }

  const result = {
    schemaVersion,
    projectKey: nonEmptyString(source.projectKey, 'profile.projectKey'),
    uiLabel: nonEmptyString(source.uiLabel, 'profile.uiLabel'),
    compatibleKernelSchemaMajor,
    durableSources: validatePointerRecords(
      source.durableSources || [],
      'profile.durableSources',
      { allowEmpty: schemaVersion === 2 },
    ),
    overlays: validatePointerRecords(source.overlays || [], 'profile.overlays', { allowEmpty: true }),
  };

  if (schemaVersion === 2) {
    result.projectRoot = validatePointerRecord(source.projectRoot, 'profile.projectRoot');
    result.controlRoot = validatePointerRecord(source.controlRoot, 'profile.controlRoot');
  }

  if (source.referenceProjects !== undefined) {
    if (!Array.isArray(source.referenceProjects)) throw new BootstrapError('profile.referenceProjects must be an array');
    result.referenceProjects = source.referenceProjects.map((entry, index) => {
      const item = assertObject(entry, `profile.referenceProjects[${index}]`);
      const role = nonEmptyString(item.role, `profile.referenceProjects[${index}].role`);
      if (role !== 'dogfood_evidence_only') {
        throw new BootstrapError('reference projects are dogfood/evidence only and cannot become dependencies or authority');
      }
      return {
        projectKey: nonEmptyString(item.projectKey, `profile.referenceProjects[${index}].projectKey`),
        pointer: nonEmptyString(item.pointer, `profile.referenceProjects[${index}].pointer`),
        role,
      };
    });
  }

  return result;
}

export function validateProjectControl(input, { projectKey = null } = {}) {
  const source = assertObject(input, 'project control');
  const schemaVersion = positiveInteger(source.schemaVersion, 'projectControl.schemaVersion');
  if (schemaVersion !== 1) throw new BootstrapError('unsupported project control schemaVersion');

  const controlProjectKey = nonEmptyString(source.projectKey, 'projectControl.projectKey');
  if (projectKey !== null && controlProjectKey !== projectKey) {
    throw new BootstrapError('project control does not match project profile identity');
  }

  const freshness = nonEmptyString(source.freshness, 'projectControl.freshness');
  const writerState = nonEmptyString(source.writerState, 'projectControl.writerState');
  if (freshness !== 'current' || writerState !== 'clear') {
    throw new BootstrapError('project control is not current and conflict-free', { freshness, writerState });
  }

  const parentBinding = assertObject(source.parentBinding, 'projectControl.parentBinding');
  const activeMissionRef = source.activeMissionRef == null
    ? null
    : validateMissionRef(source.activeMissionRef, 'projectControl.activeMissionRef');
  const nextSafeAction = source.nextSafeAction == null
    ? null
    : nonEmptyString(source.nextSafeAction, 'projectControl.nextSafeAction');

  if ((activeMissionRef === null) === (nextSafeAction === null)) {
    throw new BootstrapError('project control must expose exactly one of activeMissionRef or nextSafeAction');
  }

  return {
    schemaVersion,
    projectKey: controlProjectKey,
    controlId: nonEmptyString(source.controlId, 'projectControl.controlId'),
    revision: nonEmptyString(source.revision, 'projectControl.revision'),
    freshness,
    writerState,
    parentBinding: {
      status: nonEmptyString(parentBinding.status, 'projectControl.parentBinding.status'),
      provenance: nonEmptyString(parentBinding.provenance, 'projectControl.parentBinding.provenance'),
    },
    lifecycle: nonEmptyString(source.lifecycle, 'projectControl.lifecycle'),
    activeMissionRef,
    nextSafeAction,
    pointers: validatePointerRecords(source.pointers || [], 'projectControl.pointers', { allowEmpty: true }),
  };
}

export function deriveCapabilityEnvelope(input) {
  const source = assertObject(input, 'capability input');
  const observations = Array.isArray(source.observations) ? source.observations : [];
  const normalized = observations.map((entry, index) => {
    const item = assertObject(entry, `observations[${index}]`);
    const routeFamily = nonEmptyString(item.routeFamily, `observations[${index}].routeFamily`);
    if (!ROUTE_FAMILIES.includes(routeFamily)) {
      throw new BootstrapError(`observations[${index}].routeFamily is unsupported`);
    }

    const boolKeys = ['exposed', 'executable', 'resourceAuthorized', 'constraintsSufficient'];
    for (const key of boolKeys) {
      if (typeof item[key] !== 'boolean') {
        throw new BootstrapError(`observations[${index}].${key} must be boolean`);
      }
    }

    const available = boolKeys.every((key) => item[key] === true);
    return {
      operation: nonEmptyString(item.operation, `observations[${index}].operation`),
      routeFamily,
      provider: nonEmptyString(item.provider, `observations[${index}].provider`),
      exposed: item.exposed,
      executable: item.executable,
      resourceAuthorized: item.resourceAuthorized,
      constraintsSufficient: item.constraintsSufficient,
      availability: available ? 'AVAILABLE' : 'UNAVAILABLE',
      ...(item.resource !== undefined ? { resource: String(item.resource) } : {}),
      ...(item.failureCode !== undefined ? { failureCode: String(item.failureCode) } : {}),
    };
  });

  const availableOperations = [];
  for (const observation of normalized) {
    if (observation.availability === 'AVAILABLE' && !availableOperations.includes(observation.operation)) {
      availableOperations.push(observation.operation);
    }
  }

  return {
    observedAt: nonEmptyString(source.observedAt, 'capabilityInput.observedAt'),
    surface: nonEmptyString(source.surface, 'capabilityInput.surface'),
    observations: normalized,
    availableOperations,
    connectedProviders: [...new Set(normalized.filter((x) => x.exposed).map((x) => x.provider))],
    localPlaneObserved: normalized.some((x) => x.routeFamily !== 'CHATGPT_NATIVE' && x.exposed),
  };
}

function availableRoutesForOperation(operation, envelope) {
  return envelope.observations
    .filter((entry) => entry.operation === operation && entry.availability === 'AVAILABLE')
    .map((entry) => entry.routeFamily);
}

export function routeRequiredOperations(requiredOperations, envelopeInput) {
  if (!Array.isArray(requiredOperations)) throw new BootstrapError('requiredOperations must be an array');
  const required = requiredOperations.map((op, index) => nonEmptyString(op, `requiredOperations[${index}]`));
  const envelope = envelopeInput?.observations ? envelopeInput : deriveCapabilityEnvelope(envelopeInput);

  if (required.length === 0) return { route: 'CHATGPT_NATIVE', requiredOperations: [] };

  const routesByOperation = new Map(required.map((op) => [op, availableRoutesForOperation(op, envelope)]));
  const missing = required.filter((op) => routesByOperation.get(op).length === 0);
  if (missing.length) {
    throw new BootstrapError('required operations unavailable in current runtime; no implicit fallback is allowed', { missing });
  }

  for (const route of ROUTE_FAMILIES) {
    if (required.every((op) => routesByOperation.get(op).includes(route))) {
      return { route, requiredOperations: required };
    }
  }

  const nativeOps = required.filter((op) => routesByOperation.get(op).includes('CHATGPT_NATIVE'));
  const remaining = required.filter((op) => !nativeOps.includes(op));
  if (nativeOps.length > 0 && remaining.length > 0) {
    for (const localRoute of ['CHATGPT_DIRECT_LOCAL', 'CODEX_DELEGATE']) {
      if (remaining.every((op) => routesByOperation.get(op).includes(localRoute))) {
        return { route: 'HYBRID', localRoute, requiredOperations: required };
      }
    }
  }

  throw new BootstrapError('required operations are individually available but cannot be composed by an accepted route family');
}

function normalizeMissionAuthority(input) {
  if (!input || input.status !== 'bound') {
    return {
      bound: false,
      readOnly: true,
      mutableRepositories: [],
      reason: input?.status === 'ambiguous' ? 'ambiguous_live_authority' : 'missing_live_authority',
    };
  }

  const repositories = Array.isArray(input.mutableRepositories)
    ? input.mutableRepositories.map((repo, index) => canonicalRepository(repo, `missionAuthority.mutableRepositories[${index}]`))
    : [];
  const missionRef = input.missionRef || input.issuePointer || null;

  return {
    bound: true,
    readOnly: Boolean(input.readOnly) || repositories.length === 0,
    mutableRepositories: [...new Set(repositories)],
    ...(missionRef ? { missionRef: nonEmptyString(missionRef, 'missionAuthority.missionRef') } : {}),
    ...(input.issuePointer ? { issuePointer: nonEmptyString(input.issuePointer, 'missionAuthority.issuePointer') } : {}),
  };
}

function normalizeGenesisAuthorization(input, project, hasControl) {
  if (hasControl) {
    if (input?.status === 'authorized') throw new BootstrapError('genesis cannot rebind existing project control');
    return { required: false, authorized: false, reason: 'project_control_exists' };
  }

  if (project.schemaVersion !== 2) {
    return { required: false, authorized: false, reason: 'legacy_profile_has_no_genesis_contract' };
  }

  if (!input || input.status !== 'authorized') {
    return {
      required: true,
      authorized: false,
      controlRootPointer: project.controlRoot.pointer,
      reason: 'missing_genesis_authorization',
    };
  }

  const source = assertObject(input, 'genesisAuthorization');
  const projectKey = nonEmptyString(source.projectKey, 'genesisAuthorization.projectKey');
  const controlRootPointer = nonEmptyString(source.controlRootPointer, 'genesisAuthorization.controlRootPointer');
  if (projectKey !== project.projectKey || controlRootPointer !== project.controlRoot.pointer) {
    throw new BootstrapError('genesis authorization does not match the stable project/control root');
  }
  if (nonEmptyString(source.grantedBy, 'genesisAuthorization.grantedBy') !== 'HUMAN_PRINCIPAL') {
    throw new BootstrapError('genesis authorization must be granted by HUMAN_PRINCIPAL');
  }
  if (nonEmptyString(source.permittedAction, 'genesisAuthorization.permittedAction') !== 'CREATE_MINIMAL_PROJECT_CONTROL') {
    throw new BootstrapError('genesis authorization is not limited to minimal project-control creation');
  }

  const charter = assertObject(source.charter, 'genesisAuthorization.charter');
  const hardBoundaries = stringArray(charter.hardBoundaries, 'genesisAuthorization.charter.hardBoundaries');
  return {
    required: true,
    authorized: true,
    projectKey,
    controlRootPointer,
    grantedBy: 'HUMAN_PRINCIPAL',
    permittedAction: 'CREATE_MINIMAL_PROJECT_CONTROL',
    charter: {
      purpose: nonEmptyString(charter.purpose, 'genesisAuthorization.charter.purpose'),
      hardBoundaries,
    },
  };
}

function discoverMission(projectControl) {
  if (!projectControl) return { mode: 'GENESIS_REQUIRED' };
  if (projectControl.activeMissionRef) {
    return { mode: 'ACTIVE_MISSION', activeMissionRef: projectControl.activeMissionRef };
  }
  return { mode: 'NEXT_SAFE_ACTION', nextSafeAction: projectControl.nextSafeAction };
}

export function resolveBootstrap({
  kernelManifest,
  observedKernelRepository,
  observedKernelRef,
  observedKernelSha,
  pinnedKernelSha = null,
  projectProfile,
  projectControl = null,
  genesisAuthorization = null,
  missionAuthority = null,
  capabilityInput,
} = {}) {
  const kernel = validateKernelManifest(kernelManifest);
  const observedRepo = canonicalRepository(observedKernelRepository, 'observedKernelRepository');
  if (observedRepo !== kernel.canonicalRepository) {
    throw new BootstrapError('observed kernel repository does not match canonical repository');
  }

  const observedRef = nonEmptyString(observedKernelRef, 'observedKernelRef');
  const observedSha = exactSha(observedKernelSha, 'observedKernelSha');
  let source = 'canonical_current_main';

  if (pinnedKernelSha) {
    const pin = exactSha(pinnedKernelSha, 'pinnedKernelSha');
    if (pin !== observedSha) throw new BootstrapError('explicit kernel pin does not match the observed exact kernel SHA');
    source = 'explicit_exact_pin';
  } else if (observedRef !== kernel.defaultRef) {
    throw new BootstrapError('default bootstrap must observe canonical current main');
  }

  const project = validateProjectProfile(projectProfile, { kernelSchemaMajor: kernel.kernelSchemaVersion });
  const control = projectControl == null
    ? null
    : validateProjectControl(projectControl, { projectKey: project.projectKey });
  const genesis = normalizeGenesisAuthorization(genesisAuthorization, project, control !== null);
  const missionDiscovery = project.schemaVersion === 1 && control === null
    ? { mode: 'LEGACY_CALLER_SUPPLIED' }
    : discoverMission(control);
  const capabilities = deriveCapabilityEnvelope(capabilityInput);
  const authority = normalizeMissionAuthority(missionAuthority);

  if (control?.activeMissionRef && authority.bound) {
    if (!authority.missionRef || authority.missionRef !== control.activeMissionRef.pointer) {
      throw new BootstrapError('bound mission authority does not match project control active mission');
    }
  } else if (control && !control.activeMissionRef && authority.bound) {
    throw new BootstrapError('bound mission authority does not match project control active mission');
  }

  return {
    kernel: {
      schemaMajor: kernel.kernelSchemaVersion,
      canonicalRepository: kernel.canonicalRepository,
      observedRef,
      observedSha,
      source,
      normativeSources: kernel.normativeSources,
      recoverySources: kernel.recoverySources,
      semanticAssertions: kernel.semanticAssertions,
    },
    project,
    control,
    genesis,
    missionDiscovery,
    authority,
    capabilities,
    naming: {
      uiLabel: project.uiLabel,
      missionTypes: [...MISSION_TYPES],
    },
  };
}

export function assertRepositoryMutationAuthorized(targetRepository, authorityInput) {
  const target = canonicalRepository(targetRepository, 'targetRepository');
  const authority = authorityInput && typeof authorityInput === 'object'
    ? authorityInput
    : { bound: false, readOnly: true, mutableRepositories: [] };

  if (!authority.bound || authority.readOnly) {
    throw new BootstrapError('repository mutation authority is not bound');
  }
  const allowed = Array.isArray(authority.mutableRepositories) ? authority.mutableRepositories : [];
  if (!allowed.includes(target)) {
    throw new BootstrapError('repository mutation target is outside the live mutable scope', {
      targetRepository: target,
      mutableRepositories: allowed,
    });
  }
  return true;
}

function renderGeneration(value) {
  const generation = positiveInteger(value, 'generation');
  return `G${String(generation).padStart(2, '0')}`;
}

function renderIssue(value) {
  return positiveInteger(value, 'issue');
}

function renderMissionDisplayRef(source) {
  if (source.issue !== undefined) return `#${renderIssue(source.issue)}`;
  const missionRef = nonEmptyString(source.missionRef, 'missionRef');
  if (/\r|\n|\|/.test(missionRef)) throw new BootstrapError('missionRef must be a safe single-line display reference');
  return missionRef;
}

function cleanUiLabel(value) {
  const label = nonEmptyString(value, 'uiLabel');
  if (/\r|\n/.test(label)) throw new BootstrapError('uiLabel must be a single line');
  return label;
}

export function renderSessionName(input) {
  const source = assertObject(input, 'session name input');
  const uiLabel = cleanUiLabel(source.uiLabel);

  if (source.kind === 'ongoing_parent') {
    const state = nonEmptyString(source.state, 'state');
    if (!['ACTIVE', 'RETIRED'].includes(state)) throw new BootstrapError('ongoing Parent state must be ACTIVE or RETIRED');
    return `① 总控 · ${renderGeneration(source.generation)} · ${state} | ${uiLabel}`;
  }

  if (source.kind === 'mission') {
    const missionType = nonEmptyString(source.missionType, 'missionType');
    if (!MISSION_TYPES.includes(missionType)) throw new BootstrapError('unsupported missionType');
    return `${renderMissionDisplayRef(source)} · ${missionType} | ${uiLabel}`;
  }

  if (source.kind === 'bounded_parent') {
    return `${renderMissionDisplayRef(source)} · PARENT | ${uiLabel}`;
  }

  throw new BootstrapError('unsupported session naming kind');
}

export { MISSION_TYPES, ROUTE_FAMILIES };