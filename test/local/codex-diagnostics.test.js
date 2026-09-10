import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  CodexDiagnosticsService,
  CODEX_DIAGNOSTIC_BOUNDS,
} from '../../src/local/codex-diagnostics.js';

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-diag-'));
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeLogDb(home, rows = []) {
  const file = path.join(home, 'logs_2.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE logs (ts REAL, level TEXT, feedback_log_body TEXT)');
  const insert = db.prepare('INSERT INTO logs (ts, level, feedback_log_body) VALUES (?, ?, ?)');
  for (const row of rows) insert.run(row.ts, row.level, row.body);
  db.close();
  return file;
}

test('stall_summary returns only fixed aggregate counts and leaves the DB unchanged', () => {
  const home = makeHome();
  const now = 2_000_000_000_000;
  const secret = 'sk-secret C:\\Users\\Private https://private.example thread_abc session_123';
  const dbFile = makeLogDb(home, [
    { ts: (now / 1000) - 10, level: 'WARN', body: `stream disconnected ${secret}` },
    { ts: (now / 1000) - 20, level: 'ERROR', body: `failed to refresh available models ${secret}` },
    { ts: (now / 1000) - (8 * 24 * 3600), level: 'INFO', body: 'plugin/list old row' },
  ]);
  const before = sha(dbFile);
  const service = new CodexDiagnosticsService({ codexHome: home, now: () => now });

  const result = service.run({ kind: 'stall_summary', windowHours: 24 });
  const serialized = JSON.stringify(result);

  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'log_db');
  assert.equal(result.sourceStatus, 'available');
  assert.equal(result.totalRows, 2);
  assert.equal(result.signals.streamDisconnected, 1);
  assert.equal(result.signals.modelRefreshFailures, 1);
  assert.equal(result.signals.pluginList, 0);
  for (const forbidden of ['sk-secret', 'C:\\Users\\Private', 'private.example', 'thread_abc', 'session_123']) {
    assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
  }
  assert.equal(sha(dbFile), before, 'read-only diagnostics must not modify the source DB');
});

test('config_safety returns booleans only and never returns raw config-derived values', () => {
  const home = makeHome();
  const configFile = path.join(home, 'config.toml');
  fs.writeFileSync(configFile, [
    'wire_api = "chat"',
    'token = "sk-private-token"',
    'url = "https://private.example/path"',
    'path = "C:\\\\Users\\\\Private\\\\session_123"',
    'pipe = "\\\\\\\\.\\\\pipe\\\\secret-pipe"',
    'endpoint = "http://127.0.0.1:5157"',
    'label = "ä¸­å›½"',
  ].join('\n'), 'utf8');
  const before = sha(configFile);
  const service = new CodexDiagnosticsService({ codexHome: home });

  const result = service.run({ kind: 'config_safety' });
  const serialized = JSON.stringify(result);

  assert.deepEqual(result.signals, {
    wireApiChat: true,
    namedPipeReference: true,
    localhostReference: true,
    mojibakeReference: true,
  });
  for (const forbidden of ['sk-private-token', 'private.example', 'Users', 'session_123', 'secret-pipe']) {
    assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
  }
  assert.equal(sha(configFile), before, 'read-only diagnostics must not modify config');
});

test('missing, invalid schema, unexpected type, and oversize inputs fail closed with fixed status only', () => {
  const home = makeHome();
  const service = new CodexDiagnosticsService({ codexHome: home });

  assert.deepEqual(service.run({ kind: 'stall_summary' }), {
    schemaVersion: 1, kind: 'stall_summary', status: 'unavailable', source: 'log_db', sourceStatus: 'missing', completeness: 'none',
  });

  const dbFile = path.join(home, 'logs_2.sqlite');
  fs.writeFileSync(dbFile, 'private malformed sqlite payload C:\\Users\\Private', 'utf8');
  const beforeBadDb = sha(dbFile);
  const invalid = service.run({ kind: 'stall_summary' });
  assert.equal(invalid.sourceStatus, 'invalid_schema');
  assert.equal(JSON.stringify(invalid).includes('Private'), false);
  assert.equal(sha(dbFile), beforeBadDb);

  const configFile = path.join(home, 'config.toml');
  fs.mkdirSync(configFile);
  assert.equal(service.run({ kind: 'config_safety' }).sourceStatus, 'invalid_type');
  fs.rmSync(configFile, { recursive: true });

  fs.writeFileSync(configFile, 'x'.repeat(CODEX_DIAGNOSTIC_BOUNDS.maxConfigBytes + 1), 'utf8');
  assert.equal(service.run({ kind: 'config_safety' }).sourceStatus, 'oversize');
});

test('symlinked approved source is rejected without following it or leaking target data', (t) => {
  const home = makeHome();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-diag-outside-'));
  const target = path.join(outside, 'secret.toml');
  fs.writeFileSync(target, 'token="sk-outside-secret"', 'utf8');
  try { fs.symlinkSync(target, path.join(home, 'config.toml')); }
  catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) return t.skip('symlink creation not permitted');
    throw e;
  }

  const result = new CodexDiagnosticsService({ codexHome: home }).run({ kind: 'config_safety' });
  assert.equal(result.sourceStatus, 'unsafe_link');
  assert.equal(JSON.stringify(result).includes('sk-outside-secret'), false);
  assert.equal(sha(target), sha(target), 'target remains readable and unchanged by the test itself');
});
