import { test } from 'node:test';
import assert from 'node:assert/strict';

import { noShowRisk, rankSlots, bestBackfill } from '../domain/scheduling.js';
import { evaluateEligibility } from '../domain/eligibility.js';
import { authRequired, transition, canTransition, safeToPerform, AUTH_STATES } from '../domain/priorauth.js';

// --- scheduling: no-show risk ---
test('noShowRisk: clean patient is low risk', () => {
  const r = noShowRisk({ priorNoShows: 0, leadTimeDays: 5 });
  assert.equal(r.band, 'low');
  assert.ok(r.score < 0.25);
});

test('noShowRisk: history drives high risk and explains why', () => {
  const r = noShowRisk({ priorNoShows: 3, leadTimeDays: 30, confirmedReminder: false });
  assert.equal(r.band, 'high');
  assert.ok(r.factors.some((f) => f.factor === 'prior_no_shows'));
  assert.ok(r.score <= 1);
});

// --- scheduling: slot ranking ---
test('rankSlots: filters by modality and duration, prefers adjacency', () => {
  const slots = [
    { id: 'a', start: '2026-07-01T09:00:00Z', end: '2026-07-01T09:30:00Z', modality: 'MR' },
    { id: 'b', start: '2026-07-01T11:00:00Z', end: '2026-07-01T11:45:00Z', modality: 'MR' },
    { id: 'c', start: '2026-07-01T10:00:00Z', end: '2026-07-01T10:10:00Z', modality: 'MR' }, // too short
    { id: 'd', start: '2026-07-01T09:00:00Z', end: '2026-07-01T09:30:00Z', modality: 'CT' }, // wrong modality
  ];
  const neighbors = [{ start: '2026-07-01T10:30:00Z', end: '2026-07-01T11:00:00Z' }]; // adjacent to b
  const ranked = rankSlots(slots, { modality: 'MR', durationMin: 30 }, neighbors);
  assert.deepEqual(ranked.map((s) => s.id), ['b', 'a']);
  assert.equal(ranked[0].adjacency, 1);
});

// --- scheduling: backfill ---
test('bestBackfill: respects modality, availability, priority, FIFO', () => {
  const open = { start: '2026-07-01T09:00:00Z', end: '2026-07-01T09:30:00Z', modality: 'MR' };
  const waitlist = [
    { patientId: 'p1', modality: 'CT', addedAt: '2026-06-01T00:00:00Z' }, // wrong modality
    { patientId: 'p2', modality: 'MR', priority: 1, addedAt: '2026-06-02T00:00:00Z' },
    { patientId: 'p3', modality: 'MR', priority: 2, addedAt: '2026-06-03T00:00:00Z' }, // higher priority
  ];
  assert.equal(bestBackfill(open, waitlist).patientId, 'p3');
  assert.equal(bestBackfill(open, []), null);
});

// --- eligibility ---
test('evaluateEligibility: active coverage is eligible', () => {
  const cov = { status: 'active', period: { start: '2026-01-01', end: '2026-12-31' } };
  const r = evaluateEligibility(cov, { modality: 'MR' }, new Date('2026-07-01'));
  assert.equal(r.eligible, true);
  assert.equal(r.requiresReview, false);
});

test('evaluateEligibility: missing coverage on high-cost study needs review', () => {
  const r = evaluateEligibility(null, { modality: 'CT' });
  assert.equal(r.eligible, false);
  assert.equal(r.requiresReview, true);
  assert.ok(r.reasons.includes('no_coverage_on_file'));
});

test('evaluateEligibility: expired coverage flagged', () => {
  const cov = { status: 'active', period: { start: '2025-01-01', end: '2025-12-31' } };
  const r = evaluateEligibility(cov, { modality: 'US' }, new Date('2026-07-01'));
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('coverage_expired'));
});

// --- prior auth ---
test('authRequired: high-cost modality needs auth, emergent exempt', () => {
  assert.equal(authRequired({ modality: 'MRI' }, { name: 'Aetna' }).required, true);
  assert.equal(authRequired({ modality: 'MRI', urgency: 'stat' }).required, false);
  assert.equal(authRequired({ modality: 'XR' }).required, false);
});

test('auth state machine: legal and illegal transitions', () => {
  assert.equal(canTransition(AUTH_STATES.DRAFT, AUTH_STATES.SUBMITTED), true);
  assert.equal(canTransition(AUTH_STATES.APPROVED, AUTH_STATES.DENIED), false);

  let auth = { status: AUTH_STATES.DRAFT };
  auth = transition(auth, AUTH_STATES.SUBMITTED);
  auth = transition(auth, AUTH_STATES.PENDING);
  auth = transition(auth, AUTH_STATES.APPROVED);
  assert.equal(auth.status, 'approved');
  assert.equal(auth.history.length, 3);

  assert.throws(() => transition({ status: 'approved' }, 'denied'));
});

test('safeToPerform: blocks unapproved high-cost, allows when not required', () => {
  const req = authRequired({ modality: 'CT' });
  assert.equal(safeToPerform({ authRequiredResult: req, authStatus: AUTH_STATES.PENDING }), false);
  assert.equal(safeToPerform({ authRequiredResult: req, authStatus: AUTH_STATES.APPROVED }), true);
  assert.equal(safeToPerform({ authRequiredResult: authRequired({ modality: 'XR' }) }), true);
});
