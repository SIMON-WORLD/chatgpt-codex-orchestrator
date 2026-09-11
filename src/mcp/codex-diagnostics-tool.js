// Dedicated MCP registration for the Issue #64 structured Codex diagnostic aperture.
// Kept separate from generic Direct Local tools so workspace/read/verify semantics stay unchanged.

import * as z from 'zod';
import { CODEX_DIAGNOSTIC_BOUNDS, CODEX_DIAGNOSTIC_KINDS } from '../local/codex-diagnostics.js';

const R = { readOnlyHint: true };

function text(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function fixedError() {
  return {
    content: [{ type: 'text', text: 'error: codex_diagnostics_failed' }],
    isError: true,
  };
}

export function registerCodexDiagnosticsTool(server, service) {
  if (!server || !service || typeof service.run !== 'function') return server;

  const inputSchema = z.object({
    kind: z.enum(CODEX_DIAGNOSTIC_KINDS),
    windowHours: z.number().int().min(1).max(CODEX_DIAGNOSTIC_BOUNDS.maxWindowHours).optional(),
  }).strict();

  server.registerTool('codex_diagnostics', {
    description: 'Opt-in server-owned structured read-only Codex diagnostics. No path, workspaceId, command, query, SQL, regex, raw-output, or mutation input is accepted.',
    annotations: R,
    inputSchema,
  }, async (args) => {
    try { return text(service.run(args)); }
    catch { return fixedError(); }
  });

  return server;
}
