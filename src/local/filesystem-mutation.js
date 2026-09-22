import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceError } from './workspace.js';
import { isBlockedMutationPath } from './sensitive.js';

function isWithin(root, target) {
  let rootPath = path.resolve(root);
  let targetPath = path.resolve(target);
  if (process.platform === 'win32') {
    rootPath = rootPath.toLowerCase();
    targetPath = targetPath.toLowerCase();
  }
  if (targetPath === rootPath) return true;
  const prefix = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
  return targetPath.startsWith(prefix);
}

function samePath(left, right) {
  let a = path.resolve(left);
  let b = path.resolve(right);
  if (process.platform === 'win32') {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  return a === b;
}

function hasTraversalComponent(value) {
  return String(value).replace(/\\/g, '/').split('/').some((part) => part === '..' || part === '.');
}

function requireRelativePath(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkspaceError(`${label} must be a non-empty relative path`);
  }
  const requested = value.trim();
  if (requested.includes('\0') || path.isAbsolute(requested) || path.win32.isAbsolute(requested) || /^[A-Za-z]:/.test(requested)) {
    throw new WorkspaceError(`${label} must be a non-empty relative path`);
  }
  if (hasTraversalComponent(requested)) {
    throw new WorkspaceError(`${label} traversal components are not allowed`);
  }
  return requested;
}

function canonicalWorkspaceRoot(workspace) {
  if (!workspace || typeof workspace.root !== 'string' || workspace.root.trim() === '') {
    throw new WorkspaceError('workspace has no primary root');
  }
  let root;
  try {
    root = fs.realpathSync(workspace.root);
    if (!fs.statSync(root).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new WorkspaceError('workspace primary root is not an existing directory');
  }
  return root;
}

function lstatOrNull(target, label) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw new WorkspaceError(`${label} could not be inspected`);
  }
}

// Walk only the caller-selected primary path. Existing symlinks and junctions
// are rejected even when they point back inside the workspace: mutation must
// have one exact physical destination, not an alias that can be retargeted.
function inspectPathChain(root, target, label) {
  assertInside(root, target, label);
  const relative = path.relative(root, target);
  const parts = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = root;
  let nearestExisting = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = lstatOrNull(current, label);
    if (!stat) return { exists: false, stat: null, nearestExisting };
    if (stat.isSymbolicLink()) throw new WorkspaceError(`${label} symlink/junction is not allowed`);
    const canonical = realpathOrThrow(current, label);
    if (!samePath(current, canonical)) throw new WorkspaceError(`${label} symlink/junction is not allowed`);
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new WorkspaceError(`${label} parent is not a directory`);
    }
    nearestExisting = current;
  }
  const stat = lstatOrNull(target, label);
  return { exists: !!stat, stat, nearestExisting };
}

function statOrThrow(target, label) {
  try {
    return fs.statSync(target);
  } catch {
    throw new WorkspaceError(`${label} does not exist or could not be inspected`);
  }
}

function realpathOrThrow(target, label) {
  try {
    return fs.realpathSync(target);
  } catch {
    throw new WorkspaceError(`${label} could not be canonicalized`);
  }
}

function relativePath(root, target) {
  return path.relative(root, target) || '.';
}

function assertInside(root, target, label) {
  if (!isWithin(root, target)) throw new WorkspaceError(`${label} escapes the primary workspace`);
}

function assertMutationPolicy(root, requested, effective, label) {
  const requestedNormalized = relativePath(root, path.resolve(root, requested));
  const effectiveRelative = relativePath(root, effective);
  if (isBlockedMutationPath(requested)
      || isBlockedMutationPath(requestedNormalized)
      || isBlockedMutationPath(effectiveRelative)) {
    throw new WorkspaceError(`${label} blocked by the mutation path policy`);
  }
}

function broadType(stat) {
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  return null;
}

export class FilesystemMutationService {
  constructor({ workspaceRegistry, mutationOwner, desktopCommanderChild } = {}) {
    this.registry = workspaceRegistry;
    this.owner = mutationOwner;
    this.child = desktopCommanderChild;
  }

