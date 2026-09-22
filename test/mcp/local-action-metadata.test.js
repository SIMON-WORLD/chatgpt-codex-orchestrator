import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startMcpServer } from '../../src/mcp/server.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { MutationOwner } from '../../src/state/mutation-owner.js';
import { OperationState } from '../../src/state/operation-state.js';

test('Issue #147 exposes truthful Direct Local mutation annotations without reclassifying unrelated tools', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue147-metadata-'));
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const owner = new MutationOwner();
  const operationState = new OperationState({ dataRoot: root });
  const appServerExecutor = { owner };

  const server = await startMcpServer({
    workspaceRegistry: registry,
    appServerExecutor,
    mutationOwner: owner,
    operationState,
    desktopCommanderChild: {},
    host: '127.0.0.1',
    port: 0,
  });
  t.after(async () => {
    try { await client.close(); } catch {}
    try { await server.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const client = new Client({ name: 'issue147-metadata', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(server.url));
  const listed = await client.listTools();
  const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));

  const expected = {
    edit: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    filesystem_create_directory: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    filesystem_move: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    excel_write_range: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    docx_edit_text: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    docx_create_text: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    pdf_mutate_pages: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  };

  for (const [name, annotations] of Object.entries(expected)) {
    assert.ok(byName[name], name + ' must be exposed through MCP listTools');
    assert.deepEqual(byName[name].annotations, annotations, name + ' annotations');
  }

  assert.match(byName.filesystem_create_directory.description, /destination must not already exist/iu);
  assert.match(byName.filesystem_create_directory.description, /no existing entry is overwritten/iu);
  assert.match(byName.docx_create_text.description, /destination must not already exist/iu);
  assert.match(byName.docx_create_text.description, /no existing document is overwritten/iu);

  assert.deepEqual(byName.route_decide.annotations, { readOnlyHint: true });
  assert.deepEqual(byName.governance_plan.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  });
  assert.deepEqual(byName.governance_transition.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(byName.governance_record_result.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
  });
  assert.deepEqual(byName.codex_start.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
  });
});
