/**
 * DEV-ONLY operations-agent transport — Claude subscription auth via the
 * Agent SDK. The companion of builderDev.js, for the runner.
 *
 * The production runner (runner.js) drives a manual loop on the Messages API
 * so the guardrail plane sits between the model and the action plane. Over
 * the Agent SDK, Claude Code drives the loop instead — so the guardrail
 * moves INSIDE each tool handler: every call goes through the exact same
 * executeToolCall (policy evaluate → blocked / proposed / executed) before
 * anything runs. The model cannot mutate in recommend mode on this transport
 * any more than it can on the production one, because the handler won't.
 *
 * Two hard gates beyond builderDev's:
 *   - NEVER with a live EHR session. This transport runs on a personal
 *     Claude subscription with no BAA; if services.fhir is attached, refuse.
 *     Demo/synthetic services only.
 *   - Development only (NODE_ENV=production refuses), per Anthropic's terms.
 */

import { z } from 'zod';
import { TOOLS } from './tools.js';
import { executeToolCall, AGENT_SYSTEM_PROMPT } from './runner.js';

const MCP_SERVER = 'ops';
const MAX_TURNS = 16;

/** Convert a tool's flat JSON input_schema into a zod shape the SDK accepts. */
export function shapeFrom(schema = {}) {
  const required = new Set(schema.required ?? []);
  const shape = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    let t;
    if (Array.isArray(prop.enum)) t = z.enum(prop.enum);
    else if (prop.type === 'integer') t = z.number().int();
    else if (prop.type === 'number') t = z.number();
    else if (prop.type === 'boolean') t = z.boolean();
    else if (prop.type === 'object') t = z.record(z.string(), z.unknown());
    else t = z.string();
    if (prop.description) t = t.describe(prop.description);
    shape[key] = required.has(key) ? t : t.optional();
  }
  return shape;
}

/**
 * Wrap the runner's TOOLS as SDK MCP tools, with the guardrail enforced in
 * the handler. `onRecord` receives every execution record for accounting+audit.
 */
export function buildOpsTools(sdk, { services, mode, ctx }, onRecord) {
  return Object.entries(TOOLS).map(([name, t]) =>
    sdk.tool(name, t.description, shapeFrom(t.input_schema), async (input) => {
      const { result, record } = await executeToolCall({ name, input }, { services, mode, ctx });
      await onRecord(record);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        ...(result?.error ? { isError: true } : {}),
      };
    })
  );
}

async function loadSdk() {
  try {
    return await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    throw new Error('Claude Agent SDK not installed (npm install @anthropic-ai/claude-agent-sdk in server/).');
  }
}

/**
 * Run the operations agent over Claude Code subscription auth.
 * Same contract as runAgent: { summary, proposals, executed, blocked }.
 */
export async function runAgentDev({ task, services = {}, mode = 'recommend', ctx = {}, sdkImpl }) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Subscription-auth agent is development-only; set ANTHROPIC_API_KEY in production.');
  }
  if (services.fhir) {
    throw new Error('Subscription-auth agent cannot attach a live EHR session (no BAA on this transport) — use an API key with a signed BAA, or detach the session.');
  }

  const sdk = sdkImpl ?? (await loadSdk());
  const proposals = [];
  const executed = [];
  const blocked = [];

  const onRecord = async (record) => {
    if (record.outcome === 'executed') executed.push(record);
    else if (record.outcome === 'proposed') proposals.push(record);
    else if (record.outcome === 'blocked') blocked.push(record);
    if (services.store?.audit) {
      await services.store.audit({
        actor: 'agent',
        sessionId: services.sessionId,
        action: `agent.${record.outcome}`,
        resource: record.tool,
        outcome: record.outcome === 'error' ? 'error' : 'success',
        detail: { transport: 'claude-subscription', reason: record.reason, input: record.input },
      });
    }
  };

  const mcpServer = sdk.createSdkMcpServer({
    name: MCP_SERVER,
    version: '1.0.0',
    tools: buildOpsTools(sdk, { services, mode, ctx }, onRecord),
  });

  let summary = '';
  let costUsd = null;
  const response = sdk.query({
    prompt: task,
    options: {
      systemPrompt: AGENT_SYSTEM_PROMPT,
      mcpServers: { [MCP_SERVER]: mcpServer },
      allowedTools: Object.keys(TOOLS).map((n) => `mcp__${MCP_SERVER}__${n}`),
      // The agent's world is exactly the action plane — no files, shell, or web.
      disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite'],
      maxTurns: MAX_TURNS,
      ...(process.env.AGENT_DEV_MODEL ? { model: process.env.AGENT_DEV_MODEL } : {}),
    },
  });

  for await (const message of response) {
    if (message.type === 'result') {
      summary = message.subtype === 'success' ? (message.result ?? '') : `agent ended: ${message.subtype}`;
      if (message.total_cost_usd != null) costUsd = message.total_cost_usd;
    }
  }

  return { summary, proposals, executed, blocked, transport: 'claude-subscription', ...(costUsd != null ? { costUsd } : {}) };
}
