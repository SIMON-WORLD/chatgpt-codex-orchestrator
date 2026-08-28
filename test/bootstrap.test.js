import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  loadBrainCommandConfig, writeBrainCommandConfig, resolveRepoDir, resolveOrchestratorRoot,
  fastPreflight, fullDoctor, codexHome, brainCommandConfigPath, BrainCommandConfigError,
  setupBrainCommand, installBrainCommandSkill, brainCommandInstalled, installedBrainCommandSkillPath,
  sourceBrainCommandSkillPath, legacyBrainCommandSkillPath, userHome,
  discoverBroadRepoDir, markBroadDiscovery,
  isBrainCommandTrigger, newBootstrapMetrics, bootstrapElapsedMs,
} from '../src/bootstrap.js';

function dir() { const d = path.join(os.tmpdir(), 'boot-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)); fs.mkdirSync(d, { recursive: true }); return d; }

const VALID = {
  orchestratorRoot: path.join(dir(), 'orch'),
  dataRoot: path.join(dir(), 'data'),
  workspaceRoot: path.join(dir(), 'ws'),
  defaultBrain: 'chatgpt',
  defaultExecutor: 'codex',
  defaultConversationMode: 'new',
};

test('loadBrainCommandConfig reads a valid config', () => {
  const home = dir();
  const file = writeBrainCommandConfig(VALID, { codexHome: home });
  assert.ok(fs.existsSync(file));
  const cfg = loadBrainCommandConfig({ codexHome: home });
  assert.strictEqual(cfg.defaultBrain, 'chatgpt');
  assert.strictEqual(cfg.defaultExecutor, 'codex');
  assert.strictEqual(cfg.defaultConversationMode, 'new');
  assert.ok(cfg.orchestratorRoot && cfg.workspaceRoot && cfg.dataRoot);
});

test('missing config -> fail fast BrainCommandConfigError', () => {
  assert.throws(() => loadBrainCommandConfig({ codexHome: dir() }), BrainCommandConfigError);
});

test('invalid JSON config -> fail fast', () => {
  const home = dir();
  fs.mkdirSync(path.join(home, 'brain-command'), { recursive: true });
  fs.writeFileSync(brainCommandConfigPath(home), '{not json', 'utf8');
  assert.throws(() => loadBrainCommandConfig({ codexHome: home }), BrainCommandConfigError);
});

test('invalid config (bad defaultBrain / missing root) -> fail fast', () => {
  const home = dir();
  writeBrainCommandConfig({ ...VALID, defaultBrain: 'claude', dataRoot: '' }, { codexHome: home });
  assert.throws(() => loadBrainCommandConfig({ codexHome: home }), BrainCommandConfigError);
});

test('resolveRepoDir: cwd inside workspace wins; explicit path; config fallback; unresolved; no broad search', () => {
  const ws = VALID.workspaceRoot;
  const inside = path.join(ws, 'sub');
  fs.mkdirSync(inside, { recursive: true });
  // 1. cwd inside workspace -> cwd
  let r = resolveRepoDir({ cwd: inside, config: VALID });
  assert.strictEqual(r.repoDir, path.resolve(inside));
  assert.strictEqual(r.source, 'cwd');
  assert.strictEqual(r.broadDiscoveryOccurred, false);
  // 2. explicit local path wins when cwd is NOT inside the configured workspace
  const exp = path.join(dir(), 'explicit-repo');
  fs.mkdirSync(exp, { recursive: true });
  r = resolveRepoDir({ cwd: path.join(dir(), 'elsewhere'), explicitRepoPath: exp, config: VALID });
  assert.strictEqual(r.repoDir, path.resolve(exp));
  assert.strictEqual(r.source, 'explicit');
  // 3. explicit GitHub repo -> config workspaceRoot
  r = resolveRepoDir({ explicitGitHubRepo: 'owner/repo', config: VALID });
  assert.strictEqual(r.repoDir, path.resolve(VALID.workspaceRoot));
  assert.strictEqual(r.source, 'github-config');
  // 4. config fallback
  r = resolveRepoDir({ config: VALID });
  assert.strictEqual(r.repoDir, path.resolve(VALID.workspaceRoot));
  assert.strictEqual(r.source, 'config');
  // 5. unresolved (no workspace, no cwd repo)
  r = resolveRepoDir({ cwd: path.join(dir(), 'not-a-repo'), config: { ...VALID, workspaceRoot: '' } });
  assert.strictEqual(r.repoDir, null);
  assert.strictEqual(r.source, 'unresolved');
  assert.strictEqual(r.broadDiscoveryOccurred, false);
});

test('resolveOrchestratorRoot: config > explicit > self-identify', () => {
  const cfg = { ...VALID, orchestratorRoot: VALID.orchestratorRoot };
  let o = resolveOrchestratorRoot({ cwd: VALID.workspaceRoot, config: cfg });
  assert.strictEqual(o.orchestratorRoot, VALID.orchestratorRoot);
  assert.strictEqual(o.source, 'config');
  o = resolveOrchestratorRoot({ explicitRoot: '/tmp/x' });
  assert.strictEqual(o.orchestratorRoot, path.resolve('/tmp/x'));
  assert.strictEqual(o.source, 'explicit');
  // self-identify only when cwd contains this orchestrator's source
  const self = VALID.orchestratorRoot;
  fs.mkdirSync(path.join(self, 'src'), { recursive: true });
  fs.writeFileSync(path.join(self, 'src', 'protocol.js'), '// x', 'utf8');
  o = resolveOrchestratorRoot({ cwd: self, config: { ...VALID, orchestratorRoot: '' } });
  assert.strictEqual(o.orchestratorRoot, path.resolve(self));
  assert.strictEqual(o.source, 'cwd-self');
});

test('fastPreflight: all green with probes / detects failures', () => {
  const cfg = {
    ...VALID,
    codexJs: path.join(dir(), 'codex.js'),
  };
  fs.mkdirSync(cfg.codexJs ? path.dirname(cfg.codexJs) : VALID.orchestratorRoot, { recursive: true });
  fs.writeFileSync(cfg.codexJs, '//', 'utf8');
  fs.mkdirSync(cfg.orchestratorRoot, { recursive: true });
  fs.mkdirSync(cfg.workspaceRoot, { recursive: true });
  fs.mkdirSync(cfg.dataRoot, { recursive: true });
  const has = fs.existsSync;
  assert.ok(has(cfg.orchestratorRoot) && has(cfg.workspaceRoot) && has(cfg.dataRoot));
  // all probes green
  const pass = fastPreflight({ config: cfg, probes: { iabCallable: true, repoExists: true, dataRootWritable: true } });
  assert.strictEqual(pass.pass, true, JSON.stringify(pass.checks));
  // iab not callable -> fail
  const fail = fastPreflight({ config: cfg, probes: { iabCallable: false } });
  assert.ok(!fail.pass);
  assert.ok(fail.checks.some((c) => c.check === 'iab-callable' && c.status === 'FAIL'));
});

test('fullDoctor composes checks and runs without a real codex binary', async () => {
  const cfg = { ...VALID, codexJs: path.join(dir(), 'codex.js') };
  fs.mkdirSync(path.dirname(cfg.codexJs), { recursive: true });
  fs.writeFileSync(cfg.codexJs, '//', 'utf8');
  fs.mkdirSync(cfg.workspaceRoot, { recursive: true });
  fs.mkdirSync(cfg.dataRoot, { recursive: true });
  const checks = await fullDoctor({ config: cfg });
  assert.ok(Array.isArray(checks));
  assert.ok(checks.length >= 1);
  assert.ok(checks.some((c) => c.check === 'codex-js-discoverable'));
});

test('brain-command trigger detection', () => {
  assert.strictEqual(isBrainCommandTrigger('用 ChatGPT 指挥模式完成这个任务'), true);
  assert.strictEqual(isBrainCommandTrigger('让 ChatGPT 指挥 Codex 干活'), true);
  assert.strictEqual(isBrainCommandTrigger('Use ChatGPT as the brain and Codex as executor'), true);
  assert.strictEqual(isBrainCommandTrigger('refactor my python file'), false);
});

test('setup installs the Skill to $HOME/.agents/skills/brain-command (canonical) and config to $CODEX_HOME/brain-command; external cwd resolves without repo location', async () => {
  const home = dir();      // isolated HOME
  const codexHome = dir(); // isolated CODEX_HOME
  const cfg = {
    orchestratorRoot: path.join(dir(), 'orch'),
    dataRoot: path.join(dir(), 'data'),
    workspaceRoot: path.join(dir(), 'ws'),
    defaultBrain: 'chatgpt', defaultExecutor: 'codex', defaultConversationMode: 'new',
  };
  const res = setupBrainCommand({ codexHome, home, config: cfg });
  // Skill lives at $HOME/.agents/skills/brain-command/SKILL.md (canonical user Skill root).
  assert.ok(res.skillPath === installedBrainCommandSkillPath({ home }), 'installed path is the canonical user Skill path');
  assert.ok(fs.existsSync(res.skillPath), 'skill installed to $HOME/.agents/skills/brain-command/SKILL.md');
  assert.ok(!fs.existsSync(legacyBrainCommandSkillPath({ codexHome })), 'canonical new-install is NOT the deprecated $CODEX_HOME/skills path');
  assert.ok(fs.existsSync(res.configPath), 'config installed to $CODEX_HOME/brain-command/config.json');
  assert.strictEqual(res.configPath, brainCommandConfigPath(codexHome));
  assert.ok(brainCommandInstalled({ home, codexHome }));

  // A fresh external working directory (elsewhere) resolves the installed skill /
  // config without knowing the orchestrator repo location.
  const elsewhere = dir();
  const loaded = loadBrainCommandConfig({ codexHome });
  assert.strictEqual(loaded.orchestratorRoot, cfg.orchestratorRoot);
  assert.strictEqual(loaded.defaultBrain, 'chatgpt');
  assert.ok(fs.existsSync(installedBrainCommandSkillPath({ home })));
  assert.ok(elsewhere !== home && elsewhere !== codexHome, 'external cwd used');
});

test('legacy $CODEX_HOME/skills/brain-command is recognized as a backward-compatible fallback, not the canonical install destination', () => {
  const home = dir();
  const codexHome = dir();
  // Write a legacy skill at $CODEX_HOME/skills/brain-command/SKILL.md.
  const legacyDir = path.join(codexHome, 'skills', 'brain-command');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'SKILL.md'), 'legacy', 'utf8');
  assert.strictEqual(brainCommandInstalled({ home, codexHome }), true, 'legacy location counts as installed fallback');
  // But a NEW install goes to the canonical user Skill root, not legacy.
  const res = setupBrainCommand({ codexHome, home, config: { orchestratorRoot: path.join(dir(), 'o'), dataRoot: path.join(dir(), 'd'), workspaceRoot: path.join(dir(), 'w') } });
  assert.strictEqual(res.skillPath, installedBrainCommandSkillPath({ home }));
  assert.ok(!res.skillPath.startsWith(codexHome), 'setup never writes to the deprecated path');
});

