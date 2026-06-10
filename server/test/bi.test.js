import { test } from 'node:test';
import assert from 'node:assert/strict';

import { utilization, noShowRate, authPerformance, modalityMix, payerLeakage, executiveSnapshot } from '../domain/bi.js';
import { routeStudy } from '../domain/worklist.js';

test('utilization: used vs total scanner minutes', () => {
  const slots = [
    { durationMin: 30, status: 'completed' },
    { durationMin: 30, status: 'booked' },
    { durationMin: 30, status: 'open' },
    { durationMin: 30, status: 'noshow' },
  ];
  const u = utilization(slots);
  assert.equal(u.utilizationPct, 50);
  assert.equal(u.usedMinutes, 60);
});

test('noShowRate and authPerformance', () => {
  const ns = noShowRate([{ status: 'noshow' }, { status: 'completed' }, { status: 'cancelled' }, { status: 'completed' }]);
  assert.equal(ns.noShowPct, 25);
  assert.equal(ns.cancelPct, 25);

  const auth = authPerformance([{ status: 'approved' }, { status: 'approved' }, { status: 'denied' }, { status: 'pending' }]);
  assert.equal(auth.approvalPct, 50);
  assert.equal(auth.denialPct, 25);
});

test('modalityMix sorts by volume and sums margin', () => {
  const r = modalityMix(
    [{ modality: 'CT' }, { modality: 'CT' }, { modality: 'MR' }],
    { CT: 800, MR: 1200 }
  );
  assert.equal(r.mix[0].modality, 'CT');
  assert.equal(r.mix[0].count, 2);
  assert.equal(r.estimatedMargin, 2800);
});

test('payerLeakage flags underpayers past threshold', () => {
  const rows = payerLeakage(
    [
      { payer: 'Aetna', expected: 1000, paid: 1000 },
      { payer: 'BCBS', expected: 1000, paid: 800 }, // 20% short
    ],
    5
  );
  const bcbs = rows.find((r) => r.payer === 'BCBS');
  assert.equal(bcbs.flagged, true);
  assert.equal(bcbs.shortfallPct, 20);
  const aetna = rows.find((r) => r.payer === 'Aetna');
  assert.equal(aetna.flagged, false);
});

test('executiveSnapshot composes all sections', () => {
  const snap = executiveSnapshot({ slots: [{ durationMin: 30, status: 'booked' }] });
  assert.ok(snap.utilization && snap.noShow && snap.auth && snap.modality && snap.payerLeakage);
  assert.ok(snap.generatedAt);
});

test('routeStudy prefers subspecialty match then load', () => {
  const rads = [
    { id: 'r1', subspecialties: ['neuro'], currentLoad: 5, capacity: 10, onShift: true },
    { id: 'r2', subspecialties: ['msk'], currentLoad: 1, capacity: 10, onShift: true },
  ];
  const a = routeStudy({ modality: 'MR', subspecialty: 'neuro' }, rads);
  assert.equal(a.radiologistId, 'r1');
  assert.equal(a.reason, 'subspecialty_match');

  // No match -> least loaded wins.
  const b = routeStudy({ modality: 'MR', subspecialty: 'body' }, rads);
  assert.equal(b.radiologistId, 'r2');

  // Nobody on shift / at capacity -> null.
  assert.equal(routeStudy({ modality: 'MR' }, [{ id: 'x', currentLoad: 10, capacity: 10, onShift: true }]), null);
});
