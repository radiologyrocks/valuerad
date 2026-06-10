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

// ===========================================================================
// CEO revenue-integrity, growth, productivity metrics
// ===========================================================================

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Denials — the #1 revenue leak: rate, $ at risk, by reason and payer. */
export function denialAnalytics(claims = []) {
  const total = claims.length;
  const denied = claims.filter((c) => c.status === 'denied');
  const byReason = {};
  const byPayer = {};
  let priorAuth = 0;
  for (const c of denied) {
    const reason = c.denialReason || 'unspecified';
    const dollars = num(c.expected);
    (byReason[reason] ??= { count: 0, dollars: 0 });
    byReason[reason].count += 1;
    byReason[reason].dollars += dollars;
    (byPayer[c.payer] ??= { count: 0, dollars: 0 });
    byPayer[c.payer].count += 1;
    byPayer[c.payer].dollars += dollars;
    if (/auth/i.test(reason)) priorAuth += 1;
  }
  const deniedDollars = denied.reduce((s, c) => s + num(c.expected), 0);
  return {
    denialPct: pct(denied.length, total),
    deniedDollars: Number(deniedDollars.toFixed(2)),
    priorAuthDenialPct: pct(priorAuth, denied.length),
    byReason: Object.entries(byReason).map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.dollars - a.dollars),
    byPayer: Object.entries(byPayer).map(([payer, v]) => ({ payer, ...v })).sort((a, b) => b.dollars - a.dollars),
    total,
  };
}

/** A/R aging + net collection rate + clean-claim rate. */
export function arAging(claims = []) {
  const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  const arDaysVals = [];
  let expected = 0;
  let paid = 0;
  let clean = 0;
  for (const c of claims) {
    expected += num(c.expected);
    paid += num(c.paid);
    if (c.status !== 'denied') clean += 1;
    if (c.arDays != null) {
      const d = num(c.arDays);
      arDaysVals.push(d);
      if (d <= 30) buckets['0-30'] += 1;
      else if (d <= 60) buckets['31-60'] += 1;
      else if (d <= 90) buckets['61-90'] += 1;
      else buckets['90+'] += 1;
    }
  }
  const avgArDays = arDaysVals.length ? Number((arDaysVals.reduce((a, b) => a + b, 0) / arDaysVals.length).toFixed(1)) : 0;
  return {
    avgArDays,
    buckets,
    netCollectionPct: pct(paid, expected),
    cleanClaimPct: pct(clean, claims.length),
    total: claims.length,
  };
}

/** Referral growth & leakage vs a prior period. */
export function referralAnalytics(current = [], prior = []) {
  const countBy = (rows) => rows.reduce((m, r) => { const k = r.referrerId || r.referrerName || 'unknown'; m[k] = (m[k] || 0) + 1; return m; }, {});
  const cur = countBy(current);
  const prv = countBy(prior);
  const names = Object.fromEntries(current.concat(prior).map((r) => [r.referrerId || r.referrerName || 'unknown', r.referrerName || r.referrerId]));

  const top = Object.entries(cur).map(([id, n]) => ({ id, name: names[id] || id, count: n })).sort((a, b) => b.count - a.count);
  const totalCur = top.reduce((s, r) => s + r.count, 0);
  const top10 = top.slice(0, 10).reduce((s, r) => s + r.count, 0);

  const leakage = [];
  for (const [id, n] of Object.entries(prv)) {
    const now = cur[id] || 0;
    if (now < n) leakage.push({ id, name: names[id] || id, prior: n, current: now, dropPct: pct(n - now, n) });
  }
  leakage.sort((a, b) => (b.prior - b.current) - (a.prior - a.current));

  const lapsed = Object.keys(prv).filter((id) => !cur[id]);
  const fresh = Object.keys(cur).filter((id) => !prv[id]);

  return {
    topReferrers: top.slice(0, 10),
    concentrationTop10Pct: pct(top10, totalCur),
    leakage,
    leakageCount: leakage.length,
    lapsedCount: lapsed.length,
    newCount: fresh.length,
  };
}

/** Report turnaround time (order -> final), overall + by modality + SLA. */
export function turnaroundTime(studies = [], slaHours = 24) {
  const hrs = [];
  const byModality = {};
  let withinSla = 0;
  for (const s of studies) {
    if (!s.orderedAt || !s.finalAt) continue;
    const h = (Date.parse(s.finalAt) - Date.parse(s.orderedAt)) / 3_600_000;
    if (!Number.isFinite(h) || h < 0) continue;
    hrs.push(h);
    if (h <= slaHours) withinSla += 1;
    const m = String(s.modality ?? 'UNK').toUpperCase();
    (byModality[m] ??= []).push(h);
  }
  return {
    avgHours: hrs.length ? Number((hrs.reduce((a, b) => a + b, 0) / hrs.length).toFixed(1)) : 0,
    medianHours: Number(median(hrs).toFixed(1)),
    withinSlaPct: pct(withinSla, hrs.length),
    slaHours,
    byModality: Object.entries(byModality).map(([modality, arr]) => ({ modality, avgHours: Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)), count: arr.length })),
    count: hrs.length,
  };
}

