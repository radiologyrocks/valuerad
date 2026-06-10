import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;

import {
  classifyTier, evaluateFeature, FEATURE_STATES, canTransitionFeature,
  transitionFeature, canActivate, contentHash, runGoldenTests, rulePackCanary,
} from '../domain/feature.js';
import { CATALOG } from '../domain/catalog.js';
import { GOLDEN } from '../domain/fixtures.js';
import { featureRegistry } from '../lib/features.js';
import { proposeFeature } from '../agent/builder.js';
import { authRequired } from '../domain/priorauth.js';

const REPORT_DEF = {
  kind: 'report',
  title: 'Referrer scorecard',
  blocks: [{ id: 'r', metric: 'referralAnalytics' }],
};

const RULE_PACK_DEF = {
  kind: 'rule_pack',
  title: 'Medicare rules',
  payerRules: { Medicare: { exempt: ['CT', 'MR'] } },
};

// ---- tier policy (the feature guardrail) ----
test('tier classification: declarative=1, config seams=2, everything else=3', () => {
  assert.equal(classifyTier({ kind: 'report' }), 1);
  assert.equal(classifyTier({ kind: 'export' }), 1);
  assert.equal(classifyTier({ kind: 'rule_pack' }), 2);
  assert.equal(classifyTier({ kind: 'ingest_mapper' }), 2);
  assert.equal(classifyTier({ kind: 'guardrail_policy' }), 3);
  assert.equal(classifyTier({}), 3);
});

test('evaluateFeature allows tier 1/2, denies invalid and tier 3', () => {
  assert.equal(evaluateFeature(REPORT_DEF).allow, true);
  assert.equal(evaluateFeature(RULE_PACK_DEF).allow, true);

  const invalid = evaluateFeature({ kind: 'report', title: 'x', blocks: [{ id: 'a', metric: 'nope' }] });
  assert.equal(invalid.allow, false);
  assert.equal(invalid.reason, 'invalid_definition');

  const tier3 = evaluateFeature({ kind: 'fhir_writer', title: 'x' });
  assert.equal(tier3.allow, false);
});

// ---- lifecycle state machine ----
test('lifecycle transitions: legal paths allowed, illegal throw', () => {
  assert.ok(canTransitionFeature('proposed', 'active'));
  assert.ok(canTransitionFeature('proposed', 'canary'));
  assert.ok(canTransitionFeature('canary', 'active'));
  assert.ok(canTransitionFeature('active', 'retired'));
  assert.ok(canTransitionFeature('retired', 'active')); // rollback
  assert.ok(!canTransitionFeature('rejected', 'active'));
  assert.ok(!canTransitionFeature('active', 'proposed'));

  const f = { status: 'proposed', history: [] };
  const updated = transitionFeature(f, 'active', { by: 'tester' });
  assert.equal(updated.status, 'active');
  assert.equal(updated.history.length, 1);
  assert.equal(updated.history[0].by, 'tester');

  assert.throws(() => transitionFeature({ status: 'rejected' }, 'active'), /illegal feature transition/);
});

test('canActivate: tier1 needs passing evidence; tier2 needs canary report; retired can roll back', () => {
  const evidence = runGoldenTests(REPORT_DEF);
  assert.equal(canActivate({ tier: 1, status: 'proposed', test_evidence: evidence }).ok, true);
  assert.equal(canActivate({ tier: 1, status: 'proposed', test_evidence: null }).ok, false);

  const packEvidence = runGoldenTests(RULE_PACK_DEF);
  assert.equal(canActivate({ tier: 2, status: 'canary', test_evidence: packEvidence }).ok, false); // no canary report yet
  const withCanary = { ...packEvidence, canary: { totalOrders: 8, divergentOrders: 2 } };
  assert.equal(canActivate({ tier: 2, status: 'canary', test_evidence: withCanary }).ok, true);

  assert.equal(canActivate({ tier: 1, status: 'retired' }).ok, true);
});