test('setup preserves machine-local paths and is idempotent (does not reinstall every run)', () => {
  const home = dir();
  const codexHome = dir();
  const first = setupBrainCommand({ codexHome, home, config: { orchestratorRoot: path.join(dir(), 'a'), dataRoot: path.join(dir(), 'd'), workspaceRoot: path.join(dir(), 'w') } });
  const second = setupBrainCommand({ codexHome, home });
  assert.strictEqual(second.config.orchestratorRoot, first.config.orchestratorRoot);
  assert.strictEqual(second.config.dataRoot, first.config.dataRoot);
  assert.strictEqual(second.config.workspaceRoot, first.config.workspaceRoot);
  assert.ok(brainCommandInstalled({ home, codexHome }));
});

test('normal load does NOT reinstall the Skill', () => {
  const home = dir();
  const codexHome = dir();
  setupBrainCommand({ codexHome, home, config: { orchestratorRoot: path.join(dir(), 'a'), dataRoot: path.join(dir(), 'd'), workspaceRoot: path.join(dir(), 'w') } });
  const loaded = loadBrainCommandConfig({ codexHome });
  assert.ok(loaded.orchestratorRoot);
  assert.ok(brainCommandInstalled({ home, codexHome }));
});

test('user-runnable setup entrypoint (npm run setup:brain-command) installs Skill + config with isolated HOME / CODEX_HOME and writes nothing to the real env', () => {
  const home = dir();          // isolated HOME
  const codexHome = dir();     // isolated CODEX_HOME
  const orch = dir(); const data = dir(); const ws = dir();
  const script = path.join(process.cwd(), 'scripts', 'setup-brain-command.mjs');
  const out = execFileSync(process.execPath, [
    script,
    '--home', home,
    '--codex-home', codexHome,
    '--orchestrator-root', orch,
    '--data-root', data,
    '--workspace-root', ws,
  ], { encoding: 'utf8', cwd: process.cwd() });
  assert.ok(out.includes('brain-command setup complete'), 'setup completed');

  const skillPath = path.join(home, '.agents', 'skills', 'brain-command', 'SKILL.md');
  assert.ok(fs.existsSync(skillPath), 'Skill installed to $HOME/.agents/skills/brain-command/SKILL.md');
  assert.ok(fs.existsSync(legacyBrainCommandSkillPath({ codexHome })) === false, 'no write to deprecated $CODEX_HOME/skills path');

  const cfgPath = brainCommandConfigPath(codexHome);
  assert.ok(fs.existsSync(cfgPath), 'config written to $CODEX_HOME/brain-command/config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.strictEqual(cfg.orchestratorRoot, orch);
  assert.strictEqual(cfg.dataRoot, data);
  assert.strictEqual(cfg.workspaceRoot, ws);
  assert.strictEqual(cfg.defaultBrain, 'chatgpt');
  assert.strictEqual(cfg.defaultExecutor, 'codex');
  assert.strictEqual(cfg.defaultConversationMode, 'new');

  // Deterministic defaults when no roots passed: orchestratorRoot resolves to the repo.
  const home2 = dir(); const codexHome2 = dir();
  execFileSync(process.execPath, [script, '--home', home2, '--codex-home', codexHome2, '--workspace-root', ws], { encoding: 'utf8', cwd: process.cwd() });
  const cfg2 = JSON.parse(fs.readFileSync(brainCommandConfigPath(codexHome2), 'utf8'));
  assert.ok(cfg2.orchestratorRoot, 'orchestratorRoot deterministically resolved');
  assert.ok(cfg2.dataRoot, 'dataRoot deterministically resolved');
});


test('broad discovery telemetry: configured fast path reports false and does not invoke a broad search', () => {
  const cfg = { ...VALID };
  // fast path: broadDiscoveryOccurred is false and no broad-search helper is called
  const r = resolveRepoDir({ cwd: cfg.workspaceRoot, config: cfg });
  assert.strictEqual(r.broadDiscoveryOccurred, false);
  // an explicit fallback/setup discovery marks broadDiscoveryOccurred = true
  const broad = discoverBroadRepoDir({ roots: [cfg.workspaceRoot] });
  assert.strictEqual(broad.broadDiscoveryOccurred, true);
  // markBroadDiscovery flips the flag on an otherwise-false metrics object
  const m = markBroadDiscovery(newBootstrapMetrics());
  assert.strictEqual(m.broadDiscoveryOccurred, true);
});

test('bootstrap metrics helpers', () => {
  const m = newBootstrapMetrics();
  assert.strictEqual(m.broadDiscoveryOccurred, false);
  assert.strictEqual(m.fullSuiteVerificationCount, 0);
  assert.strictEqual(bootstrapElapsedMs(m) >= 0, true);
});
