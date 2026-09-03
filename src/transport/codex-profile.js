// chatgpt-codex-orchestrator: isolated Codex runtime profile for real App Server use.
// Credential-safe: discovers the user's current provider (id/base_url/model/bearer
// presence) and builds an isolated CODEX_HOME profile whose provider reads the
// credential from a process-only env var (V02_CODEX_PROVIDER_TOKEN). No auth.json is
// copied and no token is written into config/argv/report.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export const PROVIDER_TOKEN_ENV = 'V02_CODEX_PROVIDER_TOKEN';

export function userConfigPath() { return process.env.USER_CODEX_HOME || path.join(os.homedir(), '.codex', 'config.toml'); }

export function discoverProvider() {
  const raw = fs.readFileSync(userConfigPath(), 'utf8');
  const modelMatch = raw.match(/^\s*model\s*=\s*"([^"]+)"/m);
  const provMatch = raw.match(/^\s*model_provider\s*=\s*"([^"]+)"/m);
  const baseMatch = raw.match(/base_url\s*=\s*"([^"]+)"/);
  const tokMatch = raw.match(/experimental_bearer_token\s*=\s*"([^"]+)"/);
  return {
    providerId: (provMatch && provMatch[1]) || 'openai-chat-completions',
    baseUrl: (baseMatch && baseMatch[1]) || 'http://127.0.0.1:19100/v1',
    model: (modelMatch && modelMatch[1]) || 'deepseek-v4-flash-vision-exp',
    hasToken: !!tokMatch,
    token: tokMatch ? tokMatch[1] : null,
  };
}

export function buildIsolatedConfig(provider, model) {
  const pid = 'v02-ccswitch';
  const lines = [
    'model_provider = "' + pid + '"',
    'model = "' + (model || provider.model) + '"',
    '[model_providers.' + pid + ']',
    'name = "ccswitch"',
    'base_url = "' + provider.baseUrl + '"',
    'wire_api = "responses"',
    'env_key = "' + PROVIDER_TOKEN_ENV + '"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    'request_max_retries = 0',
    'stream_max_retries = 0',
  ];
  return lines.join('\n') + '\n';
}

// Create an isolated CODEX_HOME profile dir + config. Returns { home }.
export function prepareIsolatedCodexHome(provider, dataRoot, { model = null } = {}) {
  const home = path.join(dataRoot, 'codex-profile');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), buildIsolatedConfig(provider, model), 'utf8');
  return { home };
}

// Inject the credential into the process env (never argv/report/config).
export function injectProviderTokenEnv(provider) {
  if (provider.token) process.env[PROVIDER_TOKEN_ENV] = provider.token;
  return process.env[PROVIDER_TOKEN_ENV] != null;
}

// Read-only Responses streaming probe (termination semantics).
export async function probeResponsesCompatibility(provider) {
  if (!provider.token) return { ok: false, reason: 'provider credential not present in user config' };
  try {
    const body = JSON.stringify({ model: provider.model, input: 'say REALTIME_OK', stream: true });
    const res = await fetch(provider.baseUrl + '/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: 'Bearer ' + provider.token },
      body,
    });
    if (!res.ok) return { ok: false, reason: 'HTTP ' + res.status };
    const text = await res.text();
    const events = [...text.matchAll(/event:\s*([a-zA-Z0-9_.]+)/g)].map((m) => m[1]);
    const haveCreated = events.includes('response.created');
    const haveText = events.some((e) => e.includes('output_text'));
    const haveCompleted = events.includes('response.completed');
    return { ok: haveCreated && haveText && haveCompleted, events, haveCreated, haveText, haveCompleted };
  } catch (e) { return { ok: false, reason: 'network/protocol error: ' + String(e.message || e).slice(0, 160) }; }
}

export { PROVIDER_TOKEN_ENV as _envKey };
