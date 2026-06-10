/**
 * Living-feature lifecycle, tier policy, and golden-test harness.
 *
 * The guardrail plane for generated software, mirroring agent/policy.js:
 * a definition PROPOSES; this module DISPOSES. Three pure pieces:
 *
 *   1. Tier classification + evaluateFeature — what may be generated at all.
 *      Tier 1 (report/export) is declarative and read-only; Tier 2
 *      (rule_pack/ingest_mapper) configures a platform seam and must pass
 *      canary before activation; everything else is Tier 3 and is NEVER
 *      user- or model-generated.
 *   2. A lifecycle state machine (same pattern as domain/priorauth.js), with
 *      history retained for the audit trail.
 *   3. runGoldenTests — every feature earns evidence on synthetic fixtures
 *      before a human can approve it. No evidence, no activation.
 */

import { createHash } from 'node:crypto';
import { validateDefinition, executeDefinition, applyMapper, ENGINE_VERSION } from './dsl.js';
import { authRequired } from './priorauth.js';
import { GOLDEN } from './fixtures.js';
import { parseCsv } from '../lib/csv.js';

// ---------------------------------------------------------------------------
// Tier policy — the feature guardrail
// ---------------------------------------------------------------------------

const TIER_BY_KIND = { report: 1, export: 1, rule_pack: 2, ingest_mapper: 2 };

export function classifyTier(definition = {}) {
  return TIER_BY_KIND[definition.kind] ?? 3;
}

/**
 * @returns {{ allow: boolean, tier: number, reason: string, errors?: string[] }}
 */
export function evaluateFeature(definition) {
  const tier = classifyTier(definition);
  if (tier === 3) return { allow: false, tier, reason: 'tier3_never_generated' };
  const errors = validateDefinition(definition);
  if (errors.length) return { allow: false, tier, reason: 'invalid_definition', errors };
  return { allow: true, tier, reason: tier === 1 ? 'tier1_declarative_read_only' : 'tier2_constrained_config' };
}

// ---------------------------------------------------------------------------
// Lifecycle state machine
// ---------------------------------------------------------------------------

export const FEATURE_STATES = Object.freeze({
  PROPOSED: 'proposed',   // generated/created, golden evidence attached
  CANARY: 'canary',       // Tier 2 only: approved into shadow evaluation
  ACTIVE: 'active',
  RETIRED: 'retired',
  REJECTED: 'rejected',
});

const TRANSITIONS = {
  proposed: ['active', 'canary', 'rejected'],
  canary: ['active', 'retired', 'rejected'],
  active: ['retired'],
  retired: ['active'], // rollback re-activates a prior version
  rejected: [],
};

