import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PacketContextProvider } from '../src/context-provider.js';

function mkRepo(files) {
  const d = path.join(os.tmpdir(), 'cp-' + Date.now());
  fs.mkdirSync(d, { recursive: true });
  for (const [rel, content] of Object.entries(files)) { const p = path.join(d, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
  return d;
}

test('packet is bounded, skips .env, redacts secrets, records provenance', () => {
  const repo = mkRepo({ 'src/a.js': 'export const x = 1;', '.env': 'API_KEY=sk-secret1234567890', 'node_modules/x.js': 'x', 'README.md': 'hi' });
  const p = new PacketContextProvider({ repoDir: repo, maxBytes: 4000, git: false });
  const packet = p.buildPacket();
  assert.ok(!packet.fileSnippets.some((f) => f.file.includes('.env')), 'must not include .env');
  assert.ok(!packet.fileSnippets.some((f) => f.file.includes('node_modules')), 'must not include node_modules');
  assert.ok(packet.provenance.repoDir);
  assert.ok(packet.provenance.generatedAt);
  const all = JSON.stringify(packet);
  assert.ok(!all.includes('sk-secret1234567890'), 'must redact secrets');
});