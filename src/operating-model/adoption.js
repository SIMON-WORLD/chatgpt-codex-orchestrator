import {
  BootstrapError,
  resolveBootstrap,
  validateProjectControl,
} from './bootstrap.js';
import { projectProfileFromAnchor } from './autonomous-bootstrap.js';

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

function stringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BootstrapError(`${label} must be a non-empty array`);
  }
  const result = value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new BootstrapError(`${label} must not contain duplicates`);
  return result;
}

export function stableControlLocatorKey(input) {
  const locator = assertObject(input, 'controlLocator');
  const mode = nonEmptyString(locator.mode, 'controlLocator.mode');

  if (mode === 'existing') {
    return `existing:${nonEmptyString(locator.kind, 'controlLocator.kind')}:${nonEmptyString(locator.pointer, 'controlLocator.pointer')}`;
  }

  if (mode === 'scoped_identity') {
    const container = assertObject(locator.container, 'controlLocator.container');
    const kind = nonEmptyString(container.kind, 'controlLocator.container.kind');
    const pointer = nonEmptyString(container.pointer, 'controlLocator.container.pointer');
    const identity = nonEmptyString(locator.identity, 'controlLocator.identity');
    if (/\r|\n|#/.test(identity)) throw new BootstrapError('controlLocator.identity must be a safe stable identity');
    return `scoped_identity:${kind}:${pointer}#${identity}`;
  }

  throw new BootstrapError('unsupported controlLocator.mode');
}

function normalizeLocator(input) {
  const locator = assertObject(input, 'controlLocator');
  const mode = nonEmptyString(locator.mode, 'controlLocator.mode');
  const key = stableControlLocatorKey(locator);
  if (mode === 'existing') {
    return {
      mode,
      key,
      kind: nonEmptyString(locator.kind, 'controlLocator.kind'),
      pointer: nonEmptyString(locator.pointer, 'controlLocator.pointer'),
    };
  }
  return {
    mode,
    key,
    container: {
      kind: nonEmptyString(locator.container.kind, 'controlLocator.container.kind'),
      pointer: nonEmptyString(locator.container.pointer, 'controlLocator.container.pointer'),
    },
    identity: nonEmptyString(locator.identity, 'controlLocator.identity'),
  };
}

function discoverControl(projectKey, locator, observations) {
  if (!Array.isArray(observations)) throw new BootstrapError('projectControlObservations must be an array');
  const matches = [];

  observations.forEach((entry, index) => {
    const item = assertObject(entry, `projectControlObservations[${index}]`);
    if (nonEmptyString(item.locatorKey, `projectControlObservations[${index}].locatorKey`) !== locator.key) return;

    if (locator.mode === 'existing') {
      const resolved = nonEmptyString(
        item.resolvedControlPointer,
        `projectControlObservations[${index}].resolvedControlPointer`,
      );
      if (resolved !== locator.pointer) return;
    } else {
      const containerPointer = nonEmptyString(
        item.containerPointer,
        `projectControlObservations[${index}].containerPointer`,
      );
      const controlIdentity = nonEmptyString(
        item.controlIdentity,
        `projectControlObservations[${index}].controlIdentity`,
      );
      if (containerPointer !== locator.container.pointer || controlIdentity !== locator.identity) return;
    }

    matches.push({
      control: item.control,
      resolvedControlPointer: nonEmptyString(
        item.resolvedControlPointer,
        `projectControlObservations[${index}].resolvedControlPointer`,
      ),
    });
  });

  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new BootstrapError('project control discovery is ambiguous', { matchingControlHeads: matches.length });
  }
  return {
    control: validateProjectControl(matches[0].control, { projectKey }),
    resolvedControlPointer: matches[0].resolvedControlPointer,
  };
}

function normalizeAdoptionAuthorization(input, { projectKey, locator, hasControl }) {
  if (hasControl) {
    return { mode: 'EXISTING_CONTROL', requiresGenesis: false, requiresControlCreation: false };
  }

  if (!input || input.status !== 'authorized') {
    return {
      mode: 'UNBOUND_NO_CONTROL',
      requiresGenesis: false,
      requiresControlCreation: false,
      reason: 'missing_adoption_authorization',
    };
  }

  const source = assertObject(input, 'adoptionAuthorization');
  if (nonEmptyString(source.projectKey, 'adoptionAuthorization.projectKey') !== projectKey) {
    throw new BootstrapError('adoption authorization does not match project identity');
  }
  if (nonEmptyString(source.locatorKey, 'adoptionAuthorization.locatorKey') !== locator.key) {
    throw new BootstrapError('adoption authorization does not match stable control locator');
  }
  if (nonEmptyString(source.grantedBy, 'adoptionAuthorization.grantedBy') !== 'HUMAN_PRINCIPAL') {
    throw new BootstrapError('adoption authorization must be granted by HUMAN_PRINCIPAL');
  }

  const mode = nonEmptyString(source.mode, 'adoptionAuthorization.mode');
  if (mode === 'new_genesis') {
    if (locator.mode !== 'scoped_identity') {
      throw new BootstrapError('new_genesis requires a provider-real scoped_identity locator');
    }
    if (nonEmptyString(source.permittedAction, 'adoptionAuthorization.permittedAction') !== 'CREATE_MINIMAL_PROJECT_CONTROL') {
      throw new BootstrapError('new_genesis is not limited to minimal project-control creation');
    }
    const charter = assertObject(source.charter, 'adoptionAuthorization.charter');
    return {
      mode: 'NEW_GENESIS',
      requiresGenesis: true,
      requiresControlCreation: true,
      locatorKey: locator.key,
      charter: {
        purpose: nonEmptyString(charter.purpose, 'adoptionAuthorization.charter.purpose'),
        hardBoundaries: stringArray(charter.hardBoundaries, 'adoptionAuthorization.charter.hardBoundaries'),
      },
    };
  }

  if (mode === 'materialize_control') {
    if (nonEmptyString(source.permittedAction, 'adoptionAuthorization.permittedAction') !== 'MATERIALIZE_MINIMAL_PROJECT_CONTROL') {
      throw new BootstrapError('materialize_control is not limited to minimal project-control materialization');
    }
    return {
      mode: 'MATERIALIZE_CONTROL',
      requiresGenesis: false,
      requiresControlCreation: true,
      locatorKey: locator.key,
      sourceTruthPointers: stringArray(source.sourceTruthPointers, 'adoptionAuthorization.sourceTruthPointers'),
    };
  }

  throw new BootstrapError('unsupported adoptionAuthorization.mode');
}

