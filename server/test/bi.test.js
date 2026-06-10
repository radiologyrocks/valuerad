import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  utilization, noShowRate, authPerformance, modalityMix, payerLeakage, executiveSnapshot,
  denialAnalytics, arAging, referralAnalytics, turnaroundTime, productivity, schedulingFunnel,
  scorecard, exceptions, ceoReport,
} from '../domain/bi.js';
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

test('denialAnalytics: rate, dollars, prior-auth share, by reason/payer', () => {
  const claims = [
    { status: 'paid', payer: 'Aetna', expected: 1000 },
    { status: 'denied', payer: 'Aetna', expected: 1200, denialReason: 'No prior auth' },
    { status: 'denied', payer: 'BCBS', expected: 800, denialReason: 'Coding error' },
  ];
  const d = denialAnalytics(claims);
  assert.equal(d.denialPct, 66.7);
  assert.equal(d.deniedDollars, 2000);
  assert.equal(d.priorAuthDenialPct, 50);
  assert.equal(d.byReason[0].dollars, 1200); // auth denial is the biggest
});

test('arAging: buckets, net collection, clean-claim rate', () => {
  const claims = [
    { status: 'paid', expected: 1000, paid: 1000, arDays: 20 },
    { status: 'paid', expected: 1000, paid: 800, arDays: 75 },
    { status: 'denied', expected: 1000, paid: 0, arDays: 120 },
  ];
  const ar = arAging(claims);
  assert.equal(ar.buckets['0-30'], 1);
  assert.equal(ar.buckets['90+'], 1);
  assert.equal(ar.netCollectionPct, 60); // 1800 / 3000
  assert.equal(ar.cleanClaimPct, 66.7);
});

test('referralAnalytics: leakage, concentration, new/lapsed', () => {
  const prior = [
    { referrerId: 'r1', referrerName: 'Dr A' }, { referrerId: 'r1' }, { referrerId: 'r1' },
    { referrerId: 'r2', referrerName: 'Dr B' },
  ];
  const current = [
    { referrerId: 'r1', referrerName: 'Dr A' }, // dropped 3 -> 1
    { referrerId: 'r3', referrerName: 'Dr C' }, // new
  ];
  const r = referralAnalytics(current, prior);
  assert.equal(r.leakageCount, 2); // r1 dropped, r2 lapsed to 0
  assert.ok(r.leakage.find((x) => x.id === 'r1').dropPct > 0);
  assert.equal(r.newCount, 1);
});

test('turnaroundTime: avg/median hours and SLA', () => {
  const studies = [
    { modality: 'CT', orderedAt: '2026-06-01T00:00:00Z', finalAt: '2026-06-01T12:00:00Z' }, // 12h
    { modality: 'CT', orderedAt: '2026-06-01T00:00:00Z', finalAt: '2026-06-02T12:00:00Z' }, // 36h
  ];
  const t = turnaroundTime(studies, 24);
  assert.equal(t.avgHours, 24);
  assert.equal(t.withinSlaPct, 50);
});

test('productivity: RVUs per radiologist', () => {
  const p = productivity([
    { radiologistId: 'r1', rvu: 1.5 }, { radiologistId: 'r1', rvu: 2 }, { radiologistId: 'r2', rvu: 1 },
  ]);
  assert.equal(p.totalRvu, 4.5);
  assert.equal(p.byRadiologist[0].id, 'r1');
});

test('schedulingFunnel: stage conversion', () => {
  const f = schedulingFunnel({
    appointments: [{ status: 'completed' }, { status: 'completed' }, { status: 'cancelled' }, { status: 'arrived' }],
    studies: [{ finalAt: 'x' }, {}, {}, {}],
    claims: [{}, {}],
  });
  assert.equal(f[0].stage, 'ordered');
  assert.equal(f.find((s) => s.stage === 'billed').count, 2);
});

test('scorecard: KPIs carry target/variance/status and exceptions surface breaches', () => {
  const sc = scorecard({
    slots: [{ durationMin: 30, status: 'open' }, { durationMin: 30, status: 'open' }], // 0% util -> breach
    appointments: [{ status: 'completed' }],
    claims: [{ status: 'denied', expected: 100, paid: 0 }], // 100% denial -> breach
    auths: [{ status: 'approved' }],
    studies: [],
  });
  const util = sc.kpis.find((k) => k.key === 'utilizationPct');
  assert.equal(util.status, 'breach');
  assert.ok(sc.exceptions.length >= 1);
  assert.equal(sc.exceptions[0].severity, 'high');
});

test('ceoReport composes snapshot + scorecard + deep dives', () => {
  const r = ceoReport({ claims: [{ status: 'denied', expected: 100 }], studies: [], appointments: [] });
  assert.ok(r.snapshot && r.scorecard && r.denials && r.ar && r.referrals && r.turnaround && r.productivity && r.funnel);
});

test('exceptions: empty when all KPIs ok', () => {
  assert.deepEqual(exceptions([{ key: 'x', status: 'ok' }]), []);
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
