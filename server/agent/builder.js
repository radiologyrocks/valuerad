/**
 * The FEATURE BUILDER — the living-software agent.
 *
 * A sibling of runner.js with one job: turn a natural-language feature request
 * into a validated, golden-tested DSL definition (domain/dsl.js) and register
 * it as a PROPOSED feature. It cannot activate anything — activation is a
 * human decision, every time (domain/feature.js gates it).
 *
 * The no-PHI rule is structural, not behavioral: the builder's tools expose
 * only the metric registry, dataset schema docs, and synthetic golden
 * fixtures. There is no code path from this module to the warehouse or the
 * EHR, which keeps the generation path outside the BAA boundary.
 */

import { METRICS, DSL_DATASETS, ACCESS_ROLES, DEFINITION_KINDS, ENGINE_VERSION, DEFINITION_GUIDE } from '../domain/dsl.js';
import { evaluateFeature, runGoldenTests, classifyTier, contentHash } from '../domain/feature.js';
import { GOLDEN, DATASET_FIELDS } from '../domain/fixtures.js';

const MODEL = process.env.BUILDER_MODEL || process.env.AGENT_MODEL || 'claude-opus-4-8';
const MAX_ITERATIONS = 10;

export const BUILDER_SYSTEM_PROMPT = `You are the feature builder for ValueRad, a radiology command center.
A user describes a report, export, payer rule pack, or CSV ingest mapping they need; you compose a declarative
definition for the platform's trusted engine. You never write code — only definition data, which the engine
validates, tests against synthetic fixtures, and a human must approve before it touches real data.

Process:
1. Call list_metrics to see the metric library and dataset schemas.
2. If unsure about field shapes, call sample_synthetic_data (these rows are synthetic; you never see real data).
3. Draft a definition and call validate_definition. Fix any errors it reports and validate again.
4. When validation passes, call propose_feature exactly once with the final definition and an outcome
   rubric: 2-5 short, checkable statements of what "done" looks like for this request (e.g. "shows denied
   dollars per payer", "only includes MR studies"). The approver grades the feature against them.

Rules:
- Prefer the simplest definition that answers the request. Reports for analysis; exports when they ask for CSV/files.
- rule_pack and ingest_mapper are Tier 2 (they configure platform behavior) — only build one when explicitly asked.
- ingest_mapper definitions must include a small sampleCsv with the source's real header names.
- Set access.roles to the narrowest sensible audience (default executive+admin).
- If the request needs data or capabilities the engine doesn't have, do NOT force a wrong definition — explain what's missing instead.
End with one short paragraph: what you proposed and what it shows.`;

/** Tolerate definitions arriving as JSON strings (some transports stringify objects). */
function coerceDefinition(definition) {
  if (typeof definition !== 'string') return definition;
  try {
    return JSON.parse(definition);
  } catch {
    return definition;
  }
}

export const BUILDER_TOOLS = {
  list_metrics: {
    kind: 'read',
    description: 'List the metric library (the entire instruction set of the definition engine), the definition format with worked examples, the datasets each metric consumes, dataset field docs, definition kinds, and allowed access roles. ALWAYS call this before drafting a definition.',
    input_schema: { type: 'object', properties: {} },
    async handler() {
      return {
        engineVersion: ENGINE_VERSION,
        kinds: DEFINITION_KINDS,
        definitionFormat: DEFINITION_GUIDE,
        datasets: DATASET_FIELDS,
        accessRoles: ACCESS_ROLES,
        metrics: Object.fromEntries(
          Object.entries(METRICS).map(([name, m]) => [name, { datasets: m.datasets, describe: m.describe }])
        ),
      };
    },
  },

  sample_synthetic_data: {
    kind: 'read',
    description: 'Return synthetic fixture rows for a dataset (claims, studies, slots, appointments, auths, referrals, referrals_prior). These are the golden test fixtures — never real data.',
    input_schema: {
      type: 'object',
      properties: { dataset: { type: 'string', description: `one of: ${DSL_DATASETS.join(', ')}` } },
      required: ['dataset'],
    },
    async handler({ input }) {
      const rows = GOLDEN[input.dataset];
      if (!rows) return { error: `unknown dataset "${input.dataset}"` };
      return { dataset: input.dataset, synthetic: true, rows: rows.slice(0, 10) };
    },
  },

  validate_definition: {
    kind: 'read',
    description: 'Validate a draft definition and run it against the golden fixtures. Returns tier classification, validation errors, and test evidence. Iterate until ok.',
    input_schema: {
      type: 'object',
      properties: { definition: { type: 'object', description: 'the draft DSL definition' } },
      required: ['definition'],
    },
    async handler({ input }) {
      const definition = coerceDefinition(input.definition);
      const decision = evaluateFeature(definition);
      if (!decision.allow) return { ok: false, ...decision };
      const evidence = runGoldenTests(definition);
      return { ok: evidence.ok, tier: decision.tier, evidence };
    },
  },

  propose_feature: {
    kind: 'write',
    description: 'Register the final definition as a PROPOSED feature awaiting human approval. Only call once, after validate_definition reports ok. Include an outcome rubric: 2-5 short, checkable statements of what "done" looks like, derived from the request — the human approver grades against them.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'short human-readable feature name' },
        featureKey: { type: 'string', description: 'stable kebab-case identity; new version if it already exists' },
        definition: { type: 'object' },
        outcome: {
          type: 'object',
          properties: { rubric: { type: 'array', items: { type: 'string' }, description: 'checkable "done" criteria' } },
        },
      },
      required: ['name', 'definition'],
    },
    async handler({ input, services }) {
      return proposeFeature({
        name: input.name,
        featureKey: input.featureKey,
        definition: input.definition,
        outcome: input.outcome,
        spec: services.spec,
        createdBy: services.createdBy ?? 'builder-agent',
        registry: services.registry,
      });
    },
  },
};

