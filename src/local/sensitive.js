// chatgpt-codex-orchestrator: centralized path-aware sensitive-path policy
// (v0.2 M2). Used by read.js and search.js. Path-aware high-risk rules: a file is
// sensitive only when its basename / directory matches an explicit high-risk
// pattern. Ordinary source files such as `src/secret-utils.js` or
// `src/token-parser.js` remain readable (a bare "secret"/"token" substring is NOT
// treated as sensitive).

const SENSITIVE_BASENAMES = [
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa',
  'credentials.json', 'auth.json', 'service-account*.json',
];
const SENSITIVE_DIRS = new Set(['credentials', 'secrets', '.codex']);

function wildcard(pat, lower) {
  if (pat.includes('*')) {
    const re = '^' + pat.split('*').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.*') + '$';
    return new RegExp(re).test(lower);
  }
  return pat === lower;
}

export function isSensitivePath(relPath) {
  const parts = String(relPath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (SENSITIVE_DIRS.has(lower)) return true;
    for (const pat of SENSITIVE_BASENAMES) {
      if (wildcard(pat, lower)) return true;
    }
  }
  return false;
}

export function isIgnoredSearchDir(name) {
  const lower = String(name || '').toLowerCase();
  return SENSITIVE_DIRS.has(lower) ||
    lower === '.git' || lower === 'node_modules' || lower === 'dist' || lower === 'build' ||
    lower === '.next' || lower === '.venv' || lower === 'venv' || lower === '.state' ||
    lower === 'coverage';
}

// Blocked for DIRECT LOCAL mutation: high-risk / internal / generated / cache /
// dependency paths. Ordinary application source (e.g. src/secret-utils.js,
// src/token-parser.js) remains writable if otherwise allowed.
const BLOCKED_MUTATION_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.state', '.codex', 'credentials', 'secrets', 'runtime']);

export function isBlockedMutationPath(relPath) {
  const parts = String(relPath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const lower = parts[i].toLowerCase();
    if (BLOCKED_MUTATION_DIRS.has(lower)) return true;
    if (SENSITIVE_DIRS.has(lower)) return true;
    if (isSensitivePath(parts.slice(0, i + 1).join('/'))) return true;
  }
  return false;
}
