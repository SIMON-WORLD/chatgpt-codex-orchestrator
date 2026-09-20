import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pointerPath = path.join(repoRoot, 'dependency-escrow', 'desktop-commander-0.2.51.json');

function fail(message) {
  throw new Error(`desktop commander escrow recovery: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, '');
  return JSON.parse(text);
}

function digest(file, algorithm) {
  const hash = crypto.createHash(algorithm);
  hash.update(fs.readFileSync(file));
  return hash.digest();
}

function sha256(file) {
  return digest(file, 'sha256').toString('hex');
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    shell: false,
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(-4000);
    fail(`${command} ${args.join(' ')} failed (${result.status})\n${detail}`);
  }
  return result;
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const escrowInput = argValue('--escrow-dir') || process.env.DESKTOP_COMMANDER_ESCROW_DIR;
assert(escrowInput, 'provide --escrow-dir with downloaded release assets');
const escrowDir = path.resolve(escrowInput);
assert(fs.existsSync(escrowDir), 'escrow directory does not exist');

const pointer = readJson(pointerPath);
const manifestPath = path.join(escrowDir, pointer.release.manifestAsset);
assert(fs.existsSync(manifestPath), 'release manifest asset is missing');
assert(fs.statSync(manifestPath).size === pointer.release.manifestBytes, 'release manifest byte size mismatch');
assert(sha256(manifestPath) === pointer.release.manifestSha256, 'release manifest digest mismatch');

const manifest = readJson(manifestPath);
assert(manifest.contractVersion === pointer.contractVersion, 'manifest contract version mismatch');
assert(manifest.purpose === 'dependency-escrow', 'manifest purpose mismatch');
assert(manifest.package.name === pointer.package.name, 'package name mismatch');
assert(manifest.package.version === pointer.package.version, 'package version mismatch');
assert(manifest.source.commit === pointer.source.commit, 'source commit mismatch');
assert(manifest.source.tree === pointer.source.tree, 'source tree mismatch');
assert(manifest.license.spdx === pointer.license.spdx, 'license mismatch');
function verifyAsset(spec, label) {
  const file = path.join(escrowDir, spec.artifact || spec.archive || spec.asset);
  assert(fs.existsSync(file), `${label} asset is missing`);
  assert(fs.statSync(file).size === spec.bytes, `${label} byte size mismatch`);
  assert(sha256(file) === spec.sha256, `${label} digest mismatch`);
  return file;
}

const packageFile = verifyAsset(pointer.package, 'package');
const sourceFile = verifyAsset(pointer.source, 'source');
const licenseFile = verifyAsset(pointer.license, 'license');

const packageSri = `sha512-${digest(packageFile, 'sha512').toString('base64')}`;
assert(packageSri === pointer.package.integrity, 'package npm integrity mismatch');
assert(manifest.package.integrity === pointer.package.integrity, 'manifest npm integrity mismatch');
assert(manifest.package.sha1 === pointer.package.sha1, 'manifest npm shasum mismatch');
assert(manifest.package.sha256 === pointer.package.sha256, 'manifest package digest mismatch');
assert(manifest.source.sha256 === pointer.source.sha256, 'manifest source digest mismatch');
assert(manifest.license.sha256 === pointer.license.sha256, 'manifest license digest mismatch');

const tarList = run('tar', ['-tzf', sourceFile]).stdout.split(/\r?\n/u);
assert(tarList.includes(pointer.license.sourceArchiveEntry), 'source archive does not contain recorded LICENSE');
const licenseText = fs.readFileSync(licenseFile, 'utf8');
assert(/^MIT License\r?$/mu.test(licenseText), 'license asset is not the recorded MIT notice');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-commander-escrow-recovery-'));
const cleanup = () => fs.rmSync(work, { recursive: true, force: true });
try {
  for (const rel of ['src', 'test']) {
    fs.cpSync(path.join(repoRoot, rel), path.join(work, rel), { recursive: true });
  }
  const originalPackage = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
  const originalLock = fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8');
  fs.writeFileSync(path.join(work, 'package.json'), originalPackage);
  fs.writeFileSync(path.join(work, 'package-lock.json'), originalLock);

  const installPackage = JSON.parse(originalPackage);
  const localSpec = `file:${packageFile.replace(/\\/gu, '/')}`;
  installPackage.dependencies[pointer.package.name] = localSpec;
  fs.writeFileSync(path.join(work, 'package.json'), `${JSON.stringify(installPackage, null, 2)}\n`);
  fs.rmSync(path.join(work, 'package-lock.json'));

  const installEnv = {
    ...process.env,
    DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
  if (process.platform === 'win32') {
    run(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', 'npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: work, env: installEnv },
    );
  } else {
    run(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: work, env: installEnv },
    );
  }

  const recoveredLock = readJson(path.join(work, 'package-lock.json'));
  const rootSpec = recoveredLock.packages?.['']?.dependencies?.[pointer.package.name];
  const recoveredEntry = recoveredLock.packages?.[`node_modules/${pointer.package.name}`];
  assert(rootSpec === localSpec, 'recovery install did not use the escrow file spec');
  assert(recoveredEntry?.version === pointer.package.version, 'recovered package version mismatch');
  assert(
    !JSON.stringify(recoveredLock).includes('registry.npmjs.org/@wonderwhy-er/desktop-commander'),
    'recovery lock referenced the live DesktopCommander npm tarball',
  );

  fs.writeFileSync(path.join(work, 'package.json'), originalPackage);
  fs.writeFileSync(path.join(work, 'package-lock.json'), originalLock);

  const installed = readJson(path.join(work, 'node_modules', '@wonderwhy-er', 'desktop-commander', 'package.json'));
  assert(installed.name === pointer.package.name, 'installed package name mismatch');
  assert(installed.version === pointer.package.version, 'installed package version mismatch');
  assert(installed.license === pointer.license.spdx, 'installed package license mismatch');

  const testResult = run(
    process.execPath,
    ['--test', 'test/local/desktop-commander-child.test.js'],
    { cwd: work, env: installEnv },
  );

  process.stdout.write(testResult.stdout || '');
  console.log(JSON.stringify({
    status: 'DESKTOPCOMMANDER_ESCROW_COLD_RECOVERY_PROOF_OK',
    releaseTag: pointer.release.tag,
    packageSha256: pointer.package.sha256,
    sourceSha256: pointer.source.sha256,
    semanticTest: 'test/local/desktop-commander-child.test.js',
    hostedRemoteDesktopCommander: false,
  }));
} finally {
  cleanup();
}
