// chatgpt-codex-orchestrator: narrow bounded worktree bootstrap (Issue #29).
// ONE primitive conceptually equivalent to worktree_create(repo, targetPath, branch,
// startPoint): strict trust-root containment -> `git worktree add` -> exact canonical
// created path. This exists ONLY to close the recurring sibling-worktree bootstrap gap
// before `workspace_open`. It is deliberately NOT a generic shell / repo manager / pool
// scheduler / GC. Fail closed when the target already exists, the branch/ref state is
// ambiguous, the repo is not explicitly trusted, or the target would escape the
// dedicated worktree trust pool.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class WorktreeError extends Error {
  constructor(message, code = 'worktree_error') {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
  }
}

function isWithin(root, target) {
  const norm = (p) => path.resolve(p);
  const r = norm(root);
  const t = norm(target);
  if (t === r) return true;
  return t.startsWith(r + path.sep);
}

function isWithinCI(root, target) {
  const norm = (p) => path.resolve(p);
  const r = process.platform === 'win32' ? norm(root).toLowerCase() : norm(root);
  const t = process.platform === 'win32' ? norm(target).toLowerCase() : norm(target);
  if (t === r) return true;
  return t.startsWith(r + (process.platform === 'win32' ? path.sep.toLowerCase() : path.sep));
}

function eqRoots(a, b) {
  if (!a || !b) return false;
  const x = path.resolve(String(a).replace(/[\\/]+$/, ''));
  const y = path.resolve(String(b).replace(/[\\/]+$/, ''));
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function realpathOrNull(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

function detectGitRepo(root) {
  try { return fs.existsSync(path.join(root, '.git')); } catch { return false; }
}

function nearestExistingCanonicalParent(target) {
  let dir = path.dirname(target);
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return realpathOrNull(dir);
}

function runGit(repo, args) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('close', (code) => resolve({ code: code === null ? -1 : code, stdout: out, stderr: err }));
    child.on('error', (e) => resolve({ code: -1, stdout: out, stderr: String(e && e.message || e) }));
  });
}

// Conservative local guard before delegating to git: the branch token must be a single
// argv element that cannot be parsed as an option and cannot smuggle traversal/control.
function validateBranchToken(branch) {
  if (typeof branch !== 'string' || branch.trim() === '') throw new WorktreeError('worktree_create requires a non-empty branch', 'bad_request');
  if (/[\s~^:?*[\]\\@{}]/.test(branch)) throw new WorktreeError(`unsafe branch name: ${JSON.stringify(branch)}`, 'invalid_branch');
  if (branch.startsWith('-')) throw new WorktreeError(`unsafe branch name (option-like): ${JSON.stringify(branch)}`, 'invalid_branch');
  if (branch.includes('..')) throw new WorktreeError(`unsafe branch name (contains '..'): ${JSON.stringify(branch)}`, 'invalid_branch');
  if (branch.toUpperCase() === 'HEAD') throw new WorktreeError(`unsafe branch name: HEAD`, 'invalid_branch');
  if (/[.]$/.test(branch) || branch.endsWith('.lock')) throw new WorktreeError(`unsafe branch name (trailing dot / .lock): ${JSON.stringify(branch)}`, 'invalid_branch');
}

function validateStartPointToken(startPoint) {
  if (typeof startPoint !== 'string' || startPoint.trim() === '') throw new WorktreeError('worktree_create requires a non-empty startPoint', 'bad_request');
  if (startPoint.startsWith('-') || /[\s]/.test(startPoint)) throw new WorktreeError(`unsafe startPoint: ${JSON.stringify(startPoint)}`, 'invalid_start_point');
}

export class WorktreeService {
  constructor({ poolRoot = null, trustedRepos = [] } = {}) {
    this.poolRoot = poolRoot ? path.resolve(String(poolRoot)) : null;
    this.trustedRepos = (Array.isArray(trustedRepos) ? trustedRepos : [])
      .filter((r) => r)
      .map((r) => path.resolve(String(r)));
  }

  get configured() { return !!this.poolRoot && this.trustedRepos.length > 0; }

