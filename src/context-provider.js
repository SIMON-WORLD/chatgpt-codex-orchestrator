// chatgpt-codex-orchestrator: ContextProvider / PacketContextProvider (Batch C3).
// Builds a BOUNDED context packet for the Brain before planning/review, with secret
// redaction, no whole-repo by default, no sensitive files, and recorded provenance.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeRepoDir, redactSecrets } from './safety.js';

const SENSITIVE = [/\.env($|\.)/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /id_rsa/i, /credentials/i, /\.htpasswd$/i, /secret/i, /\.pfx$/i, /token[^a-zA-Z0-9]/i];
const IGNORED_DIRS = new Set(['node_modules', '.git', '.next', '.state', '.codex', 'dist', 'build', '.venv', 'venv']);

export class PacketContextProvider {
  constructor({ repoDir, maxBytes = 12000, maxFiles = 12, git = true } = {}) {
    this.repoDir = normalizeRepoDir(repoDir);
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.git = git;
  }

  _git(args) {
    try { return execFileSync('git', ['-C', this.repoDir, ...args], { encoding: 'utf8', timeout: 8000, stdio: ['ignore','pipe','ignore'] }).trim(); }
    catch (e) { return ''; }
  }

  _isSensitive(p) { return SENSITIVE.some((re) => re.test(p)); }
  _walk(dir, acc, depth = 0) {
    if (depth > 3 || acc.length >= this.maxFiles * 4) return acc;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
    for (const e of entries) {
      if (acc.length >= this.maxFiles * 4) break;
      if (IGNORED_DIRS.has(e.name) || e.name.startsWith('.git')) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(this.repoDir, full).replace(/\\/g, '/');
      if (e.isDirectory()) { this._walk(full, acc, depth + 1); }
      else if (!this._isSensitive(rel)) acc.push(rel);
    }
    return acc;
  }

  _fileContent(rel, cap) {
    try {
      const full = path.join(this.repoDir, rel);
      const st = fs.statSync(full);
      if (st.size > 200 * 1024) return { truncated: true, text: '' }; // don't read huge files wholesale
      let text = fs.readFileSync(full, 'utf8');
      const lines = text.split(/\r?\n/);
      if (lines.length > 60) { text = lines.slice(0, 60).join('\n') + '\n... [' + (lines.length - 60) + ' more lines]'; }
      if (text.length > cap) text = text.slice(0, cap) + '\n...[truncated]';
      return { text: redactSecrets(text) };
    } catch { return { text: '' }; }
  }

  buildPacket({ files = [], testResults = [], errors = [], maxBytes } = {}) {
    const cap = maxBytes || this.maxBytes;
    const rels = [];
    if (files && files.length) rels.push(...files.slice(0, this.maxFiles));
    else rels.push(...this._walk(this.repoDir, []).slice(0, this.maxFiles));

    const out = { provenance: { repoDir: this.repoDir, generatedAt: new Date().toISOString(), providers: ['git-status', 'git-diff', 'files'], files: [] }, repoMap: [], gitStatus: '', gitDiff: '', fileSnippets: [], testResults, errors, truncated: false };

    if (this.git) { out.gitStatus = this._git(['status', '--short']).slice(0, 1500); out.gitDiff = this._git(['diff', '--stat']).slice(0, 1500); }
    let bytes = out.gitStatus.length + out.gitDiff.length;
    for (const rel of rels) {
      if (bytes > cap) { out.truncated = true; break; }
      const c = this._fileContent(rel, 1200);
      out.repoMap.push({ file: rel, truncatedEdges: c.truncated || c.text.includes('...') });
      if (c.text) {
        out.fileSnippets.push({ file: rel, snippet: c.text });
        bytes += c.text.length;
      }
    }
    return out;
  }
}