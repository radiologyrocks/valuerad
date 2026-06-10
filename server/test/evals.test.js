import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;

import { runEvalSuite, computeCatalogBaselines, loadBaselines } from '../domain/evals.js';

test('the full eval suite passes against the pinned baselines', () => {
  const { ok, checks } = runEvalSuite();
  assert.equal(ok, true, JSON.stringify(checks.filter((c) => !c.ok)));
  // every layer is represented
  assert.ok(checks.some((c) => c.name.startsWith('metric.')));
  assert.ok(checks.some((c) => c.name.startsWith('catalog.')));
  assert.ok(checks.some((c) => c.name.startsWith('rule_pack.')));
  assert.ok(checks.some((c) => c.name.startsWith('mapper.')));
});

test('pinned baselines are current (re-pin via npm run eval:update after deliberate changes)', () => {
  assert.deepEqual(loadBaselines(), computeCatalogBaselines());
});

test('a shifted catalog output is caught as a regression', () => {
  const tampered = { ...loadBaselines(), 'referrer-scorecard': 'not-the-real-hash' };
  const { ok, checks } = runEvalSuite({ baselines: tampered });
  assert.equal(ok, false);
  const failure = checks.find((c) => c.name === 'catalog.referrer-scorecard');
  assert.equal(failure.ok, false);
  assert.match(failure.detail, /baseline/);
});

test('missing baselines fail loudly instead of passing vacuously', () => {
  const { ok, checks } = runEvalSuite({ baselines: null });
  assert.equal(ok, false);
  assert.ok(checks.some((c) => c.name === 'catalog.baselines_present' && !c.ok));
});

test('catalog baselines are deterministic across runs (volatile fields stripped)', () => {
  assert.deepEqual(computeCatalogBaselines(), computeCatalogBaselines());
});
