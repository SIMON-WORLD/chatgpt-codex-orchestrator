import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  brainCommandStatus, formatBrainCommandStatus, writeBrainCommandConfig,
  installedBrainCommandSkillPath, legacyBrainCommandSkillPath,
} from '../src/bootstrap.js';

function dir() { const d = path.join(os.tmpdir(), 'bcstatus-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)); fs.mkdirSync(d, { recursive: true }); return d; }
function writeSkill(home) {
  const p = installedBrainCommandSkillPath({ home });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '# test skill\n', 'utf8');
  return p;
}

const VALID = {
  orchestratorRoot: path.join(dir(), 'orch'),
  dataRoot: path.join(dir(), 'data'),
  workspaceRoot: path.join(dir(), 'ws'),
  defaultBrain: 'chatgpt',
  defaultExecutor: 'codex',
  defaultConversationMode: 'new',
};

test('healthy: skill discoverable + valid config -> ok, exit 0, all six fields', () => {
  const home = dir();
  writeSkill(home);
  writeBrainCommandConfig(VALID, { codexHome: home });
  const s = brainCommandStatus({ codexHome: home, home });
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.exitCode, 0);
  assert.strictEqual(s.skill.status, 'PASS');
  assert.strictEqual(s.config.status, 'PASS');
  assert.strictEqual(s.config.parseable, true);
  assert.deepStrictEqual(s.fields, VALID);
});

test('missing config -> not ok, non-zero exit, clear diagnostic; skill may still pass', () => {
  const home = dir();
  writeSkill(home);
  const s = brainCommandStatus({ codexHome: home, home });
  assert.strictEqual(s.ok, false);
  assert.notStrictEqual(s.exitCode, 0);
  assert.strictEqual(s.config.status, 'FAIL');
  assert.strictEqual(s.config.exists, false);
  assert.match(s.config.reason, /config not found/);
  assert.strictEqual(s.config.parseable, false);
});

test('invalid JSON config -> not ok, config not parseable', () => {
  const home = dir();
  writeSkill(home);
  fs.mkdirSync(path.join(home, 'brain-command'), { recursive: true });
  fs.writeFileSync(path.join(home, 'brain-command', 'config.json'), '{not json', 'utf8');
  const s = brainCommandStatus({ codexHome: home, home });
  assert.strictEqual(s.ok, false);
  assert.strictEqual(s.config.status, 'FAIL');
  assert.strictEqual(s.config.parseable, false);
});

test('invalid config (bad defaultBrain / empty root) -> not ok', () => {
  const home = dir();
  writeSkill(home);
  writeBrainCommandConfig({ ...VALID, defaultBrain: 'claude', workspaceRoot: '' }, { codexHome: home });
  const s = brainCommandStatus({ codexHome: home, home });
  assert.strictEqual(s.ok, false);
  assert.strictEqual(s.config.status, 'FAIL');
});

test('skill missing but config valid -> not ok, skill FAIL', () => {
  const home = dir();
  writeBrainCommandConfig(VALID, { codexHome: home });
  const s = brainCommandStatus({ codexHome: home, home });
  assert.strictEqual(s.ok, false);
  assert.strictEqual(s.skill.status, 'FAIL');
  assert.strictEqual(s.skill.discoverable, false);
});

test('legacy skill only -> discoverable (WARN); ok with valid config', () => {
  const home = dir();
  const legacy = legacyBrainCommandSkillPath({ codexHome: home });
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, '# legacy\n', 'utf8');
  writeBrainCommandConfig(VALID, { codexHome: home });
  const s = brainCommandStatus({ codexHome: home, home });
  assert.strictEqual(s.skill.discoverable, true);
  assert.strictEqual(s.skill.status, 'WARN');
  assert.strictEqual(s.ok, true);
});

test('no secret/token field is surfaced in fields or status object', () => {
  const home = dir();
  writeSkill(home);
  writeBrainCommandConfig({ ...VALID, apiToken: 'sekrit-token', secret: 'SHH' }, { codexHome: home });
  const s = brainCommandStatus({ codexHome: home, home });
  assert.strictEqual(s.ok, true);
  assert.ok(!('apiToken' in s.fields));
  assert.ok(!('secret' in s.fields));
  assert.ok(!JSON.stringify(s).includes('sekrit-token'));
  assert.ok(!JSON.stringify(s).includes('SHH'));
});

test('formatBrainCommandStatus renders fields but never leaks a secret', () => {
  const home = dir();
  writeSkill(home);
  writeBrainCommandConfig({ ...VALID, apiToken: 'sekrit-token' }, { codexHome: home });
  const s = brainCommandStatus({ codexHome: home, home });
  const text = formatBrainCommandStatus(s);
  assert.match(text, /orchestratorRoot/);
  assert.match(text, /workspaceRoot/);
  assert.match(text, /defaultConversationMode/);
  assert.match(text, /defaultBrain/);
  assert.ok(!text.includes('sekrit-token'));
});
