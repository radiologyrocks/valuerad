#!/usr/bin/env node
/**
 * The ValueRad MCP surface — the command center as a tool surface for agents.
 *
 * Deliberately a THIN CLIENT over the running HTTP API, not an in-process
 * import: every tool call goes through the same RBAC, guardrail, and audit
 * paths as the dashboard, and shares the running server's state. The MCP
 * layer adds no authority — it only translates.
 *
 * Auth (in order):
 *   - VALUERAD_SERVICE_TOKEN  → `Authorization: Bearer vrad_sp_...`
 *     (a service principal from POST /api/principals — the production path;
 *     the principal's roles bound what this surface can do)
 *   - dev fallback            → X-ValueRad-User/Roles headers
 *     (VALUERAD_DEV_USER / VALUERAD_DEV_ROLES; rejected by the API in prod)
 *
 * Dev loop:
 *   npm run dev                      # the API, port 3001
 *   claude mcp add valuerad -- node server/mcp.js
 *   # then, in Claude Code: "install the referrer scorecard and run it"
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = process.env.VALUERAD_API_BASE ?? 'http://localhost:3001';

function authHeaders() {
  if (process.env.VALUERAD_SERVICE_TOKEN) {
    return { Authorization: `Bearer ${process.env.VALUERAD_SERVICE_TOKEN}` };
  }
  return {
    'X-ValueRad-User': process.env.VALUERAD_DEV_USER ?? 'mcp@valuerad.dev',
    'X-ValueRad-Roles': process.env.VALUERAD_DEV_ROLES ?? 'executive,admin',
  };
}

export async function callApi(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.detail || data?.error || `HTTP ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

const rubricResultsShape = z.array(z.boolean()).optional()
  .describe('grade each outcome-rubric criterion true/false; required when the feature has a rubric');

/**
 * Tool registry — exported for tests; `api` is injected (callApi in prod).
 * Each entry: { description, shape, handler }.
 */
