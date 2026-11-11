import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isRelayAdmissionContext } from './agent.js';

export const ADMITTED_CODEX_METHOD = 'codex/admitted-turn/v1';
const stable = z.string().min(1).max(256).refine((s) => s.trim().length > 0);
const body = z.string().min(1).max(120000);
const access = z.enum(['read_only', 'workspace_write']);
const workspaceTask = { workspaceId: stable, taskId: stable };
const operations = {
  codex_start: z.object({ ...workspaceTask, identity: stable, stepId: stable.optional(),
    prompt: body, accessMode: access, networkAccess: z.boolean().default(false) }).strict(),
  codex_continue: z.object({ ...workspaceTask, jobId: stable, stepId: stable, instruction: body }).strict(),
};
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const real = (p) => fs.realpathSync.native(p);
const sameRoot = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function denied() { throw new Error('Relay Codex admission denied'); }

function gitBinding(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  const git = (...args) => execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, env, timeout: 3000, stdio: ['ignore','pipe','pipe'],
  }).trim();
  if (!sameRoot(real(git('rev-parse', '--show-toplevel')), root)) denied();
  const remote = git('config', '--local', '--get-all', 'remote.origin.url');
  const project = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(remote)?.[1]?.toLowerCase();
  if (!project) denied();
  return [project, real(git('rev-parse', '--absolute-git-dir')), git('symbolic-ref', 'HEAD'), git('rev-parse', '--verify', 'HEAD')];
}

function transportDigest(context) {
  if (!isRelayAdmissionContext(context) || !context.isCurrent()) denied();
  return hash([context.deviceId, context.runtimeId, context.connectionEpoch, context.pairingFingerprint]);
}

// The private parent transport is injected only by an independently trusted
// in-process adapter. No Local MCP/Relay tool can register an issuer or supply
// the adapter's authenticated caller context. Production has no adapter today.
export function createRelayCodexAdmission({ governance, registry, executor, currentContext, privateParentTransport = null }) {
  const childIds = new WeakMap();
  function initialChild() {
    if (!executor.client.isRunning) return null;
    if (!executor.client.child || executor.client._connected !== true) denied();
    return executor.client.child;
  }
  function scopeFor(name, args, context, governanceStep = null, pendingUnit = null, child = initialChild()) {
    const transport = transportDigest(context);
    if (transportDigest(currentContext()) !== transport) denied();
    if (child && !childIds.has(child)) childIds.set(child, randomUUID());
    const contextDigest = hash([transport, child ? childIds.get(child) : null]);
    const workspace = registry.get(args.workspaceId);
    const root = real(workspace.root);
    if (!sameRoot(root, path.resolve(workspace.root))) denied();
    const repo = gitBinding(root);
    let key, operation;
    if (name === 'codex_start') {
      key = hash(['start', args.identity]);
      operation = [args.identity, args.stepId ?? null, args.prompt, args.accessMode, args.networkAccess];
    } else {
      const job = executor.load(args.jobId);
      if (!job?.workspaceRoot || !sameRoot(real(job.workspaceRoot), root) ||
          job.taskId !== args.taskId || !job.threadId || !job.turnId ||
          (pendingUnit ? !(job.state === 'starting' && job.mutationUnitId === pendingUnit && job.turnStartDispatched === false) :
            !['completed','failed','interrupted'].includes(job.state)) || !access.safeParse(job.accessMode).success) denied();
      key = hash(['continue', args.jobId, args.stepId]);
      operation = [args.jobId, job.threadId, job.turnId, args.stepId, args.instruction, job.accessMode, job.networkAccess === true];
    }
    return { taskId: args.taskId, workspaceRoot: root, projectKey: repo[0], governanceStep, key, contextDigest,
      operationDigest: hash([1, name, root, repo, args.taskId, operation]) };
  }

  if (privateParentTransport !== null) {
    const authorize = (caller) => {
      if (privateParentTransport.authenticate(caller) !== true) denied();
      if (!executor.owner.isNone()) denied();
    };
    privateParentTransport.register(Object.freeze({
      issue(caller, { name, operation, governanceStep, authorityToken }) {
        authorize(caller);
        if (!Object.hasOwn(operations, name)) denied();
        const args = operations[name].parse(operation);
        return governance.issueRelayCodexAdmission(scopeFor(name, args, currentContext(), stable.parse(governanceStep)), authorityToken);
      },
      revoke(caller, { workspaceId, taskId, authorityToken, admission }) {
        if (privateParentTransport.authenticate(caller) !== true) denied();
        transportDigest(currentContext());
        return governance.revokeRelayCodexAdmission({ taskId: stable.parse(taskId),
          workspaceRoot: real(registry.get(stable.parse(workspaceId)).root), admission: opaque.parse(admission) }, authorityToken);
      },
    }));
  }

  return async (payload, context) => {
    if (payload?.method !== ADMITTED_CODEX_METHOD || !Object.hasOwn(operations, payload.params?.name ?? '') ||
        !privateParentTransport || !executor.owner.isNone()) denied();
    const { name, arguments: supplied } = payload.params;
    const { admission, ...raw } = supplied ?? {};
    const args = operations[name].parse(raw);
    const child = initialChild();
    const scope = scopeFor(name, args, context, null, null, child);
    const permit = governance.reserveRelayCodexAdmission(scope, opaque.parse(admission));
    const check = (pendingUnit = null) => {
      if (child && initialChild() !== child) denied();
      const current = scopeFor(name, args, context, null, pendingUnit, child);
      if (current.operationDigest !== scope.operationDigest || current.contextDigest !== scope.contextDigest) denied();
      permit.checkReserved();
    };
    const guard = Object.freeze({
      check,
      commitDispatch: ({ mutationUnitId, isWriter }) => {
        if (isWriter ? (executor.owner.owner !== 'codex' || executor.owner.unitId !== mutationUnitId ||
            executor.owner.unitState !== 'running') : !executor.owner.isNone()) denied();
        check(mutationUnitId);
        permit.commitDispatch();
      },
      assertDispatched: () => {
        if (transportDigest(context) !== transportDigest(currentContext())) denied();
        permit.checkDispatched();
      },
    });
    const value = name === 'codex_start'
      ? await executor.start({ ...args, cwd: scope.workspaceRoot, workspaceRoot: scope.workspaceRoot, relayAdmission: guard })
      : await executor.continue({ ...args, relayAdmission: guard });
    permit.acknowledge();
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
  };
}
