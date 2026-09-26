import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function waitFor(filename, predicate = () => true, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filename)) {
      const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (predicate(value)) return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('artifact did not reach expected state: ' + filename);
}

test('ordinary non-interactive batch process leaves deterministic durable workspace artifacts', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-200-batch-'));
  const artifacts = path.join(workspace, 'artifacts');
  const fixture = fileURLToPath(new URL('../../test-fixtures/batch/durable-batch.mjs', import.meta.url));
  const child = spawn(process.execPath, [fixture, artifacts, '75'], {
    cwd: workspace,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  const statusPath = path.join(artifacts, 'status.json');
  const resultPath = path.join(artifacts, 'result.json');
  await waitFor(statusPath, (value) => value.state === 'running' || value.state === 'completed');
  const result = await waitFor(resultPath);
  const status = await waitFor(statusPath, (value) => value.state === 'completed');

  assert.deepEqual(result, { ok: true, rows: 3, checksum: 'fixture-v1' });
  assert.deepEqual(status, { state: 'completed', exitCode: 0 });
});
