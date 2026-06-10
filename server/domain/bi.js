/**
 * Stage 4 — business intelligence.
 *
 * Pure aggregation over the operational record accumulated in Stages 1-3.
 * These are the metrics a radiology CEO actually runs the business on — built
 * on real data, not the fabricated numbers the old landing page advertised.
 */

function pct(n, d) {
  return d > 0 ? Number(((n / d) * 100).toFixed(1)) : 0;
}

/**
 * Scanner utilization — the most expensive fixed asset.
 * @param slots [{ durationMin, status: 'booked'|'completed'|'open'|'noshow' }]
 */
export function utilization(slots = []) {
  const total = slots.reduce((s, x) => s + (x.durationMin ?? 0), 0);
  const used = slots
    .filter((x) => x.status === 'booked' || x.status === 'completed')
    .reduce((s, x) => s + (x.durationMin ?? 0), 0);
  return { utilizationPct: pct(used, total), usedMinutes: used, totalMinutes: total };
}

/** No-show / cancellation rate. */
export function noShowRate(appointments = []) {
  const total = appointments.length;
  const noShows = appointments.filter((a) => a.status === 'noshow').length;
  const cancels = appointments.filter((a) => a.status === 'cancelled').length;
  return { noShowPct: pct(noShows, total), cancelPct: pct(cancels, total), total };
}

/** Prior-auth denial rate — the #1 revenue leak. */
export function authPerformance(auths = []) {
  const total = auths.length;
  const approved = auths.filter((a) => a.status === 'approved').length;
  const denied = auths.filter((a) => a.status === 'denied').length;
  return { approvalPct: pct(approved, total), denialPct: pct(denied, total), total };
}

/** Modality mix + margin contribution (margins from contract config). */
export function modalityMix(studies = [], marginByModality = {}) {
  const counts = {};
  let revenueWeighted = 0;
  for (const s of studies) {
    const m = String(s.modality ?? 'UNK').toUpperCase();
    counts[m] = (counts[m] ?? 0) + 1;
    revenueWeighted += marginByModality[m] ?? 0;
  }
  const total = studies.length;
  const mix = Object.entries(counts)
    .map(([modality, n]) => ({ modality, count: n, sharePct: pct(n, total) }))
    .sort((a, b) => b.count - a.count);
  return { mix, total, estimatedMargin: Number(revenueWeighted.toFixed(2)) };
}

/**
 * Payer leakage detector — flags payers paying materially below contracted rate.
 * @param claims [{ payer, expected, paid }]
 * @param thresholdPct underpayment flag threshold (default 5%)
 */
export function payerLeakage(claims = [], thresholdPct = 5) {
  const byPayer = {};
  for (const c of claims) {
    const p = (byPayer[c.payer] ??= { payer: c.payer, expected: 0, paid: 0, count: 0 });
    p.expected += c.expected ?? 0;
    p.paid += c.paid ?? 0;
    p.count += 1;
  }
  return Object.values(byPayer)
    .map((p) => {
      const shortfall = p.expected - p.paid;
      const shortfallPct = pct(shortfall, p.expected);
      return { ...p, shortfall: Number(shortfall.toFixed(2)), shortfallPct, flagged: shortfallPct >= thresholdPct };
    })
    .sort((a, b) => b.shortfall - a.shortfall);
}

/** Roll the above into one executive snapshot. */
export function executiveSnapshot({ slots = [], appointments = [], auths = [], studies = [], claims = [], marginByModality = {} } = {}) {
  return {
    generatedAt: new Date().toISOString(),
    utilization: utilization(slots),
    noShow: noShowRate(appointments),
    auth: authPerformance(auths),
    modality: modalityMix(studies, marginByModality),
    payerLeakage: payerLeakage(claims),
  };
}
