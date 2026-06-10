/**
 * Living-feature endpoints — the lifecycle API for user-requested,
 * system-built features (docs/LIVING_SOFTWARE.md).
 *
 *   GET  /api/features                    list (any staff role)
 *   GET  /api/features/catalog            certified catalog
 *   POST /api/features/catalog/:key/install  install a certified definition (proposed)
 *   POST /api/features                    propose a hand-written definition
 *   POST /api/features/request            natural-language request → builder agent (503 without key)
 *   POST /api/features/:id/approve        tier 1: → active · tier 2: → canary, then → active
 *   POST /api/features/:id/canary         rule packs: shadow-evaluate vs warehouse, store divergence report
 *   POST /api/features/:id/reject
 *   POST /api/features/:id/retire
 *   POST /api/features/:id/rollback       re-activate the prior version of this feature
 *   POST /api/features/:id/run            execute a report/export (or dry-run a mapper)
 *   POST /api/features/revalidate         re-run golden tests on every active feature (upgrade gate)
 *
 * Every transition is an audit_log row — the feature writes its own
 * change-management paperwork.
 */

import { Router } from 'express';
import { requireRole, ROLES } from '../lib/rbac.js';
import { store } from '../lib/store.js';
import { featureRegistry, featureRegistryBackend } from '../lib/features.js';
import { loadDatasets, warehouse } from '../lib/warehouse.js';
import { parseCsv } from '../lib/csv.js';
import { executeDefinition, applyMapper, ENGINE_VERSION } from '../domain/dsl.js';
import {
  FEATURE_STATES, transitionFeature, canActivate, runGoldenTests, rulePackCanary,
} from '../domain/feature.js';
import { attestFeature, verifyAttestation, attestationMode } from '../lib/attest.js';
import { runEvalSuite } from '../domain/evals.js';
import { CATALOG, catalogEntry } from '../domain/catalog.js';
import { proposeFeature, runBuilder } from '../agent/builder.js';
import { runBuilderDev } from '../agent/builderDev.js';
import { createClient } from '../agent/runner.js';

const router = Router();
const staff = requireRole(ROLES.SCHEDULER, ROLES.AUTH_SPECIALIST, ROLES.RADIOLOGIST, ROLES.ADMIN, ROLES.EXECUTIVE);
const approver = requireRole(ROLES.ADMIN, ROLES.EXECUTIVE);

function publicFeature(f) {
  return {
    id: f.id,
    featureKey: f.feature_key,
    version: f.version,
    name: f.name,
    kind: f.kind,
    tier: f.tier,
    spec: f.spec,
    outcome: f.outcome,
    definition: f.definition,
    attestation: f.attestation,
    status: f.status,
    contentHash: f.content_hash,
    engineVersion: f.engine_version,
    createdBy: f.created_by,
    approvedBy: f.approved_by,
    testEvidence: f.test_evidence,
    history: f.history,
  };
}

async function audit(req, action, feature, detail = {}, outcome = 'success') {
  await store.audit({
    actor: req.user?.id ?? 'system',
    action,
    resource: feature ? `living_feature/${feature.feature_key}@v${feature.version}` : null,
    outcome,
    detail: { hash: feature?.content_hash, ...detail },
  });
}