// ---- attestation ----
test('contentHash is deterministic and key-order independent', () => {
  const a = contentHash({ kind: 'report', title: 'x', blocks: [] });
  const b = contentHash({ blocks: [], title: 'x', kind: 'report' });
  assert.equal(a, b);
  assert.notEqual(a, contentHash({ kind: 'report', title: 'y', blocks: [] }));
});

// ---- golden harness ----
test('runGoldenTests produces a passing evidence bundle for valid definitions', () => {
  const evidence = runGoldenTests(REPORT_DEF);
  assert.equal(evidence.ok, true);
  assert.ok(evidence.engineVersion);
  assert.ok(evidence.snapshotHash);
  assert.ok(evidence.checks.every((c) => c.ok));
});

test('runGoldenTests fails an export that produces zero rows', () => {
  const def = {
    kind: 'export', title: 'never matches',
    blocks: [{ id: 'd', metric: 'denialAnalytics', filters: [{ dataset: 'claims', field: 'payer', op: 'eq', value: 'NoSuchPayer' }] }],
    output: { format: 'csv', from: 'd.byPayer', columns: [{ header: 'P', path: 'payer' }] },
  };
  assert.equal(runGoldenTests(def).ok, false);
});

test('runGoldenTests requires sampleCsv evidence for ingest mappers', () => {
  const def = { kind: 'ingest_mapper', title: 'x', dataset: 'claims', columns: { A: 'payer' } };
  assert.equal(runGoldenTests(def).ok, false);
  const withSample = { ...def, sampleCsv: 'A\nAetna\n' };
  assert.equal(runGoldenTests(withSample).ok, true);
});

test('every catalog entry is valid and passes golden tests', () => {
  for (const entry of CATALOG) {
    const decision = evaluateFeature(entry.definition);
    assert.equal(decision.allow, true, `${entry.featureKey} allowed`);
    const evidence = runGoldenTests(entry.definition);
    assert.equal(evidence.ok, true, `${entry.featureKey} golden: ${JSON.stringify(evidence.checks)}`);
  }
});

// ---- rule packs (Phase C) ----
test('authRequired honors rule pack exemptions and additions', () => {
  // baseline: MR requires auth
  assert.equal(authRequired({ modality: 'MR' }, { name: 'Medicare' }).required, true);
  // pack exempts it
  assert.deepEqual(
    authRequired({ modality: 'MR' }, { name: 'Medicare' }, RULE_PACK_DEF),
    { required: false, reason: 'rule_pack_exempt' }
  );
  // pack can require auth where defaults don't
  const usPack = { payerRules: { Aetna: { require: ['US'] } } };
  assert.deepEqual(
    authRequired({ modality: 'US' }, { name: 'Aetna' }, usPack),
    { required: true, reason: 'rule_pack_required' }
  );
  // emergent always wins
  assert.equal(authRequired({ modality: 'MR', urgency: 'stat' }, { name: 'Medicare' }, RULE_PACK_DEF).required, false);
  // other payers unaffected
  assert.equal(authRequired({ modality: 'MR' }, { name: 'Aetna' }, RULE_PACK_DEF).required, true);
});

test('rulePackCanary reports decision divergences vs baseline', () => {
  const orders = GOLDEN.claims.filter((c) => c.payer && c.modality).map((c) => ({ payer: c.payer, modality: c.modality }));
  const report = rulePackCanary(RULE_PACK_DEF, orders);
  assert.equal(report.totalOrders, orders.length);
  // golden claims include one Medicare CT → exempted by the pack → divergent
  assert.ok(report.divergentOrders >= 1);
  const div = report.divergences.find((d) => d.payer === 'Medicare' && d.modality === 'CT');
  assert.ok(div);
  assert.equal(div.baseline.required, true);
  assert.equal(div.withPack.required, false);
});