export function buildMcpTools(api = callApi) {
  return {
    list_features: {
      description: 'List living features (name, version, kind, tier, status, rubric, evidence). Filter by kind (report|export|rule_pack|ingest_mapper) or status (proposed|canary|active|retired|rejected).',
      shape: { kind: z.string().optional(), status: z.string().optional() },
      handler: ({ kind, status }) => {
        const q = new URLSearchParams();
        if (kind) q.set('kind', kind);
        if (status) q.set('status', status);
        return api('GET', `/api/features${q.size ? `?${q}` : ''}`);
      },
    },
    request_feature: {
      description: 'Ask the builder agent for a new feature in natural language (report, CSV export, payer rule pack, or ingest mapping). Returns proposed features awaiting human approval — nothing activates automatically.',
      shape: { spec: z.string().describe('what you need, in plain language') },
      handler: ({ spec }) => api('POST', '/api/features/request', { spec }),
    },
    propose_feature: {
      description: 'Propose a hand-written DSL definition directly (validated + golden-tested; lands as proposed).',
      shape: {
        name: z.string(),
        featureKey: z.string().optional(),
        spec: z.string().optional().describe('the request this implements'),
        definition: z.record(z.string(), z.unknown()).describe('the DSL definition object'),
        outcome: z.object({ rubric: z.array(z.string()) }).optional().describe('checkable "done" criteria'),
      },
      handler: (input) => api('POST', '/api/features', input),
    },
    approve_feature: {
      description: 'Approve a feature: tier 1 proposed → active; tier 2 proposed → canary, canary → active (needs a canary report). If the feature has an outcome rubric, rubricResults is required — this records the human grading in the attestation trail.',
      shape: { id: z.number(), rubricResults: rubricResultsShape },
      handler: ({ id, rubricResults }) => api('POST', `/api/features/${id}/approve`, rubricResults ? { rubricResults } : {}),
    },
    canary_feature: {
      description: 'Shadow-evaluate a tier-2 feature in canary: rule packs report auth-decision divergences vs baseline over real order history; mappers dry-run their mapping. Stores the report promotion requires.',
      shape: { id: z.number(), csv: z.string().optional().describe('for mappers: a real export to shadow-map') },
      handler: ({ id, csv }) => api('POST', `/api/features/${id}/canary`, csv ? { csv } : {}),
    },
    run_feature: {
      description: 'Execute an active report/export against the warehouse (or dry-run a mapper). Output respects the definition\'s access roles.',
      shape: { id: z.number(), csv: z.string().optional().describe('for mapper dry-runs') },
      handler: ({ id, csv }) => api('POST', `/api/features/${id}/run`, csv ? { csv } : {}),
    },
    reject_feature: {
      description: 'Reject a proposed/canary feature.',
      shape: { id: z.number(), reason: z.string().optional() },
      handler: ({ id, reason }) => api('POST', `/api/features/${id}/reject`, { reason }),
    },
    retire_feature: {
      description: 'Retire an active feature.',
      shape: { id: z.number(), reason: z.string().optional() },
      handler: ({ id, reason }) => api('POST', `/api/features/${id}/retire`, { reason }),
    },
    rollback_feature: {
      description: 'Roll an active feature back to its prior version (one click, audited, re-attested).',
      shape: { id: z.number() },
      handler: ({ id }) => api('POST', `/api/features/${id}/rollback`, {}),
    },
    get_attestation: {
      description: 'Fetch and verify the signed provenance attestation of an activated feature (content hash, engine version, evidence hash, approver, Ed25519 signature).',
      shape: { id: z.number() },
      handler: ({ id }) => api('GET', `/api/features/${id}/attestation`),
    },
    list_catalog: {
      description: 'List the certified feature catalog (vendor-supported definitions installable into this tenant).',
      shape: {},
      handler: () => api('GET', '/api/features/catalog'),
    },
    install_catalog_feature: {
      description: 'Install a certified catalog definition as a proposed feature (still requires approval).',
      shape: { key: z.string().describe('catalog featureKey') },
      handler: ({ key }) => api('POST', `/api/features/catalog/${encodeURIComponent(key)}/install`, {}),
    },
    run_ops_agent: {
      description: 'Run the guardrailed operations agent (scheduling, eligibility, prior-auth, worklist routing). Defaults to recommend mode: it proposes, never mutates. Returns proposals/executed/blocked.',
      shape: {
        task: z.string().describe('the operational task, in plain language'),
        mode: z.enum(['recommend', 'autonomous']).optional(),
      },
      handler: ({ task, mode }) => api('POST', '/api/agent/run', { task, mode: mode ?? 'recommend' }),
    },
    ceo_report: {
      description: 'The full CEO report from the warehouse: scorecard, denials, A/R, referrals, turnaround, productivity, funnel.',
      shape: {},
      handler: () => api('POST', '/api/bi/report', { source: 'warehouse' }),
    },
    ingest_csv: {
      description: 'Ingest a CSV extract into a warehouse dataset (claims, appointments, studies, slots, referrals, referrals_prior). Optionally through an active ingest_mapper feature.',
      shape: {
        dataset: z.string(),
        csv: z.string(),
        mapper: z.string().optional().describe('featureKey of an active ingest_mapper'),
        replace: z.boolean().optional(),
      },
      handler: ({ dataset, csv, mapper, replace }) =>
        api('POST', '/api/bi/ingest', { dataset, format: 'csv', csv, mapper, replace: replace ?? false }),
    },
    run_evals: {
      description: 'Run the deterministic eval suite: metric coverage, certified-catalog output regression vs pinned baselines, rule-pack and mapper seam coverage.',
      shape: {},
      handler: () => api('GET', '/api/evals'),
    },
    scan_supply: {
      description: 'Scan a supply barcode (GS1/UDI DataMatrix string, bracketed GS1, or plain GTIN) to receive stock in or consume it out. Consumption below the reorder point auto-proposes a gated reorder.',
      shape: {
        code: z.string().describe('the scanned barcode content'),
        action: z.enum(['receive', 'use']).optional().describe('default receive'),
        qty: z.number().int().optional(),
      },
      handler: ({ code, action, qty }) => api('POST', '/api/supplies/scan', { code, action: action ?? 'receive', qty }),
    },
    supply_status: {
      description: 'Inventory dashboard: on-hand, days of supply, items below reorder, expiring lots, and open orders.',
      shape: {},
      handler: () => api('GET', '/api/supplies'),
    },
    propose_supply_orders: {
      description: 'Sweep the shelf: create proposed orders for every item at/below its reorder point (skipping items already on order). Orders await gates/human confirmation.',
      shape: {},
      handler: () => api('POST', '/api/supplies/orders/propose', {}),
    },
    approve_supply_order: {
      description: 'Confirm a proposed supply order (gates re-checked: restricted items and high-dollar totals require this human/principal sign-off; duplicates and budget breaches are blocked).',
      shape: { id: z.number() },
      handler: ({ id }) => api('POST', `/api/supplies/orders/${id}/approve`, {}),
    },
    place_supply_order: {
      description: 'Send an approved supply order to the vendor (enqueues the vendor-integration job).',
      shape: { id: z.number() },
      handler: ({ id }) => api('POST', `/api/supplies/orders/${id}/place`, {}),
    },
  };
}

export function buildServer(api = callApi) {
  const server = new McpServer({ name: 'valuerad', version: '1.0.0' });
  for (const [name, t] of Object.entries(buildMcpTools(api))) {
    server.registerTool(name, { description: t.description, inputSchema: t.shape }, async (input) => {
      try {
        const result = await t.handler(input ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message, ...err.data }) }], isError: true };
      }
    });
  }
  return server;
}

// Start on stdio when run directly (npm run mcp / `claude mcp add`).
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error(`[valuerad-mcp] connected — API ${BASE}, auth ${process.env.VALUERAD_SERVICE_TOKEN ? 'service principal' : 'dev headers'}`);
}