export function builderToolSchemas() {
  return Object.entries(BUILDER_TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'feature';
}

/**
 * The single choke point that creates a registry row — used by the builder's
 * propose_feature tool AND the manual POST /api/features route, so generated
 * and hand-written features go through identical guardrails and evidence.
 */
export async function proposeFeature({ name, featureKey, definition, spec, outcome, createdBy, registry }) {
  definition = coerceDefinition(definition);
  const decision = evaluateFeature(definition);
  if (!decision.allow) {
    return { proposed: false, blocked: true, reason: decision.reason, errors: decision.errors ?? [] };
  }
  const evidence = runGoldenTests(definition);
  if (!evidence.ok) {
    return { proposed: false, blocked: true, reason: 'golden_tests_failed', evidence };
  }
  // Outcome = the rubric the approver grades against ("what does done look
  // like"). Normalized to { rubric: [string] }; invalid shapes are dropped,
  // not fatal — a missing rubric just means the approver grades unaided.
  const rubric = Array.isArray(outcome?.rubric)
    ? outcome.rubric.filter((r) => typeof r === 'string' && r.trim()).slice(0, 20)
    : null;
  const key = featureKey ? slugify(featureKey) : slugify(name);
  const version = (await registry.maxVersion(key)) + 1;
  const feature = await registry.create({
    feature_key: key,
    version,
    name,
    kind: definition.kind,
    tier: classifyTier(definition),
    spec: spec ?? null,
    outcome: rubric?.length ? { rubric } : null,
    definition,
    status: 'proposed',
    content_hash: contentHash(definition),
    engine_version: ENGINE_VERSION,
    created_by: createdBy ?? null,
    test_evidence: evidence,
    history: [{ from: null, to: 'proposed', at: new Date().toISOString(), by: createdBy ?? null }],
  });
  return { proposed: true, feature };
}

/**
 * Run the builder on a feature request.
 * @returns {{ summary, proposed: [feature], blocked: [record] }}
 */
export async function runBuilder({ spec, client, registry, store, createdBy }) {
  if (!client) throw new Error('Anthropic client not configured (set ANTHROPIC_API_KEY).');

  const services = { spec, registry, createdBy };
  const messages = [{ role: 'user', content: `Feature request:\n${spec}` }];
  const proposed = [];
  const blocked = [];
  let summary = '';

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: BUILDER_SYSTEM_PROMPT,
      tools: builderToolSchemas(),
      messages,
    });

    const text = (response.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (text) summary = text;

    if (response.stop_reason === 'refusal') {
      return { summary: text || 'refused', proposed, blocked, refused: true };
    }
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }

    const toolUses = (response.content ?? []).filter((b) => b.type === 'tool_use');
    if (response.stop_reason === 'end_turn' || toolUses.length === 0) break;

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const block of toolUses) {
      const tool = BUILDER_TOOLS[block.name];
      let result;
      if (!tool) {
        result = { error: `unknown tool ${block.name}` };
      } else {
        try {
          result = await tool.handler({ input: block.input, services });
        } catch (err) {
          result = { error: err.message };
        }
      }

      if (result?.proposed && result.feature) proposed.push(result.feature);
      if (result?.blocked) blocked.push({ tool: block.name, reason: result.reason, errors: result.errors });

      if (store?.audit) {
        await store.audit({
          actor: createdBy ?? 'builder-agent',
          action: `feature.builder.${block.name}`,
          resource: result?.feature ? `living_feature/${result.feature.id}` : null,
          outcome: result?.error || result?.blocked ? 'error' : 'success',
          detail: result?.blocked ? { reason: result.reason } : null,
        });
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
        ...(result?.error ? { is_error: true } : {}),
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return { summary, proposed, blocked };
}
