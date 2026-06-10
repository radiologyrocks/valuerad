/**
 * Stage 1.5 — eligibility / benefits evaluation.
 *
 * Pure logic over a FHIR Coverage resource (or normalized shape). The rule:
 * never let the platform schedule a high-cost scan against missing/expired
 * coverage without flagging it — this protects revenue at the moment of booking.
 */

const HIGH_COST_MODALITIES = new Set(['MR', 'MRI', 'CT', 'PET', 'NM']);

/**
 * @param {object} coverage - { status, period?: { start, end }, payorDisplay? }
 * @param {object} study    - { modality }
 * @param {Date}   when     - service date
 * @returns {{ eligible: boolean, requiresReview: boolean, reasons: string[] }}
 */
export function evaluateEligibility(coverage, study = {}, when = new Date()) {
  const reasons = [];
  const highCost = HIGH_COST_MODALITIES.has(String(study.modality ?? '').toUpperCase());

  if (!coverage) {
    reasons.push('no_coverage_on_file');
    return { eligible: false, requiresReview: highCost, reasons };
  }

  if (coverage.status && coverage.status !== 'active') {
    reasons.push(`coverage_status_${coverage.status}`);
  }

  const start = coverage.period?.start ? Date.parse(coverage.period.start) : null;
  const end = coverage.period?.end ? Date.parse(coverage.period.end) : null;
  const t = when.getTime();
  if (start && t < start) reasons.push('coverage_not_yet_active');
  if (end && t > end) reasons.push('coverage_expired');

  const eligible = reasons.length === 0;
  // High-cost studies with any doubt must get human/auth review before booking.
  const requiresReview = !eligible && highCost;
  return { eligible, requiresReview, reasons };
}
