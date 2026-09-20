import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DESKTOP_COMMANDER_LICENSE,
  DESKTOP_COMMANDER_UPSTREAM_COMMIT,
  DESKTOP_COMMANDER_VERSION,
} from '../../src/local/desktop-commander-child.js';

const pointer = JSON.parse(
  fs.readFileSync(new URL('../../dependency-escrow/desktop-commander-0.2.51.json', import.meta.url), 'utf8'),
);
const packageJson = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
const lockEntry = packageLock.packages['node_modules/@wonderwhy-er/desktop-commander'];

test('DesktopCommander escrow pointer matches the accepted dependency contract', () => {
  assert.equal(pointer.contractVersion, 1);
  assert.equal(pointer.purpose, 'dependency-escrow');
  assert.equal(pointer.release.repository, 'SIMON-WORLD/chatgpt-codex-orchestrator');
  assert.equal(pointer.release.tag, 'dependency-escrow-desktop-commander-0.2.51');
  assert.equal(pointer.release.prerelease, true);
  assert.equal(pointer.release.latest, false);

  assert.equal(pointer.package.name, '@wonderwhy-er/desktop-commander');
  assert.equal(pointer.package.version, DESKTOP_COMMANDER_VERSION);
  assert.equal(packageJson.dependencies[pointer.package.name], DESKTOP_COMMANDER_VERSION);
  assert.equal(lockEntry.version, DESKTOP_COMMANDER_VERSION);
  assert.equal(lockEntry.integrity, pointer.package.integrity);
  assert.equal(
    lockEntry.resolved,
    'https://registry.npmjs.org/@wonderwhy-er/desktop-commander/-/desktop-commander-0.2.51.tgz',
  );

  assert.equal(pointer.source.commit, DESKTOP_COMMANDER_UPSTREAM_COMMIT);
  assert.equal(pointer.source.tree, '81ea98e8f789e18e2daaaa7c6e1b01552792f413');
  assert.equal(pointer.license.spdx, DESKTOP_COMMANDER_LICENSE);

  assert.match(pointer.package.sha256, /^[a-f0-9]{64}$/u);
  assert.match(pointer.source.sha256, /^[a-f0-9]{64}$/u);
  assert.match(pointer.license.sha256, /^[a-f0-9]{64}$/u);
  assert.match(pointer.release.manifestSha256, /^[a-f0-9]{64}$/u);
});

test('escrow pointer names only the bounded four-asset recovery contract', () => {
  assert.equal(pointer.package.artifact, 'wonderwhy-er-desktop-commander-0.2.51.tgz');
  assert.equal(
    pointer.source.archive,
    'DesktopCommanderMCP-092ce0b841e86455f12e41f4dc36399a7522ecb5.tar.gz',
  );
  assert.equal(pointer.release.manifestAsset, 'desktop-commander-0.2.51-escrow-manifest.json');
  assert.equal(pointer.license.asset, 'DesktopCommanderMCP-0.2.51-LICENSE');
});