/** Radiologist productivity — RVUs and read volume per FTE. */
export function productivity(studies = []) {
  const byRad = {};
  let totalRvu = 0;
  for (const s of studies) {
    const id = s.radiologistId || 'unassigned';
    const rvu = num(s.rvu);
    totalRvu += rvu;
    (byRad[id] ??= { studies: 0, rvu: 0 });
    byRad[id].studies += 1;
    byRad[id].rvu += rvu;
  }
  return {
    totalRvu: Number(totalRvu.toFixed(2)),
    byRadiologist: Object.entries(byRad).map(([id, v]) => ({ id, studies: v.studies, rvu: Number(v.rvu.toFixed(2)) })).sort((a, b) => b.rvu - a.rvu),
  };
}

/** Scheduling funnel: orders -> scheduled -> arrived -> completed -> read -> billed. */
export function schedulingFunnel({ studies = [], appointments = [], claims = [] } = {}) {
  const ordered = studies.length || appointments.length;
  const scheduled = appointments.filter((a) => a.status !== 'cancelled').length;
  const arrived = appointments.filter((a) => ['arrived', 'completed'].includes(a.status)).length;
  const completed = appointments.filter((a) => a.status === 'completed').length;
  const read = studies.filter((s) => s.finalAt).length;
  const billed = claims.length;
  const stages = [
    { stage: 'ordered', count: ordered },
    { stage: 'scheduled', count: scheduled },
    { stage: 'arrived', count: arrived },
    { stage: 'completed', count: completed },
    { stage: 'read', count: read },
    { stage: 'billed', count: billed },
  ];
  return stages.map((s, i) => ({ ...s, conversionPct: i === 0 ? 100 : pct(s.count, stages[i - 1].count) }));
}

// ===========================================================================
// CEO scorecard — KPIs with targets, variance, and exception alerts
// ===========================================================================

export const DEFAULT_TARGETS = Object.freeze({
  utilizationPct: { target: 75, direction: 'higher', label: 'Scanner utilization', unit: '%' },
  noShowPct:      { target: 8,  direction: 'lower',  label: 'No-show rate', unit: '%' },
  denialPct:      { target: 5,  direction: 'lower',  label: 'Denial rate', unit: '%' },
  netCollectionPct: { target: 96, direction: 'higher', label: 'Net collection rate', unit: '%' },
  avgArDays:      { target: 40, direction: 'lower',  label: 'Days in A/R', unit: 'days' },
  turnaroundHours:{ target: 24, direction: 'lower',  label: 'Report turnaround', unit: 'hrs' },
  authApprovalPct:{ target: 95, direction: 'higher', label: 'Auth approval rate', unit: '%' },
  referralLeakage:{ target: 0,  direction: 'lower',  label: 'Referrers leaking', unit: '' },
});

function statusFor(value, target, direction, warnBand = 0.1) {
  if (direction === 'higher') {
    if (value >= target) return 'ok';
    if (value >= target * (1 - warnBand)) return 'warn';
    return 'breach';
  }
  // lower is better
  if (value <= target) return 'ok';
  if (value <= target * (1 + warnBand) || (target === 0 && value <= 1)) return 'warn';
  return 'breach';
}

/**
 * Build the executive scorecard from raw datasets.
 * @param datasets { slots, appointments, auths, studies, claims, referrals, referrals_prior, marginByModality }
 * @param targets  override of DEFAULT_TARGETS
 */
export function scorecard(datasets = {}, targets = DEFAULT_TARGETS) {
  const {
    slots = [], appointments = [], auths = [], studies = [], claims = [],
    referrals = [], referrals_prior = [],
  } = datasets;

  const values = {
    utilizationPct: utilization(slots).utilizationPct,
    noShowPct: noShowRate(appointments).noShowPct,
    denialPct: denialAnalytics(claims).denialPct,
    netCollectionPct: arAging(claims).netCollectionPct,
    avgArDays: arAging(claims).avgArDays,
    turnaroundHours: turnaroundTime(studies).avgHours,
    authApprovalPct: authPerformance(auths).approvalPct,
    referralLeakage: referralAnalytics(referrals, referrals_prior).leakageCount,
  };

  const kpis = Object.entries(targets).map(([key, t]) => {
    const value = values[key] ?? 0;
    const variancePct = t.target ? Number((((value - t.target) / t.target) * 100).toFixed(1)) : null;
    return { key, label: t.label, unit: t.unit, value, target: t.target, direction: t.direction, variancePct, status: statusFor(value, t.target, t.direction) };
  });

  return { generatedAt: new Date().toISOString(), kpis, exceptions: exceptions(kpis) };
}

/** Turn breached/at-risk KPIs into prioritized alerts. */
export function exceptions(kpis = []) {
  return kpis
    .filter((k) => k.status !== 'ok')
    .sort((a, b) => (a.status === 'breach' ? -1 : 1) - (b.status === 'breach' ? -1 : 1))
    .map((k) => ({
      key: k.key,
      severity: k.status === 'breach' ? 'high' : 'medium',
      message: `${k.label} is ${k.value}${k.unit} vs target ${k.target}${k.unit} (${k.variancePct > 0 ? '+' : ''}${k.variancePct}%).`,
    }));
}

/** Full CEO report — snapshot + the deep-dive metrics + scorecard. */
export function ceoReport(datasets = {}, targets = DEFAULT_TARGETS) {
  const { claims = [], studies = [], appointments = [], referrals = [], referrals_prior = [] } = datasets;
  return {
    snapshot: executiveSnapshot(datasets),
    scorecard: scorecard(datasets, targets),
    denials: denialAnalytics(claims),
    ar: arAging(claims),
    referrals: referralAnalytics(referrals, referrals_prior),
    turnaround: turnaroundTime(studies),
    productivity: productivity(studies),
    funnel: schedulingFunnel({ studies, appointments, claims }),
  };
}
