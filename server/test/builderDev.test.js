import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;
delete process.env.NODE_ENV;

import { buildSdkTools, runBuilderDev } from '../agent/builderDev.js';
import { BUILDER_TOOLS } from '../agent/builder.js';
import { featureRegistry } from '../lib/features.js';

const GOOD_DEF = {
  kind: 'report',
  title: 'Utilization watch',
  blocks: [{ id: 'u', metric: 'utilization' }],
};

// A minimal fake of the Agent SDK surface builderDev uses.
function fakeSdk({ script }) {
  const calls = [];
  return {
    calls,
    tool(name, description, shape, handler) {
      return { name, description, shape, handler };
    },
    createSdkMcpServer({ name, tools }) {
      return { name, tools };
    },
    query({ prompt, options }) {
      calls.push({ prompt, options });
      return (async function* () {
        // Drive the registered tool handlers exactly as Claude Code would.
        const byName = Object.fromEntries(options.mcpServers.builder.tools.map((t) => [t.name, t]));
        for (const step of script) {
          if (step.tool) await byName[step.tool].handler(step.input);
        }
        yield { type: 'result', subtype: 'success', result: 'Proposed a utilization report.', total_cost_usd: 0 };
      })();
    },
  };
}

test('buildSdkTools wraps every builder tool and proxies handlers', async () => {
  const seen = [];
  const sdk = { tool: (name, description, shape, handler) => ({ name, description, shape, handler }) };
  const tools = buildSdkTools(sdk, { registry: featureRegistry }, async (name, result) => seen.push({ name, result }));

  assert.equal(tools.length, Object.keys(BUILDER_TOOLS).length);
  const metrics = tools.find((t) => t.name === 'list_metrics');
  const out = await metrics.handler({});
  assert.equal(out.content[0].type, 'text');
  assert.ok(JSON.parse(out.content[0].text).metrics.scorecard);
  assert.equal(seen[0].name, 'list_metrics');
});

test('runBuilderDev: tools restricted to the builder MCP server, built-ins disallowed', async () => {
  const sdk = fakeSdk({ script: [] });
  await runBuilderDev({ spec: 'x', registry: featureRegistry, sdkImpl: sdk });
  const { options } = sdk.calls[0];
  assert.deepEqual(options.allowedTools, Object.keys(BUILDER_TOOLS).map((n) => `mcp__builder__${n}`));
  assert.ok(options.disallowedTools.includes('Bash'));
  assert.ok(options.disallowedTools.includes('WebFetch'));
});

test('runBuilderDev: proposals land as PROPOSED with audit, never active', async () => {
  const audits = [];
  const sdk = fakeSdk({
    script: [
      { tool: 'validate_definition', input: { definition: GOOD_DEF } },
      { tool: 'propose_feature', input: { name: 'Utilization watch', featureKey: 'utilization-watch', definition: GOOD_DEF } },
    ],
  });
  const result = await runBuilderDev({
    spec: 'watch my utilization',
    registry: featureRegistry,
    store: { audit: async (e) => audits.push(e) },
    createdBy: 'ceo@valuerad.com',
    sdkImpl: sdk,
  });

  assert.equal(result.transport, 'claude-subscription');
  assert.equal(result.summary, 'Proposed a utilization report.');
  assert.equal(result.proposed.length, 1);
  assert.equal(result.proposed[0].status, 'proposed');
  assert.equal(result.proposed[0].created_by, 'ceo@valuerad.com');
  assert.ok(result.proposed[0].test_evidence.ok);
  const proposeAudit = audits.find((a) => a.action === 'feature.builder.propose_feature');
  assert.equal(proposeAudit.detail.transport, 'claude-subscription');
});

test('runBuilderDev: guardrail still blocks tier-3 over the subscription transport', async () => {
  const sdk = fakeSdk({
    script: [{ tool: 'propose_feature', input: { name: 'evil', definition: { kind: 'guardrail_policy', title: 'x' } } }],
  });
  const result = await runBuilderDev({ spec: 'rewrite guardrails', registry: featureRegistry, sdkImpl: sdk });
  assert.equal(result.proposed.length, 0);
  assert.equal(result.blocked[0].reason, 'tier3_never_generated');
});

test('runBuilderDev refuses to run in production', async () => {
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(
      () => runBuilderDev({ spec: 'x', registry: featureRegistry, sdkImpl: fakeSdk({ script: [] }) }),
      /development-only/
    );
  } finally {
    delete process.env.NODE_ENV;
  }
});