  _canonicalPool() {
    if (!this.poolRoot) throw new WorktreeError('worktree_create requires a configured worktree trust pool', 'not_configured');
    const real = realpathOrNull(this.poolRoot);
    if (!real || !fs.statSync(real).isDirectory()) throw new WorktreeError(`worktree trust pool is not an existing directory: ${this.poolRoot}`, 'invalid_pool');
    return real;
  }

  _assertTrustedRepo(repoPath) {
    if (typeof repoPath !== 'string' || repoPath.trim() === '') throw new WorktreeError('worktree_create requires a repo', 'bad_request');
    const canonical = realpathOrNull(path.resolve(repoPath));
    if (!canonical || !fs.statSync(canonical).isDirectory()) throw new WorktreeError(`repo is not an existing directory: ${repoPath}`, 'untrusted_repo');
    const trusted = this.trustedRepos.some((r) => {
      const rc = realpathOrNull(r) || r;
      return eqRoots(rc, canonical);
    });
    if (!trusted) throw new WorktreeError(`repo is not explicitly trusted for worktree bootstrap: ${canonical}`, 'untrusted_repo');
    if (!detectGitRepo(canonical)) throw new WorktreeError(`repo is not a git repository: ${canonical}`, 'untrusted_repo');
    return canonical;
  }

  async create({ repo = null, targetPath = null, branch = null, startPoint = null } = {}) {
    if (!this.configured) throw new WorktreeError('worktree_create is not configured (poolRoot + trustedRepos required)', 'not_configured');
    const poolRoot = this._canonicalPool();
    const repoRoot = this._assertTrustedRepo(repo);

    if (typeof targetPath !== 'string' || targetPath.trim() === '') throw new WorktreeError('worktree_create requires a targetPath', 'bad_request');
    // Anchor the requested target onto the CANONICAL pool root (realpath) so Windows
    // 8.3/short-name vs long-name path representations cannot defeat containment.
    const rawRequested = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(poolRoot, targetPath);
    const rel = path.relative(poolRoot, rawRequested);
    if (rel === '' || rel === '.' || path.isAbsolute(rel) || rel.split(path.sep).includes('..')) {
      throw new WorktreeError(`worktree target escapes the dedicated trust pool: ${rawRequested}`, 'pool_escape');
    }
    const requested = path.join(poolRoot, rel);
    const parentCanonical = nearestExistingCanonicalParent(requested);
    if (!parentCanonical || !isWithinCI(poolRoot, parentCanonical)) {
      throw new WorktreeError(`worktree target would escape the dedicated trust pool via its parent: ${requested}`, 'pool_escape');
    }
    if (fs.existsSync(requested)) throw new WorktreeError(`worktree target already exists: ${requested}`, 'target_exists');

    validateBranchToken(branch);
    validateStartPointToken(startPoint);

    const refFormat = await runGit(repoRoot, ['check-ref-format', `refs/heads/${branch}`]);
    if (refFormat.code !== 0) throw new WorktreeError(`invalid branch name: ${branch}`, 'invalid_branch');
    const existingBranch = await runGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (existingBranch.code === 0) throw new WorktreeError(`branch already exists (ref state ambiguous): ${branch}`, 'branch_exists');

    const resolved = await runGit(repoRoot, ['rev-parse', '--verify', `${startPoint}^{commit}`]);
    if (resolved.code !== 0 || !resolved.stdout.trim()) {
      throw new WorktreeError(`startPoint does not resolve to a commit in the trusted repo: ${startPoint}`, 'invalid_start_point');
    }

    const added = await runGit(repoRoot, ['worktree', 'add', '-b', branch, requested, startPoint]);
    if (added.code !== 0) {
      throw new WorktreeError(`git worktree add failed for ${requested}: ${(added.stderr || added.stdout || '').trim().slice(0, 400)}`, 'worktree_add_failed');
    }
    const canonicalCreated = realpathOrNull(requested);
    if (!canonicalCreated || !isWithinCI(poolRoot, canonicalCreated)) {
      throw new WorktreeError(`created worktree path could not be verified inside the trust pool: ${requested}`, 'pool_escape');
    }
    return { path: canonicalCreated, branch, startPoint, repo: repoRoot, poolRoot };
  }
}

export function createWorktreeService(opts) { return new WorktreeService(opts); }
