#!/usr/bin/env node
import { composePrivateRelayDoctor } from '../src/operability/private-relay-doctor.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error('unexpected argument: ' + key);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error('missing value for ' + key);
    out[key.slice(2)] = value;
  }
  return out;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const envName = args['account-bearer-env'] || 'PRIVATE_RELAY_ACCOUNT_BEARER';
  const accountBearer = process.env[envName] || null;
  const result = await composePrivateRelayDoctor({
    configPath: args.config,
    expectedSha: args.sha || null,
    relayUrl: args['relay-url'] || null,
    accountBearer,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.status === 'READY' ? 0 : 2;
} catch (error) {
  process.stderr.write(JSON.stringify({
    status: 'FAIL',
    error: String(error?.message || error).slice(0, 512),
  }) + '\n');
  process.exitCode = 1;
}
