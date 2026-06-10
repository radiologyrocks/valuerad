import { test } from 'node:test';
import assert from 'node:assert/strict';
import { medicareAllowed, applyMppr, resolvePayerAllowed, estimatePayment, SAMPLE_RVUS, defaultGeography } from '../domain/reimbursement.js';

const geo = defaultGeography('CT');

test('medicareAllowed scales with RVUs, GPCI, and conversion factor', () => {
  const row = SAMPLE_RVUS['70553'];
  const pc = medicareAllowed(row, { component: '26', pos: 'facility', ...geo });
  assert.ok(pc > 0);
  // Professional component should be less than global for the same code.
  const global = medicareAllowed(row, { component: 'global', pos: 'facility', ...geo });
  assert.ok(global > pc);
});

test('MPPR reduces subsequent procedures (PC -5%, TC -50%)', () => {
  assert.equal(applyMppr(100, { rank: 1, component: '26' }), 100);
  assert.equal(applyMppr(100, { rank: 2, component: '26' }), 95);
  assert.equal(applyMppr(100, { rank: 2, component: 'TC' }), 50);
});

test('payer rate resolution: pct of medicare and fee schedule', () => {
  assert.equal(resolvePayerAllowed({ type: 'pct_of_medicare', pct: 130 }, 100).allowed, 130);
  assert.equal(resolvePayerAllowed({ type: 'fee_schedule', amount: 88 }, 100).allowed, 88);
  assert.equal(resolvePayerAllowed({ type: 'medicare' }, 100).allowed, 100);
});

test('estimatePayment returns wRVU + allowed; commercial pays above Medicare', () => {
  const config = { state: 'CT', defaultComponent: '26', payers: { Aetna: { rate: { type: 'pct_of_medicare', pct: 130 } } } };
  const med = estimatePayment({ code: '74177' }, { config, payer: 'Medicare' });
  const aetna = estimatePayment({ code: '74177' }, { config, payer: 'Aetna' });
  assert.equal(med.wRvu, SAMPLE_RVUS['74177'].wRvu);
  assert.ok(aetna.allowed > med.allowed);
  assert.equal(aetna.source, 'pct_of_medicare(130%)');
});

test('unknown code is handled gracefully', () => {
  const r = estimatePayment({ code: '99999' }, { config: { state: 'CT' } });
  assert.equal(r.source, 'unknown_code');
  assert.equal(r.allowed, 0);
});
