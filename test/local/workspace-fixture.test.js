import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { WorkspaceRegistry, WorkspaceError } from '../../src/local/workspace.js';
import { readOnlySmokeFixtureContract } from '../../src/local/read-only-smoke.js';

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-fixture-'));
  const repo = path.join(root, 'fixture-repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'smoke.txt'), 'fixture marker\n', 'utf8');
  return { root, repo };
}

test('workspace_open can bind the configured read_only_smoke fixture without caller filesystem discovery', () => {
  const { root, repo } = makeFixture();
  const reg = new WorkspaceRegistry({
    allowedRoots: [root],
    fixtures: {
      read_only_smoke: {
        path: repo,
        contract: readOnlySmokeFixtureContract(),
      },
    },
  });

  const out = reg.open({ fixture: 'read_only_smoke' });
  assert.ok(out.workspaceId);
  assert.equal(out.isGitRepo, true);
  assert.equal(out.fixture, 'read_only_smoke');
  assert.equal(out.root, fs.realpathSync.native(repo));
  assert.deepEqual(out.fixtureContract, readOnlySmokeFixtureContract());
});

test('configured fixture does not widen containment outside allowedRoots', () => {
  const { root } = makeFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-fixture-outside-'));
  const reg = new WorkspaceRegistry({
    allowedRoots: [root],
    fixtures: { read_only_smoke: outside },
  });

  assert.throws(
    () => reg.open({ fixture: 'read_only_smoke' }),
    (err) => err instanceof WorkspaceError && /not within configured allowed roots/.test(err.message),
  );
});

test('workspace_open fixture alias fails closed when not configured', () => {
  const { root } = makeFixture();
  const reg = new WorkspaceRegistry({ allowedRoots: [root] });
  assert.throws(
    () => reg.open({ fixture: 'read_only_smoke' }),
    (err) => err instanceof WorkspaceError && /fixture.*not configured/i.test(err.message),
  );
});