// ---- registry + the propose choke point ----
test('proposeFeature registers a versioned, evidenced, proposed row', async () => {
  const r1 = await proposeFeature({
    name: 'Referrer scorecard', definition: REPORT_DEF, spec: 'show me referrers',
    createdBy: 'tester', registry: featureRegistry,
  });
  assert.equal(r1.proposed, true);
  assert.equal(r1.feature.status, 'proposed');
  assert.equal(r1.feature.tier, 1);
  assert.equal(r1.feature.version, 1);
  assert.ok(r1.feature.content_hash);
  assert.equal(r1.feature.test_evidence.ok, true);

  // same key again → version 2
  const r2 = await proposeFeature({
    name: 'Referrer scorecard', definition: { ...REPORT_DEF, title: 'Referrer scorecard v2' },
    createdBy: 'tester', registry: featureRegistry,
  });
  assert.equal(r2.feature.version, 2);
  assert.equal(r2.feature.feature_key, r1.feature.feature_key);
});

test('proposeFeature captures and normalizes the outcome rubric', async () => {
  const withRubric = await proposeFeature({
    name: 'Rubric demo', definition: REPORT_DEF, spec: 'show referrers',
    outcome: { rubric: ['shows top referrers', '  ', 'compares to prior period', 42] },
    createdBy: 'tester', registry: featureRegistry,
  });
  assert.deepEqual(withRubric.feature.outcome, { rubric: ['shows top referrers', 'compares to prior period'] });

  const without = await proposeFeature({
    name: 'No rubric demo', definition: REPORT_DEF,
    createdBy: 'tester', registry: featureRegistry,
  });
  assert.equal(without.feature.outcome, null);
});

test('proposeFeature blocks invalid and tier-3 definitions', async () => {
  const invalid = await proposeFeature({
    name: 'bad', definition: { kind: 'report', title: 'x', blocks: [{ id: 'a', metric: 'nope' }] },
    createdBy: 'tester', registry: featureRegistry,
  });
  assert.equal(invalid.proposed, false);
  assert.equal(invalid.blocked, true);

  const tier3 = await proposeFeature({
    name: 'evil', definition: { kind: 'guardrail_policy', title: 'x' },
    createdBy: 'tester', registry: featureRegistry,
  });
  assert.equal(tier3.proposed, false);
  assert.equal(tier3.reason, 'tier3_never_generated');
});

test('registry update + list support the activate/retire/rollback flow', async () => {
  const { feature: v1 } = await proposeFeature({
    name: 'Rollback demo', featureKey: 'rollback-demo', definition: REPORT_DEF,
    createdBy: 'tester', registry: featureRegistry,
  });
  const { feature: v2 } = await proposeFeature({
    name: 'Rollback demo', featureKey: 'rollback-demo', definition: { ...REPORT_DEF, title: 'v2' },
    createdBy: 'tester', registry: featureRegistry,
  });

  // activate v1, then replace with v2 (v1 retired), then roll back to v1
  await featureRegistry.update(v1.id, transitionFeature(v1, FEATURE_STATES.ACTIVE));
  let active = await featureRegistry.list({ featureKey: 'rollback-demo', status: 'active' });
  assert.equal(active[0].version, 1);

  await featureRegistry.update(v1.id, transitionFeature({ ...v1, status: 'active' }, FEATURE_STATES.RETIRED));
  await featureRegistry.update(v2.id, transitionFeature(v2, FEATURE_STATES.ACTIVE));
  active = await featureRegistry.list({ featureKey: 'rollback-demo', status: 'active' });
  assert.equal(active.length, 1);
  assert.equal(active[0].version, 2);

  // rollback: retired → active is a legal transition
  const retired = await featureRegistry.get(v1.id);
  const restored = transitionFeature(retired, FEATURE_STATES.ACTIVE, { rollbackOf: 'v2' });
  assert.equal(restored.status, 'active');
  assert.equal(restored.history.at(-1).rollbackOf, 'v2');
});