function normalizeSessionRole(input, { control, missionDiscovery, authority }) {
  if (!input) return { role: 'unbound', bound: false, readOnly: true, takeoverCommitted: false };
  const source = assertObject(input, 'sessionRoleBinding');
  const role = nonEmptyString(source.role, 'sessionRoleBinding.role');
  const status = nonEmptyString(source.status, 'sessionRoleBinding.status');
  const provenance = nonEmptyString(source.provenance, 'sessionRoleBinding.provenance');

  if (role === 'replacement_parent') {
    if (status === 'candidate') {
      return { role, bound: false, readOnly: true, takeoverCommitted: false, provenance };
    }
    if (status !== 'bound' || source.takeoverCommitted !== true) {
      throw new BootstrapError('replacement parent cannot mutate before destination takeover commit');
    }
    return { role, bound: true, readOnly: false, takeoverCommitted: true, provenance };
  }

  if (status !== 'bound') throw new BootstrapError('session role is not bound');

  if (role === 'ongoing_parent') {
    if (!control || control.parentBinding.status !== 'ACTIVE') {
      throw new BootstrapError('ongoing Parent role requires active destination project control binding');
    }
    return { role, bound: true, readOnly: false, takeoverCommitted: true, provenance };
  }

  if (role === 'bounded_mission' || role === 'bounded_parent') {
    if (missionDiscovery.mode !== 'ACTIVE_MISSION' || !authority.bound) {
      throw new BootstrapError('bounded role requires matching active mission authority');
    }
    return { role, bound: true, readOnly: authority.readOnly, takeoverCommitted: true, provenance };
  }

  if (role === 'unbound') return { role, bound: false, readOnly: true, takeoverCommitted: false, provenance };
  throw new BootstrapError('unsupported session role');
}

export function resolveProjectAdoption({
  projectAnchor,
  controlLocator,
  projectControlObservations = [],
  sessionRoleBinding = null,
  adoptionAuthorization = null,
  ...bootstrapInput
} = {}) {
  const locator = normalizeLocator(controlLocator);
  const kernelSchemaMajor = bootstrapInput.kernelManifest?.kernelSchemaVersion ?? null;
  const projectProfile = projectProfileFromAnchor({
    ...projectAnchor,
    controlRoot: { kind: 'project_control_locator', pointer: locator.key },
  }, { kernelSchemaMajor });

  const discovered = discoverControl(projectProfile.projectKey, locator, projectControlObservations);
  const adoption = normalizeAdoptionAuthorization(adoptionAuthorization, {
    projectKey: projectProfile.projectKey,
    locator,
    hasControl: Boolean(discovered),
  });

  const genesisAuthorization = adoption.mode === 'NEW_GENESIS'
    ? {
        status: 'authorized',
        projectKey: projectProfile.projectKey,
        controlRootPointer: locator.key,
        grantedBy: 'HUMAN_PRINCIPAL',
        permittedAction: 'CREATE_MINIMAL_PROJECT_CONTROL',
        charter: adoption.charter,
      }
    : null;

  const bootstrap = resolveBootstrap({
    ...bootstrapInput,
    projectProfile,
    projectControl: discovered?.control || null,
    genesisAuthorization,
  });

  const normalizedAdoption = {
    ...adoption,
    ...(discovered?.resolvedControlPointer
      ? { resolvedControlPointer: discovered.resolvedControlPointer }
      : {}),
  };

  if (adoption.mode === 'MATERIALIZE_CONTROL') {
    bootstrap.genesis = { required: false, authorized: false, reason: 'existing_project_materialization' };
    bootstrap.missionDiscovery = { mode: 'CONTROL_MATERIALIZATION_REQUIRED' };
  } else if (adoption.mode === 'UNBOUND_NO_CONTROL') {
    bootstrap.genesis = { required: false, authorized: false, reason: 'adoption_authorization_required' };
    bootstrap.missionDiscovery = { mode: 'UNBOUND_NO_CONTROL' };
  }

  const sessionRole = normalizeSessionRole(sessionRoleBinding, {
    control: bootstrap.control,
    missionDiscovery: bootstrap.missionDiscovery,
    authority: bootstrap.authority,
  });

  return {
    ...bootstrap,
    controlLocator: locator,
    adoption: normalizedAdoption,
    sessionRole,
  };
}