  _requireDependencies(childMethod) {
    if (!this.registry || typeof this.registry.get !== 'function') {
      throw new WorkspaceError('workspace registry is required for filesystem mutation');
    }
    if (!this.owner
        || typeof this.owner.acquire !== 'function'
        || typeof this.owner.markUnitState !== 'function'
        || typeof this.owner.release !== 'function') {
      throw new WorkspaceError('shared mutation owner is required for filesystem mutation');
    }
    if (!this.child || typeof this.child[childMethod] !== 'function') {
      throw new WorkspaceError('desktop commander child adapter is required for filesystem mutation');
    }
  }

  _workspaceRoot(workspaceId) {
    const workspace = this.registry.get(workspaceId);
    return { workspace, root: canonicalWorkspaceRoot(workspace) };
  }

  _resolvePrimary(root, requested, label) {
    const absolute = path.resolve(root, requested);
    assertInside(root, absolute, label);
    return absolute;
  }

  _inspectPrimary(root, absolute, label) {
    return inspectPathChain(root, absolute, label);
  }

  _finishFailure({ acquired, dispatchAttempted }) {
    if (!acquired) return;
    if (dispatchAttempted) {
      try { this.owner.markUnitState('unknown'); } catch {}
      return;
    }
    try { this.owner.markUnitState('reconciled'); } catch {}
    try { this.owner.release(); } catch {}
  }

  async createDirectory({ workspaceId, path: requestedPath } = {}) {
    this._requireDependencies('createDirectory');
    const { root } = this._workspaceRoot(workspaceId);
    const requested = requireRelativePath(requestedPath, 'path');
    const absolute = this._resolvePrimary(root, requested, 'path');
    assertMutationPolicy(root, requested, absolute, 'path');

    const target = this._inspectPrimary(root, absolute, 'create target');
    if (target.exists) {
      throw new WorkspaceError(`create target already exists: ${requested}`);
    }
    const parent = path.dirname(absolute);
    const parentChain = this._inspectPrimary(root, parent, 'create target parent');
    const parentStat = parentChain.stat;
    if (parentChain.exists && !parentStat.isDirectory()) {
      throw new WorkspaceError(`create target parent is not a directory: ${requested}`);
    }
    const nearestStat = fs.statSync(parentChain.nearestExisting);
    if (!nearestStat.isDirectory()) {
      throw new WorkspaceError(`create target parent is not a directory: ${requested}`);
    }
    const parentCanonical = realpathOrThrow(parentChain.nearestExisting, 'create target parent');
    assertInside(root, parentCanonical, 'create target parent');
    const effective = path.join(parentCanonical, path.relative(parentChain.nearestExisting, absolute));
    assertInside(root, effective, 'create target');
    assertMutationPolicy(root, requested, effective, 'path');

    let acquired = false;
    let dispatchAttempted = false;
    try {
      this.owner.acquire('chatgpt', crypto.randomUUID());
      acquired = true;
      dispatchAttempted = true;
      await this.child.createDirectory({ path: absolute });

      const created = this._inspectPrimary(root, absolute, 'created directory');
      if (!created.exists || !created.stat.isDirectory()) throw new WorkspaceError('created target is not a directory');
      const targetCanonical = realpathOrThrow(absolute, 'created directory');
      assertInside(root, targetCanonical, 'created directory');
      if (!samePath(targetCanonical, absolute)) throw new WorkspaceError('created directory resolved through a symlink/junction');
      assertMutationPolicy(root, requested, targetCanonical, 'path');

      this.owner.markUnitState('reconciled');
      this.owner.release();
      return { operation: 'create_directory', path: requested, status: 'applied' };
    } catch (error) {
      this._finishFailure({ acquired, dispatchAttempted });
      throw error;
    }
  }

