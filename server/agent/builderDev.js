/**
 * DEV-ONLY builder transport — Claude subscription auth via the Agent SDK.
 *
 * The production builder (builder.js) calls the Messages API with an
 * ANTHROPIC_API_KEY (pay-per-token). For development, a Claude Pro/Max
 * subscription can drive the same builder through the Claude Agent SDK,
 * which uses Claude Code's login (run `claude /login` once; keep
 * ANTHROPIC_API_KEY unset — a set key overrides subscription auth).
 *
 * Only the TRANSPORT changes. The four builder tools are exposed as
 * in-process MCP tools wrapping the exact same handlers, every proposal
 * still funnels through proposeFeature (guardrails + golden tests), the
 * builder still cannot activate anything, and it still never sees real
 * data. Built-in Claude Code tools (file/bash/web) are disallowed so the
 * agent's world is exactly the four builder tools.
 *
 * Subscription auth is for personal development only (Anthropic ToS: no
 * serving third parties) — index.js-level guards aside, runBuilderDev
 * refuses to run in NODE_ENV=production.
 */

import { z } from 'zod';
import { BUILDER_TOOLS, BUILDER_SYSTEM_PROMPT } from './builder.js';
import { DSL_DATASETS } from '../domain/dsl.js';

const MCP_SERVER = 'builder';
const MAX_TURNS = 16;

// Zod shapes mirroring each builder tool's input_schema. `definition` must
// advertise a real object type — an untyped `z.any()` led the model to send
// JSON strings (the handlers coerce those too, belt and suspenders).
const definitionShape = z
  .union([z.record(z.string(), z.unknown()), z.string()])
  .describe('the DSL definition as a JSON object (see list_metrics → definitionFormat)');

const TOOL_SHAPES = {
  list_metrics: {},
  sample_synthetic_data: { dataset: z.string().describe(`one of: ${DSL_DATASETS.join(', ')}`) },
  validate_definition: { definition: definitionShape },
  propose_feature: {
    name: z.string().describe('short human-readable feature name'),
    featureKey: z.string().optional().describe('stable kebab-case identity'),
    definition: definitionShape,
  },
};

/**
 * Wrap BUILDER_TOOLS as in-process SDK MCP tools. `onResult` sees every
 * (toolName, result) so the caller can collect proposals/blocked and audit —
 * the same accounting runBuilder does.
 */
export function buildSdkTools(sdk, services, onResult) {
  return Object.entries(BUILDER_TOOLS).map(([name, t]) =>
    sdk.tool(name, t.description, TOOL_SHAPES[name] ?? {}, async (input) => {
      let result;
      try {
        result = await t.handler({ input, services });
      } catch (err) {
        result = { error: err.message };
      }
      await onResult(name, result);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(result?.error ? { isError: true } : {}) };
    })
  );
}

async function loadSdk() {
  try {
    return await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    throw new Error(
      'Claude Agent SDK not installed (npm install @anthropic-ai/claude-agent-sdk in server/).'
    );
  }
}

/**
 * Run the builder over Claude Code subscription auth.
 * Same contract as runBuilder: { summary, proposed, blocked } (+ costUsd when reported).
 * @param {object} opts - { spec, registry, store, createdBy, sdkImpl? (injected for tests) }
 */
export async function runBuilderDev({ spec, registry, store, createdBy, sdkImpl }) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Subscription-auth builder is development-only; set ANTHROPIC_API_KEY in production.');
  }

  const sdk = sdkImpl ?? (await loadSdk());
  const services = { spec, registry, createdBy };
  const proposed = [];
  const blocked = [];

  const onResult = async (toolName, result) => {
    if (result?.proposed && result.feature) proposed.push(result.feature);
    if (result?.blocked) blocked.push({ tool: toolName, reason: result.reason, errors: result.errors });
    if (store?.audit) {
      await store.audit({
        actor: createdBy ?? 'builder-agent',
        action: `feature.builder.${toolName}`,
        resource: result?.feature ? `living_feature/${result.feature.id}` : null,
        outcome: result?.error || result?.blocked ? 'error' : 'success',
        detail: { transport: 'claude-subscription', ...(result?.blocked ? { reason: result.reason } : {}) },
      });
    }
  };

  const mcpServer = sdk.createSdkMcpServer({
    name: MCP_SERVER,
    version: '1.0.0',
    tools: buildSdkTools(sdk, services, onResult),
  });

  const toolNames = Object.keys(BUILDER_TOOLS).map((n) => `mcp__${MCP_SERVER}__${n}`);

  let summary = '';
  let costUsd = null;
  const response = sdk.query({
    prompt: `Feature request:\n${spec}`,
    options: {
      systemPrompt: BUILDER_SYSTEM_PROMPT,
      mcpServers: { [MCP_SERVER]: mcpServer },
      allowedTools: toolNames,
      // The builder's world is exactly its four tools — no files, shell, or web.
      disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite'],
      maxTurns: MAX_TURNS,
      ...(process.env.BUILDER_DEV_MODEL ? { model: process.env.BUILDER_DEV_MODEL } : {}),
    },
  });

  for await (const message of response) {
    if (message.type === 'result') {
      if (message.subtype === 'success') summary = message.result ?? '';
      else summary = `builder ended: ${message.subtype}`;
      if (message.total_cost_usd != null) costUsd = message.total_cost_usd;
    }
  }

  return { summary, proposed, blocked, transport: 'claude-subscription', ...(costUsd != null ? { costUsd } : {}) };
}
