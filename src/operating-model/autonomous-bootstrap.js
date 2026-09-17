import {
  BootstrapError,
  validateProjectProfile,
  validateProjectControl,
  resolveBootstrap,
} from './bootstrap.js';

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

/**
 * Convert the one stable Project Settings anchor into the preferred v2 profile.
 * The anchor is intentionally authority-neutral and contains no live mission state.
 */
export function projectProfileFromAnchor(input, { kernelSchemaMajor = null } = {}) {
  const source = assertObject(input, 'project anchor');
  const anchorSchemaVersion = positiveInteger(source.schemaVersion, 'projectAnchor.schemaVersion');
  if (anchorSchemaVersion !== 1) throw new BootstrapError('unsupported project anchor schemaVersion');

  // Spread the source deliberately: validateProjectProfile must see and reject any
  // forbidden live/transient keys instead of silently dropping them during conversion.
  return validateProjectProfile({
    ...source,
    schemaVersion: 2,
    projectKey: nonEmptyString(source.projectKey, 'projectAnchor.projectKey'),
    uiLabel: nonEmptyString(source.uiLabel, 'projectAnchor.uiLabel'),
    compatibleKernelSchemaMajor: positiveInteger(
      source.compatibleKernelSchemaMajor,
      'projectAnchor.compatibleKernelSchemaMajor',
    ),
    durableSources: source.durableSources || [],
    overlays: source.overlays || [],
  }, { kernelSchemaMajor });
}

/**
 * Resolve one observed downstream-owned control head for the stable control root.
 * This function never ranks by time, revision number, issue number, or array order.
 */
export function discoverProjectControlHead(projectProfile, observations = []) {
  const project = validateProjectProfile(projectProfile);
  if (project.schemaVersion !== 2) {
    throw new BootstrapError('autonomous project control discovery requires a v2 project profile');
  }
  if (!Array.isArray(observations)) {
    throw new BootstrapError('projectControlObservations must be an array');
  }
  if (observations.length === 0) return null;

  const matching = [];
  observations.forEach((entry, index) => {
    const item = assertObject(entry, `projectControlObservations[${index}]`);
    const controlRootPointer = nonEmptyString(
      item.controlRootPointer,
      `projectControlObservations[${index}].controlRootPointer`,
    );
    if (controlRootPointer === project.controlRoot.pointer) matching.push(item.control);
  });

  if (matching.length === 0) {
    throw new BootstrapError('no project control observation matches the stable control root');
  }
  if (matching.length !== 1) {
    throw new BootstrapError('project control discovery is ambiguous', { matchingControlHeads: matching.length });
  }

  return validateProjectControl(matching[0], { projectKey: project.projectKey });
}

/**
 * Provider-neutral operator path: stable anchor -> unique project-local control head
 * (or bounded GENESIS) -> existing bootstrap/authority/capability semantics.
 * Provider adapters are responsible only for returning bounded observations; this
 * pure resolver persists nothing and creates no registry, watcher, or authority plane.
 */
export function resolveAutonomousBootstrap({
  projectAnchor,
  projectControlObservations = [],
  ...bootstrapInput
} = {}) {
  const kernelSchemaMajor = bootstrapInput.kernelManifest?.kernelSchemaVersion ?? null;
  const projectProfile = projectProfileFromAnchor(projectAnchor, { kernelSchemaMajor });
  const projectControl = discoverProjectControlHead(projectProfile, projectControlObservations);

  return resolveBootstrap({
    ...bootstrapInput,
    projectProfile,
    projectControl,
  });
}
