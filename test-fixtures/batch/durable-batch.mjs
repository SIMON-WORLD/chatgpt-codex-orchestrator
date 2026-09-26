#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const [artifactDir, delayText = '25'] = process.argv.slice(2);
if (!artifactDir) throw new Error('artifact directory is required');
const delayMs = Math.max(0, Number(delayText) || 0);
fs.mkdirSync(artifactDir, { recursive: true });

function write(name, value) {
  const target = path.join(artifactDir, name);
  const tmp = target + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, target);
}

write('status.json', { state: 'running', pid: process.pid });
await new Promise((resolve) => setTimeout(resolve, delayMs));
write('result.json', { ok: true, rows: 3, checksum: 'fixture-v1' });
write('status.json', { state: 'completed', exitCode: 0 });