  async movePath({ workspaceId, source: requestedSource, destination: requestedDestination } = {}) {
    this._requireDependencies('moveFile');
    const { root } = this._workspaceRoot(workspaceId);
    const source = requireRelativePath(requestedSource, 'source');
    const destination = requireRelativePath(requestedDestination, 'destination');
    const absoluteSource = this._resolvePrimary(root, source, 'source');
    const absoluteDestination = this._resolvePrimary(root, destination, 'destination');
    assertMutationPolicy(root, source, absoluteSource, 'source');
    assertMutationPolicy(root, destination, absoluteDestination, 'destination');

    const sourceChain = this._inspectPrimary(root, absoluteSource, 'move source');
    if (!sourceChain.exists) throw new WorkspaceError(`move source does not exist: ${source}`);
    const sourceStat = sourceChain.stat;
    const sourceType = broadType(sourceStat);
    if (!sourceType) throw new WorkspaceError(`move source must be a regular file or directory: ${source}`);
    const sourceCanonical = realpathOrThrow(absoluteSource, 'move source');
    assertInside(root, sourceCanonical, 'move source');
    if (!samePath(sourceCanonical, absoluteSource)) throw new WorkspaceError('move source resolved through a symlink/junction');
    assertMutationPolicy(root, source, sourceCanonical, 'source');
    if (samePath(sourceCanonical, root)) throw new WorkspaceError('moving the primary workspace root is not allowed');

    const destinationChain = this._inspectPrimary(root, absoluteDestination, 'move destination');
    if (destinationChain.exists) {
      throw new WorkspaceError(`move destination already exists: ${destination}`);
    }
    const destinationParent = path.dirname(absoluteDestination);
    const destinationParentChain = this._inspectPrimary(root, destinationParent, 'move destination parent');
    if (!destinationParentChain.exists) throw new WorkspaceError(`move destination parent does not exist: ${destination}`);
    const destinationParentStat = destinationParentChain.stat;
    if (!destinationParentStat.isDirectory()) {
      throw new WorkspaceError(`move destination parent is not a directory: ${destination}`);
    }
    const destinationParentCanonical = realpathOrThrow(destinationParent, 'move destination parent');
    assertInside(root, destinationParentCanonical, 'move destination parent');
    if (!samePath(destinationParentCanonical, destinationParent)) throw new WorkspaceError('move destination parent resolved through a symlink/junction');
    const effectiveDestination = path.join(destinationParentCanonical, path.basename(absoluteDestination));
    assertInside(root, effectiveDestination, 'move destination');
    assertMutationPolicy(root, destination, effectiveDestination, 'destination');
    if (sourceType === 'directory' && isWithin(sourceCanonical, effectiveDestination)) {
      throw new WorkspaceError('moving a directory into itself or a descendant is not allowed');
    }

    let acquired = false;
    let dispatchAttempted = false;
    try {
      this.owner.acquire('chatgpt', crypto.randomUUID());
      acquired = true;
      dispatchAttempted = true;
      await this.child.moveFile({ source: absoluteSource, destination: absoluteDestination });

      if (this._inspectPrimary(root, absoluteSource, 'moved source').exists) {
        throw new WorkspaceError('move source still exists after dispatch');
      }
      const moved = this._inspectPrimary(root, absoluteDestination, 'moved destination');
      if (!moved.exists) throw new WorkspaceError('moved destination does not exist after dispatch');
      const destinationStat = moved.stat;
      if (broadType(destinationStat) !== sourceType) {
        throw new WorkspaceError('move destination type does not match the source');
      }
      const destinationCanonical = realpathOrThrow(absoluteDestination, 'moved destination');
      assertInside(root, destinationCanonical, 'moved destination');
      if (!samePath(destinationCanonical, absoluteDestination)) throw new WorkspaceError('moved destination resolved through a symlink/junction');
      assertMutationPolicy(root, destination, destinationCanonical, 'destination');

      this.owner.markUnitState('reconciled');
      this.owner.release();
      return {
        operation: 'move_path',
        source,
        destination,
        status: 'applied',
      };
    } catch (error) {
      this._finishFailure({ acquired, dispatchAttempted });
      throw error;
    }
  }
}
