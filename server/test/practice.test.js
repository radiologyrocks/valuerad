import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPracticeConfig, buildModel, computePnL, projectScenario, applyScenario, sampleVolume } from '../domain/practice.js';

function model() {
  const config = defaultPracticeConfig('CT');
  return buildModel(config, sampleVolume(config));
}

test('defaultPracticeConfig is CT and customizable', () => {
  const c = defaultPracticeConfig('CT');
  assert.equal(c.state, 'CT');
  assert.equal(c.defaultComponent, '26');
  assert.ok(c.payers.Medicaid_CT && c.payers.WorkersComp_CT);
});

test('buildModel produces a populated hypergraph', () => {
  const m = model();
  assert.ok(m.graph.nodesOfType('examType').length > 0);
  assert.ok(m.graph.edgesOfType('volume').length > 0);
  assert.ok(m.graph.edgesOfType('capacity').length > 0);
});

test('computePnL returns a coherent P&L', () => {
  const pnl = computePnL(model());
  assert.ok(pnl.revenue > 0);
  // net is computed from unrounded internals, so allow sub-cent rounding drift.
  assert.ok(Math.abs(pnl.net - (pnl.revenue - pnl.variableCost - pnl.fixedCost)) < 0.02);
  assert.ok(pnl.wRvu > 0);
  assert.ok(pnl.byPayer.length > 0 && pnl.byModality.length > 0);
});

test('scenario: renegotiating a payer up raises net income', () => {
  const m = model();
  const r = projectScenario(m, [{ op: 'setContract', payer: 'Aetna', rate: { type: 'pct_of_medicare', pct: 160 } }]);
  assert.ok(r.projected.net > r.baseline.net);
  assert.ok(r.delta.net > 0);
});

test('scenario: dropping a high-volume payer lowers revenue', () => {
  const m = model();
  const r = projectScenario(m, [{ op: 'dropPayer', payer: 'Aetna' }]);
  assert.ok(r.projected.revenue < r.baseline.revenue);
});

test('scenario: adding scanner capacity recovers capacity-lost revenue', () => {
  const config = defaultPracticeConfig('CT');
  // Force a capacity constraint: tiny MR capacity, big MR demand.
  config.scanners = [{ id: 'mr1', site: 'main', modality: 'MR', minutesPerDay: 30, daysPerMonth: 22, fixedCostMonthly: 32000 }];
  const volume = [{ code: '70553', payer: 'Aetna', monthlyVolume: 400 }];
  const m = buildModel(config, volume);
  const base = computePnL(m);
  assert.ok(base.lostRevenueToCapacity > 0, 'should be capacity-constrained');

  const r = projectScenario(m, [{ op: 'addScanner', scanner: { id: 'mr2', site: 'main', modality: 'MR', minutesPerDay: 600, daysPerMonth: 22, fixedCostMonthly: 32000 } }]);
  assert.ok(r.projected.revenue > base.revenue);
});

test('applyScenario does not mutate the baseline model', () => {
  const m = model();
  const before = m.graph.edgesOfType('volume').length;
  applyScenario(m, [{ op: 'dropPayer', payer: 'Aetna' }]);
  assert.equal(m.graph.edgesOfType('volume').length, before);
});
