// chatgpt-codex-orchestrator: narrow server-owned Codex diagnostics (Issue #64).
// This module intentionally exposes no generic filesystem surface. The caller can
// choose only a fixed diagnostic selector; source discovery remains server-owned.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getCodexHome } from '../runtime-env.js';

export const CODEX_DIAGNOSTIC_KINDS = Object.freeze(['stall_summary', 'config_safety']);
export const CODEX_DIAGNOSTIC_SOURCE_STATUSES = Object.freeze([
  'available',
  'missing',
  'unreadable',
  'invalid_type',
  'unsafe_link',
  'escaped',
  'oversize',
  'invalid_schema',
]);

export const CODEX_DIAGNOSTIC_BOUNDS = Object.freeze({
  defaultWindowHours: 24,
  maxWindowHours: 168,
  maxConfigBytes: 512 * 1024,
  maxCount: 1_000_000_000,
});

const APPROVED_SOURCES = Object.freeze({
  stall_summary: { key: 'log_db', file: 'logs_2.sqlite' },
  config_safety: { key: 'config', file: 'config.toml' },
});

const LOG_SIGNALS = Object.freeze({
  pluginList: '%plugin/list%',
  skillsList: '%skills/list%',
  modelRefreshFailures: '%failed to refresh available models%',
  streamDisconnected: '%stream disconnected%',
  childTimeout: '%timeout waiting for child process to exit%',
  mcpTransportErrors: '%worker quit with fatal%',
  connectorProxyErrors: '%connector-proxy%',
  localMcpErrors: '%127.0.0.1:5157%',
  analyticsSendFailures: '%failed to send events request%',
  recommendedPluginsFailures: '%failed to load recommended plugins%',
  skillBudgetLines: '%truncated skill metadata%',
  totalSkillsLogs: '%total_skills%',
  omittedSkillsLogs: '%omitted_skills%',
});

const MOJIBAKE_FRAGMENTS = Object.freeze([
  'ä¸­å›½', 'è¿è¥', 'å…¬ä¼—', 'å­¦æœ¯', 'ä¼ é€', 'éœ€æ±', 'å†²å‡»',
]);

function isContained(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}

function sourceStatus(status) {
  return CODEX_DIAGNOSTIC_SOURCE_STATUSES.includes(status) ? status : 'unreadable';
}

function clampCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.trunc(n), CODEX_DIAGNOSTIC_BOUNDS.maxCount);
}

function fixedFailure(kind, source, status) {
  return {
    schemaVersion: 1,
    kind,
    status: 'unavailable',
    source,
    sourceStatus: sourceStatus(status),
    completeness: 'none',
  };
}

function resolveApprovedSource(codexHome, file) {
  let rootStat;
  try { rootStat = fs.lstatSync(codexHome); }
  catch (e) { return { status: e && e.code === 'ENOENT' ? 'missing' : 'unreadable' }; }
  if (rootStat.isSymbolicLink()) return { status: 'unsafe_link' };
  if (!rootStat.isDirectory()) return { status: 'invalid_type' };

  let canonicalRoot;
  try { canonicalRoot = fs.realpathSync.native(codexHome); }
  catch { return { status: 'unreadable' }; }

  const candidate = path.join(codexHome, file);
  let targetStat;
  try { targetStat = fs.lstatSync(candidate); }
  catch (e) { return { status: e && e.code === 'ENOENT' ? 'missing' : 'unreadable' }; }
  if (targetStat.isSymbolicLink()) return { status: 'unsafe_link' };
  if (!targetStat.isFile()) return { status: 'invalid_type' };

  let canonicalTarget;
  try { canonicalTarget = fs.realpathSync.native(candidate); }
  catch { return { status: 'unreadable' }; }
  if (!isContained(canonicalRoot, canonicalTarget)) return { status: 'escaped' };
  return { status: 'available', path: canonicalTarget, size: targetStat.size };
}

function countQuery(db, sql, params) {
  const row = db.prepare(sql).get(...params);
  return clampCount(row && row.count);
}

function analyzeStallSummary(file, windowHours, nowMs) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true, enableForeignKeyConstraints: false });
    const since = (nowMs / 1000) - (windowHours * 3600);
    const where = 'WHERE ts > ?';
    const totalRows = countQuery(db, `SELECT COUNT(*) AS count FROM logs ${where}`, [since]);
    const signals = {};
    for (const [key, pattern] of Object.entries(LOG_SIGNALS)) {
      signals[key] = countQuery(db, `SELECT COUNT(*) AS count FROM logs ${where} AND feedback_log_body LIKE ?`, [since, pattern]);
    }
    return {
      schemaVersion: 1,
      kind: 'stall_summary',
      status: 'ok',
      source: 'log_db',
      sourceStatus: 'available',
      completeness: 'complete',
      windowHours,
      totalRows,
      signals,
    };
  } catch {
    return fixedFailure('stall_summary', 'log_db', 'invalid_schema');
  } finally {
    try { db && db.close(); } catch {}
  }
}

function analyzeConfigSafety(file, size) {
  if (size > CODEX_DIAGNOSTIC_BOUNDS.maxConfigBytes) return fixedFailure('config_safety', 'config', 'oversize');
  let raw;
  try { raw = fs.readFileSync(file, { encoding: 'utf8' }); }
  catch { return fixedFailure('config_safety', 'config', 'unreadable'); }

  const lower = raw.toLowerCase();
  return {
    schemaVersion: 1,
    kind: 'config_safety',
    status: 'ok',
    source: 'config',
    sourceStatus: 'available',
    completeness: 'complete',
    signals: {
      wireApiChat: /\bwire_api\s*=\s*["']chat["']/iu.test(raw),
      namedPipeReference: raw.includes('\\\\.\\pipe\\') || raw.includes('\\\\\\\\.\\\\pipe\\\\'),
      localhostReference: lower.includes('127.0.0.1') || lower.includes('localhost') || lower.includes('::1'),
      mojibakeReference: MOJIBAKE_FRAGMENTS.some((fragment) => raw.includes(fragment)),
    },
  };
}

export class CodexDiagnosticsService {
  constructor({ codexHome = getCodexHome(), now = () => Date.now() } = {}) {
    this.codexHome = path.resolve(String(codexHome));
    this.now = now;
  }

  run({ kind, windowHours = CODEX_DIAGNOSTIC_BOUNDS.defaultWindowHours } = {}) {
    if (!CODEX_DIAGNOSTIC_KINDS.includes(kind)) throw new Error('unsupported diagnostic selector');
    const source = APPROVED_SOURCES[kind];
    const resolved = resolveApprovedSource(this.codexHome, source.file);
    if (resolved.status !== 'available') return fixedFailure(kind, source.key, resolved.status);

    if (kind === 'stall_summary') return analyzeStallSummary(resolved.path, windowHours, this.now());
    return analyzeConfigSafety(resolved.path, resolved.size);
  }
}