export function canTransitionFeature(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** Apply a transition, returning {status, history} updates or throwing on an illegal move. */
export function transitionFeature(feature, to, detail = {}) {
  const from = feature.status ?? FEATURE_STATES.PROPOSED;
  if (!canTransitionFeature(from, to)) {
    throw new Error(`illegal feature transition ${from} -> ${to}`);
  }
  return {
    status: to,
    history: [...(feature.history ?? []), { from, to, at: new Date().toISOString(), ...detail }],
  };
}

/**
 * May this feature become active right now?
 * Tier 1: from proposed, with passing golden evidence.
 * Tier 2: from canary, with passing golden evidence AND a canary report.
 * Any tier: from retired (rollback re-activation).
 */
export function canActivate(feature) {
  if (feature.status === FEATURE_STATES.RETIRED) return { ok: true, reason: 'rollback' };
  if (!feature.test_evidence?.ok) return { ok: false, reason: 'no_passing_golden_evidence' };
  if (feature.tier === 1 && feature.status === FEATURE_STATES.PROPOSED) return { ok: true, reason: 'tier1_approved' };
  if (feature.tier === 2 && feature.status === FEATURE_STATES.CANARY) {
    if (!feature.test_evidence?.canary) return { ok: false, reason: 'canary_report_required' };
    return { ok: true, reason: 'tier2_promoted_from_canary' };
  }
  return { ok: false, reason: `cannot activate from status "${feature.status}" at tier ${feature.tier}` };
}

// ---------------------------------------------------------------------------
// Attestation primitives
// ---------------------------------------------------------------------------

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Deterministic content hash of a definition — the identity in every attestation record. */
export function contentHash(definition) {
  return createHash('sha256').update(stableStringify(definition)).digest('hex');
}

// ---------------------------------------------------------------------------
// Golden-test harness
// ---------------------------------------------------------------------------

function check(name, fn) {
  try {
    const detail = fn();
    return { name, ok: true, ...(detail ? { detail } : {}) };
  } catch (err) {
    return { name, ok: false, detail: err.message };
  }
}

/**
 * Run a definition against the synthetic golden fixtures and produce the
 * evidence bundle stored in the registry. Never touches real data.
 */
export function runGoldenTests(definition, fixtures = GOLDEN) {
  const checks = [];
  const errors = validateDefinition(definition);
  checks.push({ name: 'schema_valid', ok: errors.length === 0, ...(errors.length ? { detail: errors.join('; ') } : {}) });

  if (errors.length === 0) {
    if (definition.kind === 'report' || definition.kind === 'export') {
      checks.push(check('executes_on_golden_fixtures', () => {
        const result = executeDefinition(definition, fixtures);
        if (definition.kind === 'export' && result.rowCount === 0) throw new Error('export produced zero rows on fixtures');
        return definition.kind === 'export' ? `rows=${result.rowCount}` : `blocks=${Object.keys(result.blocks).length}`;
      }));
    }
    if (definition.kind === 'rule_pack') {
      checks.push(check('decides_on_golden_orders', () => {
        const orders = goldenOrders(fixtures);
        for (const o of orders) authRequired(o, { name: o.payer }, definition);
        return `orders=${orders.length}`;
      }));
    }
    if (definition.kind === 'ingest_mapper') {
      checks.push(check('maps_sample_csv', () => {
        if (!definition.sampleCsv) throw new Error('ingest_mapper needs sampleCsv for golden evidence');
        const mapped = applyMapper(definition, parseCsv(definition.sampleCsv));
        if (mapped.length === 0) throw new Error('mapper produced zero rows from sampleCsv');
        const fields = Object.keys(mapped[0] ?? {});
        if (fields.length === 0) throw new Error('mapper produced rows with no mapped fields');
        return `rows=${mapped.length} fields=${fields.join('|')}`;
      }));
    }
  }

  const ok = checks.every((c) => c.ok);
  const snapshot = checks.map((c) => `${c.name}:${c.ok}${c.detail ? `:${c.detail}` : ''}`).join('\n');
  return {
    engineVersion: ENGINE_VERSION,
    ranAt: new Date().toISOString(),
    ok,
    checks,
    snapshotHash: createHash('sha256').update(snapshot).digest('hex'),
  };
}

/** Derive a synthetic order matrix (modality × payer) from fixture claims. */
function goldenOrders(fixtures = GOLDEN) {
  return (fixtures.claims ?? [])
    .filter((c) => c.payer && c.modality)
    .map((c) => ({ modality: c.modality, payer: c.payer }));
}

/**
 * Canary for rule packs: shadow-evaluate the pack against real (or fixture)
 * order history and report every decision divergence from the baseline rules.
 * Promotion to active requires this report in evidence — the divergences are
 * exactly what a human signs off on.
 */
export function rulePackCanary(definition, orders = []) {
  const byCombo = new Map();
  let divergent = 0;
  for (const o of orders) {
    const payer = { name: o.payer };
    const base = authRequired(o, payer);
    const packed = authRequired(o, payer, definition);
    if (base.required !== packed.required) {
      divergent += 1;
      const key = `${o.payer}|${String(o.modality).toUpperCase()}`;
      const entry = byCombo.get(key) ?? {
        payer: o.payer,
        modality: String(o.modality).toUpperCase(),
        baseline: base,
        withPack: packed,
        count: 0,
      };
      entry.count += 1;
      byCombo.set(key, entry);
    }
  }
  const total = orders.length;
  return {
    ranAt: new Date().toISOString(),
    totalOrders: total,
    divergentOrders: divergent,
    divergencePct: total > 0 ? Number(((divergent / total) * 100).toFixed(1)) : 0,
    divergences: [...byCombo.values()].sort((a, b) => b.count - a.count),
  };
}

export { ENGINE_VERSION };
