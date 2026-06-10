/**
 * Stage 2 — prior-authorization logic.
 *
 * Two pure pieces:
 *   1. Requirement rules — does this study/payer need auth?
 *   2. A state machine — the lifecycle of an auth request, with legal transitions.
 *
 * The actual payer submission is an async job (lib/jobs.js); this module holds
 * the *decisions*, kept pure and testable. Real payer rules vary; this encodes
 * the common high-cost-imaging pattern and is meant to be extended per contract.
 */

// Modalities that almost always require prior auth for outpatient imaging.
const AUTH_REQUIRED_MODALITIES = new Set(['MR', 'MRI', 'CT', 'CTA', 'MRA', 'PET', 'NM']);

// Payers that (in this simplified model) do not require auth for some modalities.
// Real config comes from contract data; this is the seam.
const PAYER_EXCEPTIONS = {
  // 'Medicare': new Set(['XR', 'US']),
};

/**
 * @param {object} order - { modality, cpt?, urgency? }
 * @param {object} payer - { name }
 * @returns {{ required: boolean, reason: string }}
 */
export function authRequired(order = {}, payer = {}) {
  const modality = String(order.modality ?? '').toUpperCase();

  if (order.urgency === 'stat' || order.urgency === 'emergent') {
    return { required: false, reason: 'emergent_exempt' };
  }

  const exceptions = PAYER_EXCEPTIONS[payer.name];
  if (exceptions && exceptions.has(modality)) {
    return { required: false, reason: 'payer_exception' };
  }

  if (AUTH_REQUIRED_MODALITIES.has(modality)) {
    return { required: true, reason: 'high_cost_modality' };
  }
  return { required: false, reason: 'no_auth_needed' };
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------
export const AUTH_STATES = Object.freeze({
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
  ESCALATED: 'escalated',
  CANCELLED: 'cancelled',
});

const TRANSITIONS = {
  draft: ['submitted', 'cancelled'],
  submitted: ['pending', 'approved', 'denied'],
  pending: ['approved', 'denied', 'escalated'],
  denied: ['escalated', 'cancelled'],
  escalated: ['approved', 'denied', 'cancelled'],
  approved: [],
  cancelled: [],
};

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Apply a transition, returning the new auth object or throwing on illegal move.
 * Records history for the audit trail.
 */
export function transition(auth, to, detail = {}) {
  const from = auth.status ?? AUTH_STATES.DRAFT;
  if (!canTransition(from, to)) {
    throw new Error(`illegal auth transition ${from} -> ${to}`);
  }
  return {
    ...auth,
    status: to,
    history: [...(auth.history ?? []), { from, to, at: new Date().toISOString(), ...detail }],
  };
}

/**
 * Whether a study is safe to perform: emergent, not-required, or approved.
 * The booking/worklist layer calls this so nothing high-cost scans without
 * a valid auth — the single biggest revenue-protection rule.
 */
export function safeToPerform({ authRequiredResult, authStatus }) {
  if (!authRequiredResult?.required) return true;
  return authStatus === AUTH_STATES.APPROVED;
}