async function applyTransition(req, res, feature, to, detail = {}, patch = {}) {
  const updates = transitionFeature(feature, to, { by: req.user?.id, ...detail });
  const updated = await featureRegistry.update(feature.id, { ...updates, ...patch });
  await audit(req, `feature.${to}`, updated, detail);
  return res.json({ feature: publicFeature(updated) });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

router.get('/features', staff, async (req, res) => {
  try {
    const { kind, status } = req.query;
    const rows = await featureRegistry.list({ kind, status });
    return res.json({ backend: featureRegistryBackend, engineVersion: ENGINE_VERSION, features: rows.map(publicFeature) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/features/catalog', staff, (_req, res) => {
  return res.json({ catalog: CATALOG });
});

// ---------------------------------------------------------------------------
// Propose — hand-written, from catalog, or via the builder agent. All three
// funnel through the same proposeFeature choke point (guardrail + golden tests).
// ---------------------------------------------------------------------------

router.post('/features', approver, async (req, res) => {
  const { name, featureKey, spec, outcome, definition } = req.body ?? {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name (string) is required' });
  if (definition == null || typeof definition !== 'object') return res.status(400).json({ error: 'definition (object) is required' });

  try {
    const result = await proposeFeature({ name, featureKey, definition, spec, outcome, createdBy: req.user.id, registry: featureRegistry });
    if (!result.proposed) {
      await audit(req, 'feature.blocked', null, { name, reason: result.reason, errors: result.errors }, 'error');
      return res.status(422).json({ error: result.reason, errors: result.errors ?? [], evidence: result.evidence });
    }
    await audit(req, 'feature.proposed', result.feature, { source: 'manual' });
    return res.status(201).json({ feature: publicFeature(result.feature) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/features/catalog/:key/install', approver, async (req, res) => {
  const entry = catalogEntry(req.params.key);
  if (!entry) return res.status(404).json({ error: 'unknown catalog feature' });
  try {
    const result = await proposeFeature({
      name: entry.definition.title,
      featureKey: entry.featureKey,
      definition: entry.definition,
      spec: entry.spec,
      createdBy: req.user.id,
      registry: featureRegistry,
    });
    if (!result.proposed) return res.status(422).json({ error: result.reason, errors: result.errors ?? [] });
    await audit(req, 'feature.proposed', result.feature, { source: 'catalog', certified: true });
    return res.status(201).json({ feature: publicFeature(result.feature) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/features/request', approver, async (req, res) => {
  const { spec } = req.body ?? {};
  if (!spec || typeof spec !== 'string') return res.status(400).json({ error: 'spec (string) is required' });

  let client = null;
  try {
    client = await createClient();
    let result;
    if (client) {
      result = await runBuilder({ spec, client, registry: featureRegistry, store, createdBy: req.user.id });
    } else if (process.env.NODE_ENV !== 'production') {
      // Dev fallback: no API key → run over Claude Code subscription auth
      // (Agent SDK). Dev-only per Anthropic ToS; production requires a key.
      result = await runBuilderDev({ spec, registry: featureRegistry, store, createdBy: req.user.id });
    } else {
      return res.status(503).json({ error: 'builder_unavailable', detail: 'ANTHROPIC_API_KEY is not configured.' });
    }
    return res.json({
      summary: result.summary,
      proposed: result.proposed.map(publicFeature),
      blocked: result.blocked,
      ...(result.transport ? { transport: result.transport } : {}),
      ...(result.costUsd != null ? { costUsd: result.costUsd } : {}),
      ...(result.refused ? { refused: true } : {}),
    });
  } catch (err) {
    console.error('[features] builder error:', err.message);
    if (client) return res.status(500).json({ error: 'builder_error', detail: err.message });
    return res.status(503).json({
      error: 'builder_unavailable',
      detail: `${err.message} — set ANTHROPIC_API_KEY, or for development run \`claude /login\` with a Claude Pro/Max subscription and leave the key unset.`,
    });
  }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function load(req, res) {
  const feature = await featureRegistry.get(req.params.id);
  if (!feature) {
    res.status(404).json({ error: 'feature not found' });
    return null;
  }
  return feature;
}

router.post('/features/:id/approve', approver, async (req, res) => {
  try {
    const feature = await load(req, res);
    if (!feature) return;

    // Tier 2 first approval sends it to canary, not active.
    if (feature.tier === 2 && feature.status === FEATURE_STATES.PROPOSED) {
      if (!feature.test_evidence?.ok) return res.status(422).json({ error: 'no_passing_golden_evidence' });
      return applyTransition(req, res, feature, FEATURE_STATES.CANARY, {}, { approved_by: req.user.id });
    }

    const gate = canActivate(feature);
    if (!gate.ok) return res.status(422).json({ error: gate.reason });

    // If the request captured an outcome rubric, activation requires the
    // approver to grade it — that review is part of the attestation trail.
    let outcomeReview = null;
    const rubric = feature.outcome?.rubric;
    if (Array.isArray(rubric) && rubric.length > 0) {
      const results = req.body?.rubricResults;
      if (!Array.isArray(results) || results.length !== rubric.length) {
        return res.status(422).json({
          error: 'rubric_review_required',
          detail: `pass rubricResults: [boolean] (length ${rubric.length}) grading each criterion`,
          rubric,
        });
      }
      outcomeReview = {
        rubric,
        results: results.map(Boolean),
        satisfiedCount: results.filter(Boolean).length,
        reviewedBy: req.user.id,
        reviewedAt: new Date().toISOString(),
      };
    }

    // One active version per feature_key: retire the sibling being replaced.
    const siblings = await featureRegistry.list({ featureKey: feature.feature_key, status: FEATURE_STATES.ACTIVE });
    for (const s of siblings.filter((s) => s.id !== feature.id)) {
      const updates = transitionFeature(s, FEATURE_STATES.RETIRED, { by: req.user.id, replacedBy: `v${feature.version}` });
      await featureRegistry.update(s.id, updates);
      await audit(req, 'feature.retired', s, { replacedBy: `v${feature.version}` });
    }

    // Sign the activation: the attestation binds content hash, engine,
    // evidence, and approver into a verifiable provenance record.
    const attestation = attestFeature({ ...feature, approved_by: req.user.id });
    return applyTransition(
      req, res, feature, FEATURE_STATES.ACTIVE,
      { gate: gate.reason, ...(outcomeReview ? { outcomeSatisfied: `${outcomeReview.satisfiedCount}/${rubric.length}` } : {}) },
      {
        approved_by: req.user.id,
        attestation,
        ...(outcomeReview ? { test_evidence: { ...feature.test_evidence, outcomeReview } } : {}),
      }
    );
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/features/:id/attestation', staff, async (req, res) => {
  try {
    const feature = await load(req, res);
    if (!feature) return;
    if (!feature.attestation) return res.status(404).json({ error: 'feature has no attestation (never activated)' });
    return res.json({
      attestation: feature.attestation,
      verified: verifyAttestation(feature.attestation),
      signingMode: attestationMode,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/features/:id/canary', approver, async (req, res) => {
  try {
    const feature = await load(req, res);
    if (!feature) return;
    if (feature.status !== FEATURE_STATES.CANARY) return res.status(422).json({ error: 'feature is not in canary' });

    let report;
    if (feature.kind === 'rule_pack') {
      // Shadow-evaluate against real order history (warehouse claims carry
      // payer+modality) or an explicit order list from the body.
      let orders = Array.isArray(req.body?.orders) ? req.body.orders : null;
      if (!orders) {
        const claims = await warehouse.query('claims');
        orders = claims.filter((c) => c.payer && c.modality).map((c) => ({ payer: c.payer, modality: c.modality }));
      }
      if (orders.length === 0) return res.status(422).json({ error: 'no_orders_to_shadow', detail: 'ingest claims (with payer+modality) or pass orders[]' });
      report = rulePackCanary(feature.definition, orders);
    } else if (feature.kind === 'ingest_mapper') {
      // A mapper's canary is a shadow dry-run: map a real export (or the
      // sample) without ingesting anything, so a human reviews the result.
      const csv = req.body?.csv ?? feature.definition.sampleCsv ?? '';
      const mapped = applyMapper(feature.definition, parseCsv(csv));
      if (mapped.length === 0) return res.status(422).json({ error: 'no_rows_to_shadow', detail: 'pass csv (a real export) or define sampleCsv' });
      report = {
        ranAt: new Date().toISOString(),
        rows: mapped.length,
        fields: Object.keys(mapped[0] ?? {}),
        preview: mapped.slice(0, 5),
      };
    } else {
      return res.status(400).json({ error: 'canary shadow-evaluation applies to tier-2 features (rule packs, ingest mappers)' });
    }

    const updated = await featureRegistry.update(feature.id, {
      test_evidence: { ...feature.test_evidence, canary: report },
    });
    await audit(req, 'feature.canary_evaluated', updated, { kind: feature.kind });
    return res.json({ feature: publicFeature(updated), canary: report });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/features/:id/reject', approver, async (req, res) => {
  try {
    const feature = await load(req, res);
    if (!feature) return;
    return await applyTransition(req, res, feature, FEATURE_STATES.REJECTED, { reason: req.body?.reason });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/features/:id/retire', approver, async (req, res) => {
  try {
    const feature = await load(req, res);
    if (!feature) return;
    return await applyTransition(req, res, feature, FEATURE_STATES.RETIRED, { reason: req.body?.reason });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/features/:id/rollback', approver, async (req, res) => {
  try {
    const feature = await load(req, res);
    if (!feature) return;
    if (feature.status !== FEATURE_STATES.ACTIVE) return res.status(422).json({ error: 'only an active feature can be rolled back' });

    const versions = await featureRegistry.list({ featureKey: feature.feature_key, status: FEATURE_STATES.RETIRED });
    const prior = versions.filter((v) => v.version < feature.version).sort((a, b) => b.version - a.version)[0];
    if (!prior) return res.status(422).json({ error: 'no_prior_version_to_roll_back_to' });

    const retire = transitionFeature(feature, FEATURE_STATES.RETIRED, { by: req.user.id, rolledBackTo: `v${prior.version}` });
    await featureRegistry.update(feature.id, retire);
    await audit(req, 'feature.retired', feature, { rolledBackTo: `v${prior.version}` });

    const activate = transitionFeature(prior, FEATURE_STATES.ACTIVE, { by: req.user.id, rollbackOf: `v${feature.version}` });
    const restored = await featureRegistry.update(prior.id, {
      ...activate,
      approved_by: req.user.id,
      attestation: attestFeature({ ...prior, approved_by: req.user.id }),
    });
    await audit(req, 'feature.active', restored, { rollbackOf: `v${feature.version}` });
    return res.json({ feature: publicFeature(restored), rolledBack: `v${feature.version}` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

router.post('/features/:id/run', staff, async (req, res) => {
  try {
    const feature = await load(req, res);
    if (!feature) return;

    // Approvers may preview a proposed/canary feature; everyone else needs active.
    const isApprover = req.user.roles.some((r) => [ROLES.ADMIN, ROLES.EXECUTIVE].includes(r));
    if (feature.status !== FEATURE_STATES.ACTIVE && !isApprover) {
      return res.status(403).json({ error: 'feature is not active' });
    }

    // Output RBAC comes from the definition itself; admins always pass.
    const allowedRoles = feature.definition?.access?.roles ?? [ROLES.EXECUTIVE, ROLES.ADMIN];
    if (!isApprover && !req.user.roles.some((r) => allowedRoles.includes(r))) {
      return res.status(403).json({ error: 'insufficient role for this feature' });
    }

    if (feature.kind === 'ingest_mapper') {
      // Dry-run preview only — real application happens via POST /api/bi/ingest {mapper}.
      const csv = req.body?.csv ?? feature.definition.sampleCsv ?? '';
      const mapped = applyMapper(feature.definition, parseCsv(csv));
      await audit(req, 'feature.executed', feature, { dryRun: true, rows: mapped.length });
      return res.json({ dryRun: true, dataset: feature.definition.dataset, rows: mapped.slice(0, 50), rowCount: mapped.length });
    }
    if (feature.kind === 'rule_pack') {
      return res.status(400).json({ error: 'rule packs are not run directly — they apply to agent auth decisions; use /canary to shadow-evaluate' });
    }

    const datasets = req.body?.source === 'inline' ? (req.body?.datasets ?? {}) : await loadDatasets();
    if (req.body?.auths) datasets.auths = req.body.auths;
    const result = executeDefinition(feature.definition, datasets);
    await audit(req, 'feature.executed', feature, { kind: feature.kind });
    return res.json({ result, feature: { id: feature.id, name: feature.name, version: feature.version, status: feature.status } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Upgrade gate — re-run golden tests on every active feature against the
// current engine. Failures are flagged (and audited), never silently retired.
// ---------------------------------------------------------------------------

// The deterministic eval suite (metric coverage, catalog output regression,
// seam coverage) — the deeper layer under golden tests. See domain/evals.js.
router.get('/evals', approver, async (req, res) => {
  try {
    const result = runEvalSuite();
    await audit(req, result.ok ? 'evals.passed' : 'evals.failed', null, {
      passed: result.checks.filter((c) => c.ok).length,
      total: result.checks.length,
    }, result.ok ? 'success' : 'error');
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/features/revalidate', approver, async (req, res) => {
  try {
    const active = await featureRegistry.list({ status: FEATURE_STATES.ACTIVE });
    const results = [];
    for (const feature of active) {
      const evidence = runGoldenTests(feature.definition);
      const updated = await featureRegistry.update(feature.id, {
        test_evidence: { ...feature.test_evidence, ...evidence, canary: feature.test_evidence?.canary },
        engine_version: ENGINE_VERSION,
      });
      await audit(req, evidence.ok ? 'feature.revalidated' : 'feature.revalidation_failed', updated, { engineVersion: ENGINE_VERSION }, evidence.ok ? 'success' : 'error');
      results.push({ id: feature.id, featureKey: feature.feature_key, version: feature.version, ok: evidence.ok });
    }
    return res.json({ engineVersion: ENGINE_VERSION, checked: results.length, failures: results.filter((r) => !r.ok), results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export { router as featuresRouter };
