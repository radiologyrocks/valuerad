import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;

import { buildMcpTools, buildServer } from '../mcp.js';

function fakeApi() {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    return { ok: true };
  };
  api.calls = calls;
  return api;
}

test('the MCP surface exposes the governed command-center operations', () => {
  const tools = buildMcpTools(fakeApi());
  const names = Object.keys(tools);
  for (const required of [
    'list_features', 'request_feature', 'approve_feature', 'canary_feature', 'run_feature',
    'rollback_feature', 'get_attestation', 'list_catalog', 'install_catalog_feature',
    'run_ops_agent', 'ceo_report', 'ingest_csv', 'run_evals',
  ]) {
    assert.ok(names.includes(required), `missing tool ${required}`);
  }
  for (const t of Object.values(tools)) {
    assert.ok(t.description && t.shape && typeof t.handler === 'function');
  }
});

test('tools translate to the audited HTTP API — they add no authority of their own', async () => {
  const api = fakeApi();
  const tools = buildMcpTools(api);

  await tools.list_features.handler({ status: 'proposed' });
  await tools.approve_feature.handler({ id: 7, rubricResults: [true, false] });
  await tools.run_ops_agent.handler({ task: 'book it' });
  await tools.ingest_csv.handler({ dataset: 'claims', csv: 'a,b\n1,2', mapper: 'rcm' });
  await tools.get_attestation.handler({ id: 7 });

  assert.deepEqual(api.calls[0], { method: 'GET', path: '/api/features?status=proposed', body: undefined });
  assert.deepEqual(api.calls[1], { method: 'POST', path: '/api/features/7/approve', body: { rubricResults: [true, false] } });
  // the ops agent defaults to recommend mode — the MCP layer never escalates
  assert.equal(api.calls[2].body.mode, 'recommend');
  assert.deepEqual(api.calls[3].body, { dataset: 'claims', format: 'csv', csv: 'a,b\n1,2', mapper: 'rcm', replace: false });
  assert.deepEqual(api.calls[4], { method: 'GET', path: '/api/features/7/attestation', body: undefined });
});

test('buildServer registers every tool on an McpServer without error', () => {
  const server = buildServer(fakeApi());
  assert.ok(server);
});
