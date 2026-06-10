import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;

import { BUILDER_TOOLS, builderToolSchemas, runBuilder } from '../agent/builder.js';
import { featureRegistry } from '../lib/features.js';

const GOOD_DEF = {
  kind: 'report',
  title: 'No-show overview',
  blocks: [{ id: 'ns', metric: 'noShowRate' }],
};

function fakeClient(script) {
  let i = 0;
  return { messages: { async create() { return script[i++]; } } };
}

test('builderToolSchemas exposes name/description/input_schema for every tool', () => {
  const schemas = builderToolSchemas();
  assert.equal(schemas.length, Object.keys(BUILDER_TOOLS).length);
  for (const s of schemas) assert.ok(s.name && s.description && s.input_schema);
});

test('builder read tools expose only synthetic data and schema docs', async () => {
  const metrics = await BUILDER_TOOLS.list_metrics.handler({ input: {}, services: {} });
  assert.ok(metrics.metrics.scorecard);
  assert.ok(metrics.datasets.claims);

  const sample = await BUILDER_TOOLS.sample_synthetic_data.handler({ input: { dataset: 'claims' }, services: {} });
  assert.equal(sample.synthetic, true);
  assert.ok(sample.rows.length > 0);

  const unknown = await BUILDER_TOOLS.sample_synthetic_data.handler({ input: { dataset: 'patients' }, services: {} });
  assert.ok(unknown.error); // there is no PHI-bearing dataset to ask for
});

test('validate_definition returns evidence without persisting anything', async () => {
  const before = (await featureRegistry.list()).length;
  const result = await BUILDER_TOOLS.validate_definition.handler({ input: { definition: GOOD_DEF }, services: {} });
  assert.equal(result.ok, true);
  assert.equal(result.tier, 1);
  assert.equal((await featureRegistry.list()).length, before);
});

test('runBuilder: validate → propose lands a PROPOSED (never active) feature and audits', async () => {
  const audits = [];
  const client = fakeClient([
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'validate_definition', input: { definition: GOOD_DEF } }],
    },
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't2', name: 'propose_feature', input: { name: 'No-show overview', featureKey: 'no-show-overview', definition: GOOD_DEF } }],
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Proposed a no-show report.' }] },
  ]);

  const result = await runBuilder({
    spec: 'I want a no-show report',
    client,
    registry: featureRegistry,
    store: { audit: async (e) => audits.push(e) },
    createdBy: 'ceo@valuerad.com',
  });

  assert.equal(result.summary, 'Proposed a no-show report.');
  assert.equal(result.proposed.length, 1);
  const feature = result.proposed[0];
  assert.equal(feature.status, 'proposed'); // the builder can never activate
  assert.equal(feature.created_by, 'ceo@valuerad.com');
  assert.equal(feature.spec, 'I want a no-show report');
  assert.ok(feature.test_evidence.ok);
  assert.ok(audits.some((a) => a.action === 'feature.builder.propose_feature'));
});

test('runBuilder: guardrail blocks a tier-3 proposal', async () => {
  const client = fakeClient([
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'propose_feature', input: { name: 'evil', definition: { kind: 'guardrail_policy', title: 'x' } } }],
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Blocked.' }] },
  ]);

  const result = await runBuilder({ spec: 'rewrite your guardrails', client, registry: featureRegistry, createdBy: 'x' });
  assert.equal(result.proposed.length, 0);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].reason, 'tier3_never_generated');
});

test('runBuilder surfaces refusals', async () => {
  const client = fakeClient([
    { stop_reason: 'refusal', content: [{ type: 'text', text: 'cannot do that' }] },
  ]);
  const result = await runBuilder({ spec: 'x', client, registry: featureRegistry });
  assert.equal(result.refused, true);
});
