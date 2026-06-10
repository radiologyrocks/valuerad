/**
 * Golden fixtures — the synthetic datasets every living feature is tested
 * against before it can be activated, and the ONLY data the builder agent is
 * ever shown.
 *
 * Deliberately small, deterministic, and PHI-free. Real warehouse rows never
 * reach the model: the builder composes definitions against these fixtures and
 * the schema docs below; generated definitions then execute server-side, under
 * RBAC, against real data. That separation is what keeps the generation path
 * outside the BAA boundary.
 */

export const GOLDEN = Object.freeze({
  slots: [
    { durationMin: 45, status: 'completed', modality: 'MR' },
    { durationMin: 45, status: 'completed', modality: 'MR' },
    { durationMin: 45, status: 'booked', modality: 'MR' },
    { durationMin: 45, status: 'open', modality: 'MR' },
    { durationMin: 30, status: 'completed', modality: 'CT' },
    { durationMin: 30, status: 'noshow', modality: 'CT' },
    { durationMin: 30, status: 'open', modality: 'CT' },
    { durationMin: 20, status: 'completed', modality: 'US' },
  ],
  appointments: [
    { status: 'completed' }, { status: 'completed' }, { status: 'completed' },
    { status: 'completed' }, { status: 'arrived' }, { status: 'noshow' },
    { status: 'cancelled' }, { status: 'booked' },
  ],
  auths: [
    { status: 'approved' }, { status: 'approved' }, { status: 'approved' },
    { status: 'denied' }, { status: 'pending' },
  ],
  studies: [
    { modality: 'MR', orderedAt: '2026-06-01T08:00:00Z', finalAt: '2026-06-01T20:00:00Z', radiologistId: 'rad-neuro', rvu: 2.5 },
    { modality: 'MR', orderedAt: '2026-06-01T09:00:00Z', finalAt: '2026-06-02T15:00:00Z', radiologistId: 'rad-neuro', rvu: 2.5 },
    { modality: 'CT', orderedAt: '2026-06-01T10:00:00Z', finalAt: '2026-06-01T18:00:00Z', radiologistId: 'rad-body', rvu: 1.8 },
    { modality: 'CT', orderedAt: '2026-06-02T10:00:00Z', finalAt: '2026-06-02T14:00:00Z', radiologistId: 'rad-body', rvu: 1.8 },
    { modality: 'US', orderedAt: '2026-06-02T11:00:00Z', finalAt: '2026-06-02T13:00:00Z', radiologistId: 'rad-body', rvu: 0.7 },
    { modality: 'XR', orderedAt: '2026-06-03T11:00:00Z', finalAt: '2026-06-03T12:00:00Z', radiologistId: 'rad-msk', rvu: 0.3 },
  ],
  claims: [
    { payer: 'Aetna', status: 'paid', expected: 1200, paid: 1200, arDays: 22, denialReason: '', modality: 'MR' },
    { payer: 'Aetna', status: 'paid', expected: 800, paid: 760, arDays: 35, denialReason: '', modality: 'CT' },
    { payer: 'BCBS', status: 'denied', expected: 1200, paid: 0, arDays: 95, denialReason: 'No prior auth', modality: 'MR' },
    { payer: 'BCBS', status: 'paid', expected: 800, paid: 640, arDays: 48, denialReason: '', modality: 'CT' },
    { payer: 'Cigna', status: 'paid', expected: 250, paid: 250, arDays: 18, denialReason: '', modality: 'US' },
    { payer: 'Cigna', status: 'denied', expected: 3000, paid: 0, arDays: 70, denialReason: 'Not medically necessary', modality: 'PET' },
    { payer: 'Medicare', status: 'paid', expected: 600, paid: 600, arDays: 25, denialReason: '', modality: 'CT' },
    { payer: 'Medicare', status: 'paid', expected: 80, paid: 80, arDays: 15, denialReason: '', modality: 'XR' },
  ],
  referrals: [
    { referrerId: 'r1', referrerName: 'Dr. Adams' },
    { referrerId: 'r1', referrerName: 'Dr. Adams' },
    { referrerId: 'r2', referrerName: 'Dr. Brooks' },
    { referrerId: 'r4', referrerName: 'Dr. Diaz' },
  ],
  referrals_prior: [
    { referrerId: 'r1', referrerName: 'Dr. Adams' },
    { referrerId: 'r1', referrerName: 'Dr. Adams' },
    { referrerId: 'r1', referrerName: 'Dr. Adams' },
    { referrerId: 'r2', referrerName: 'Dr. Brooks' },
    { referrerId: 'r3', referrerName: 'Dr. Chen' },
  ],
});

/**
 * Field documentation per dataset — what the builder agent (and any human
 * writing a definition by hand) sees instead of real rows.
 */
export const DATASET_FIELDS = Object.freeze({
  slots: 'durationMin (int minutes), status (booked|completed|open|noshow), modality (MR|CT|US|XR|PET|NM)',
  appointments: 'status (booked|arrived|completed|noshow|cancelled)',
  auths: 'status (approved|denied|pending|submitted|escalated)',
  studies: 'modality, orderedAt (ISO), finalAt (ISO), radiologistId, rvu (number)',
  claims: 'payer, status (paid|denied|pending), expected ($), paid ($), arDays (int), denialReason, modality',
  referrals: 'referrerId, referrerName — current period referral events',
  referrals_prior: 'referrerId, referrerName — prior period, for growth/leakage comparison',
});
