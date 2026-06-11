/**
 * The ORCHESTRATION PLANE — the agent's nervous system.
 *
 * A manual agentic loop (not the auto tool-runner) because every mutation must
 * pass the guardrail plane and be audited, and because the default posture is
 * human-in-the-loop "recommend" mode. The model reasons and proposes tool calls;
 * policy approves/denies; the runner executes reads and (in autonomous mode)
 * approved writes, recording everything.
 *
 * Uses the latest Claude model with adaptive thinking. Gated behind
 * ANTHROPIC_API_KEY; a client can be injected for testing without the network.
 */

import { TOOLS, toolSchemas } from './tools.js';
import { evaluate, shouldExecute } from './policy.js';
import { evaluateEligibility } from '../domain/eligibility.js';

/**
 * Build the AUTHORITATIVE policy context for a tool call from verified system
 * state (services) — never from client- or model-supplied input. This is the
 * security boundary that makes the auth/eligibility interlock real: the model
 * can propose a booking, but it cannot assert that an auth is approved or that
 * coverage is eligible. Returns only trusted fields; the runner discards any
 * client-supplied authStatus/eligibility.
 */
export async function deriveTrustedCtx(name, input = {}, services = {}) {
  if (name !== 'book_appointment') return {};
  const auth = services.auths?.[input.orderId] ?? null;
  let eligibility = null;
  try {
    const coverageBundle = services.fhir && input.patientId ? await services.fhir.coverage(input.patientId) : null;
    const coverage = coverageBundle?.entry?.[0]?.resource ?? services.coverage ?? null;
    if (coverage) eligibility = evaluateEligibility(coverage, { modality: input.modality });
  } catch {
    eligibility = null; // unverifiable coverage fails closed in policy
  }
  return {
    authStatus: auth?.status ?? 'none',
    authorizedModality: auth?.modality ?? null,
    eligibility,
  };
}

const MODEL = process.env.AGENT_MODEL || 'claude-opus-4-8';
const MAX_ITERATIONS = 12;

export const AGENT_SYSTEM_PROMPT = `You are the operations agent for a radiology practice's command center.
Your job is to run scheduling, insurance approvals, and worklist routing efficiently while protecting revenue and patients.

Operating rules:
- Always verify insurance eligibility before booking a high-cost study (MR, CT, PET, NM), and confirm prior authorization is approved when required. The platform will block unsafe bookings — do not try to work around it; escalate instead.
- Optimize for scanner utilization (fill the most expensive idle capacity), shorter time-to-care, and fewer no-shows.
- For minor choices, pick a reasonable option and note it. For scope changes, denials, or anything a guardrail blocks, call escalate_to_human rather than guessing.
- When a write action is proposed but not executed (recommend mode), explain clearly what you would do and why, so a human can approve quickly.
Be concise. Summarize what you did or recommend at the end.`;

function toToolResult(toolUseId, value, isError = false) {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: typeof value === 'string' ? value : JSON.stringify(value),
    ...(isError ? { is_error: true } : {}),
  };
}

/**
 * Execute one tool call through the guardrail plane.
 * Returns { result, record } where record describes what happened (for audit).
 * Exported so alternate transports (runnerDev.js) enforce the identical policy.
 */
export async function executeToolCall(block, { services, mode, ctx }) {
  const tool = TOOLS[block.name];
  if (!tool) {
    return { result: { error: `unknown tool ${block.name}` }, record: { tool: block.name, outcome: 'unknown_tool' } };
  }

  // Authoritative context: take ONLY the server-derived rulePack from ctx and
  // the trusted, services-derived auth/eligibility — never client-supplied
  // authStatus/eligibility (which a caller could forge to bypass the gate).
  const trusted = await deriveTrustedCtx(block.name, block.input, services);
  const decision = evaluate(block.name, block.input, { mode, rulePack: ctx?.rulePack ?? null, ...trusted });

  if (!decision.allow) {
    return {
      result: { blocked: true, reason: decision.reason },
      record: { tool: block.name, outcome: 'blocked', reason: decision.reason, input: block.input },
    };
  }

  if (tool.kind === 'write' && !shouldExecute(decision, mode)) {
    // Proposed, not executed — awaits human approval.
    return {
      result: { proposed: true, requiresHumanApproval: decision.requiresHumanApproval, reason: decision.reason, action: block.name, input: block.input },
      record: { tool: block.name, outcome: 'proposed', reason: decision.reason, input: block.input },
    };
  }

  try {
    const result = await tool.handler({ input: block.input, services });
    return { result, record: { tool: block.name, outcome: 'executed', input: block.input } };
  } catch (err) {
    return { result: { error: err.message }, record: { tool: block.name, outcome: 'error', reason: err.message } };
  }
}

/**
 * Run the agent on a task.
 * @param {object} opts
 * @param {string} opts.task           natural-language instruction
 * @param {object} opts.client         Anthropic client (or injected fake)
 * @param {object} opts.services       scheduling/fhir/store/queue + domain data
 * @param {'recommend'|'autonomous'} opts.mode
 * @param {object} opts.ctx            policy context (eligibility, authStatus)
 * @returns {{ summary, proposals, executed, blocked, transcript }}
 */
export async function runAgent({ task, client, services = {}, mode = 'recommend', ctx = {} }) {
  if (!client) throw new Error('Anthropic client not configured (set ANTHROPIC_API_KEY).');

  const messages = [{ role: 'user', content: task }];
  const proposals = [];
  const executed = [];
  const blocked = [];
  let summary = '';

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: AGENT_SYSTEM_PROMPT,
      tools: toolSchemas(),
      messages,
    });

    // Capture any final text.
    const text = (response.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (text) summary = text;

    if (response.stop_reason === 'refusal') {
      return { summary: text || 'refused', proposals, executed, blocked, refused: true };
    }

    // Server-side tool pause — resend to continue.
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }

    const toolUses = (response.content ?? []).filter((b) => b.type === 'tool_use');
    if (response.stop_reason === 'end_turn' || toolUses.length === 0) {
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const block of toolUses) {
      const { result, record } = await executeToolCall(block, { services, mode, ctx });
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
          detail: { reason: record.reason, input: record.input },
        });
      }

      toolResults.push(toToolResult(block.id, result, result?.error != null));
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return { summary, proposals, executed, blocked };
}

/** Lazily construct a real Anthropic client; null if no API key. */
export async function createClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic();
}
