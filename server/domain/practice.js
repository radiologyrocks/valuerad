/**
 * Practice model — the radiology business as a hypergraph, with economics and
 * scenario projection.
 *
 * Nodes: examType, payer, referrer, site, scanner, radiologist.
 * Hyperedges:
 *   - volume   [examType, payer, (referrer), site]  → monthly study volume
 *   - capacity [scanner, site]                       → available scanner-minutes
 *   - staffing [radiologist, site]                   → wRVU read capacity
 *
 * Income is computed by traversing volume edges, pricing each with the
 * reimbursement engine, throttling by scanner capacity, and subtracting costs.
 * Scenario levers mutate a CLONE of the model so you can predict income under
 * changes (payer mix, contract rates, added capacity, dropped lines) without
 * touching the baseline.
 *
 * Everything is config-driven and customizable per practice. CT defaults ship
 * but are fully overridable; load real RVUs/GPCI/contracts to make it exact.
 */

import { HyperGraph } from './hypergraph.js';
import { estimatePayment, SAMPLE_RVUS, defaultGeography } from './reimbursement.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Number(n.toFixed(2));
const pct = (n, d) => (d > 0 ? Number(((n / d) * 100).toFixed(1)) : 0);

// ---------------------------------------------------------------------------
// Default config — a Connecticut single-site practice. All values overridable.
// Payer %-of-Medicare, costs, and capacity here are ILLUSTRATIVE defaults; load
// your contracts, CMS files, and real cost data to make projections exact.
// ---------------------------------------------------------------------------
export function defaultPracticeConfig(state = 'CT') {
  const geo = defaultGeography(state);
  return {
    state,
    locality: geo.locality,
    gpci: geo.gpci,
    conversionFactor: geo.conversionFactor,
    defaultComponent: '26', // radiologists read the professional component
    defaultPos: 'facility',
    defaultSite: 'main',
    examCatalog: SAMPLE_RVUS,
    mppr: { pcReduction: 0.05, tcReduction: 0.5 },
    variableCostPerStudy: 12,
    siteOverheadMonthly: 20000,
    payers: {
      Medicare:        { rate: { type: 'medicare' }, share: 0.30 },
      Medicaid_CT:     { rate: { type: 'pct_of_medicare', pct: 60 }, share: 0.15 },
      Aetna:           { rate: { type: 'pct_of_medicare', pct: 130 }, share: 0.18 },
      Cigna:           { rate: { type: 'pct_of_medicare', pct: 125 }, share: 0.12 },
      UnitedHealthcare:{ rate: { type: 'pct_of_medicare', pct: 128 }, share: 0.12 },
      WorkersComp_CT:  { rate: { type: 'pct_of_medicare', pct: 115 }, share: 0.08 },
      SelfPay:         { rate: { type: 'pct_of_medicare', pct: 35 }, share: 0.05 },
    },
    scanners: [
      { id: 'mr1', site: 'main', modality: 'MR', minutesPerDay: 600, daysPerMonth: 22, fixedCostMonthly: 32000 },
      { id: 'ct1', site: 'main', modality: 'CT', minutesPerDay: 600, daysPerMonth: 22, fixedCostMonthly: 24000 },
      { id: 'us1', site: 'main', modality: 'US', minutesPerDay: 480, daysPerMonth: 22, fixedCostMonthly: 6000 },
      { id: 'xr1', site: 'main', modality: 'XR', minutesPerDay: 480, daysPerMonth: 22, fixedCostMonthly: 4000 },
    ],
    radiologists: [
      { id: 'rad1', site: 'main', wRvuCapacityMonthly: 9000, costMonthly: 42000 },
    ],
  };
}

/** Generate a representative monthly volume distribution from config (demo). */
export function sampleVolume(config) {
  const baseByModality = { MR: 760, CT: 1180, US: 820, XR: 1850 };
  const rows = [];
  const payers = Object.entries(config.payers);
  for (const [code, row] of Object.entries(config.examCatalog)) {
    const total = baseByModality[row.modality] ?? 200;
    // spread this code's slice of modality volume across payers by share
    const codeShare = total / Object.values(config.examCatalog).filter((r) => r.modality === row.modality).length;
    for (const [payer, p] of payers) {
      const vol = Math.round(codeShare * (p.share ?? 0));
      if (vol > 0) rows.push({ code, payer, monthlyVolume: vol });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Build the hypergraph
// ---------------------------------------------------------------------------
export function buildModel(config, volumeRows) {
  const g = new HyperGraph();

  for (const code of Object.keys(config.examCatalog ?? SAMPLE_RVUS)) g.ensureNode(`exam:${code}`, 'examType', { code });
  for (const [name, p] of Object.entries(config.payers ?? {})) g.ensureNode(`payer:${name}`, 'payer', { name, rate: p.rate });

  for (const s of config.scanners ?? []) {
    g.ensureNode(`site:${s.site}`, 'site', {});
    g.ensureNode(`scanner:${s.id}`, 'scanner', { ...s });
    g.addEdge({ type: 'capacity', nodes: [`scanner:${s.id}`, `site:${s.site}`], attrs: { site: s.site, modality: s.modality, minutesPerMonth: num(s.minutesPerDay) * num(s.daysPerMonth) } });
  }
  for (const rad of config.radiologists ?? []) {
    g.ensureNode(`site:${rad.site}`, 'site', {});
    g.ensureNode(`rad:${rad.id}`, 'radiologist', { ...rad });
    g.addEdge({ type: 'staffing', nodes: [`rad:${rad.id}`, `site:${rad.site}`], attrs: { wRvuCapacityMonthly: num(rad.wRvuCapacityMonthly) } });
  }

  for (const v of volumeRows ?? []) {
    const nodes = [g.ensureNode(`exam:${v.code}`, 'examType', { code: v.code }), g.ensureNode(`payer:${v.payer}`, 'payer', { name: v.payer })];
    if (v.referrer) nodes.push(g.ensureNode(`ref:${v.referrer}`, 'referrer', { name: v.referrer }));
    const site = v.site || config.defaultSite || 'main';
    nodes.push(g.ensureNode(`site:${site}`, 'site', {}));
    g.addEdge({ type: 'volume', nodes, attrs: { code: v.code, payer: v.payer, referrer: v.referrer ?? null, site, monthlyVolume: num(v.monthlyVolume) } });
  }

  return { graph: g, config };
}

// ---------------------------------------------------------------------------
// Economics over the graph
// ---------------------------------------------------------------------------
export function computePnL(model) {
  const { graph, config } = model;
  const catalog = config.examCatalog ?? SAMPLE_RVUS;

  // Demand minutes + capacity minutes per site|modality (the throttle groups).
  const demand = {};
  const info = graph.edgesOfType('volume').map((e) => {
    const row = catalog[e.attrs.code] ?? {};
    const modality = row.modality ?? 'UNK';
    const site = e.attrs.site ?? config.defaultSite ?? 'main';
    const key = `${site}|${modality}`;
    const vol = num(e.attrs.monthlyVolume);
    demand[key] = (demand[key] ?? 0) + vol * num(row.minutes);
    return { e, modality, site, key, vol };
  });

  const capacity = {};
  for (const ce of graph.edgesOfType('capacity')) {
    const key = `${ce.attrs.site}|${ce.attrs.modality}`;
    capacity[key] = (capacity[key] ?? 0) + num(ce.attrs.minutesPerMonth);
  }
  const factorFor = (key) => {
    const c = capacity[key];
    if (c == null || c === 0) return 1; // unmodeled capacity = unconstrained
    const d = demand[key] ?? 0;
    return d > c ? c / d : 1;
  };

  let revenue = 0, variableCost = 0, wRvu = 0, lostRevenueToCapacity = 0;
  const byPayer = {}, byModality = {};
  const vcPer = num(config.variableCostPerStudy);

  for (const x of info) {
    const est = estimatePayment({ code: x.e.attrs.code }, { config, payer: x.e.attrs.payer });
    const factor = factorFor(x.key);
    const effVol = x.vol * factor;
    const rev = effVol * est.allowed;
    revenue += rev;
    lostRevenueToCapacity += x.vol * est.allowed - rev;
    variableCost += effVol * vcPer;
    wRvu += effVol * est.wRvu;

    (byPayer[x.e.attrs.payer] ??= { revenue: 0, volume: 0 });
    byPayer[x.e.attrs.payer].revenue += rev;
    byPayer[x.e.attrs.payer].volume += effVol;
    (byModality[x.modality] ??= { revenue: 0, volume: 0, wRvu: 0 });
    byModality[x.modality].revenue += rev;
    byModality[x.modality].volume += effVol;
    byModality[x.modality].wRvu += effVol * est.wRvu;
  }

  let fixedCost = num(config.siteOverheadMonthly);
  for (const s of graph.nodesOfType('scanner')) fixedCost += num(s.attrs.fixedCostMonthly);
  for (const rad of graph.nodesOfType('radiologist')) fixedCost += num(rad.attrs.costMonthly);

  const net = revenue - variableCost - fixedCost;

  const utilization = {};
  for (const key of new Set([...Object.keys(demand), ...Object.keys(capacity)])) {
    const d = demand[key] ?? 0;
    const c = capacity[key] ?? 0;
    utilization[key] = { demandMinutes: Math.round(d), capacityMinutes: Math.round(c), utilizationPct: c ? pct(Math.min(d, c), c) : null };
  }

  // wRVU staffing headroom
  const wRvuCapacity = graph.edgesOfType('staffing').reduce((s, e) => s + num(e.attrs.wRvuCapacityMonthly), 0);

  return {
    revenue: r2(revenue),
    variableCost: r2(variableCost),
    fixedCost: r2(fixedCost),
    net: r2(net),
    marginPct: pct(net, revenue),
    wRvu: r2(wRvu),
    wRvuCapacity,
    wRvuUtilizationPct: wRvuCapacity ? pct(wRvu, wRvuCapacity) : null,
    lostRevenueToCapacity: r2(lostRevenueToCapacity),
    byPayer: Object.entries(byPayer).map(([payer, v]) => ({ payer, revenue: r2(v.revenue), volume: Math.round(v.volume) })).sort((a, b) => b.revenue - a.revenue),
    byModality: Object.entries(byModality).map(([modality, v]) => ({ modality, revenue: r2(v.revenue), volume: Math.round(v.volume), wRvu: r2(v.wRvu) })).sort((a, b) => b.revenue - a.revenue),
    utilization,
  };
}

// ---------------------------------------------------------------------------
// Scenario engine — predict income under changes
// ---------------------------------------------------------------------------
function matches(attrs, match = {}, catalog = {}) {
  if (match.payer && attrs.payer !== match.payer) return false;
  if (match.code && attrs.code !== match.code) return false;
  if (match.referrer && attrs.referrer !== match.referrer) return false;
  if (match.site && (attrs.site ?? 'main') !== match.site) return false;
  if (match.modality && (catalog[attrs.code]?.modality) !== match.modality) return false;
  return true;
}

function applyLever(model, lever) {
  const { graph, config } = model;
  const catalog = config.examCatalog ?? SAMPLE_RVUS;
  switch (lever.op) {
    case 'scaleVolume':
      for (const e of graph.edgesOfType('volume')) if (matches(e.attrs, lever.match, catalog)) e.attrs.monthlyVolume = num(e.attrs.monthlyVolume) * num(lever.factor);
      break;
    case 'addVolume': {
      const v = lever.volume;
      const nodes = [graph.ensureNode(`exam:${v.code}`, 'examType', { code: v.code }), graph.ensureNode(`payer:${v.payer}`, 'payer', { name: v.payer })];
      const site = v.site || config.defaultSite || 'main';
      nodes.push(graph.ensureNode(`site:${site}`, 'site', {}));
      graph.addEdge({ type: 'volume', nodes, attrs: { code: v.code, payer: v.payer, referrer: v.referrer ?? null, site, monthlyVolume: num(v.monthlyVolume) } });
      break;
    }
    case 'dropPayer':
      for (const e of graph.edgesOfType('volume')) if (e.attrs.payer === lever.payer) graph.removeEdge(e.id);
      delete config.payers[lever.payer];
      break;
    case 'dropExam':
      for (const e of graph.edgesOfType('volume')) if (e.attrs.code === lever.code) graph.removeEdge(e.id);
      break;
    case 'setContract':
      (config.payers[lever.payer] ??= {}).rate = lever.rate;
      break;
    case 'setConversionFactor':
      config.conversionFactor = num(lever.value);
      break;
    case 'setGpci':
      config.gpci = lever.gpci;
      break;
    case 'addScanner': {
      const s = lever.scanner;
      config.scanners = [...(config.scanners ?? []), s];
      graph.ensureNode(`site:${s.site}`, 'site', {});
      graph.ensureNode(`scanner:${s.id}`, 'scanner', { ...s });
      graph.addEdge({ type: 'capacity', nodes: [`scanner:${s.id}`, `site:${s.site}`], attrs: { site: s.site, modality: s.modality, minutesPerMonth: num(s.minutesPerDay) * num(s.daysPerMonth) } });
      break;
    }
    case 'addRadiologist': {
      const rad = lever.radiologist;
      config.radiologists = [...(config.radiologists ?? []), rad];
      graph.ensureNode(`site:${rad.site}`, 'site', {});
      graph.ensureNode(`rad:${rad.id}`, 'radiologist', { ...rad });
      graph.addEdge({ type: 'staffing', nodes: [`rad:${rad.id}`, `site:${rad.site}`], attrs: { wRvuCapacityMonthly: num(rad.wRvuCapacityMonthly) } });
      break;
    }
    default:
      throw new Error(`unknown lever op: ${lever.op}`);
  }
}

/** Apply levers to a CLONE — baseline is never mutated. */
export function applyScenario(model, levers = []) {
  const next = { graph: model.graph.clone(), config: structuredClone(model.config) };
  for (const lever of levers) applyLever(next, lever);
  return next;
}

/** Predict income under a set of changes vs the baseline. */
export function projectScenario(model, levers = []) {
  const baseline = computePnL(model);
  const projected = computePnL(applyScenario(model, levers));
  const d = (k) => r2(projected[k] - baseline[k]);
  return {
    baseline,
    projected,
    delta: {
      revenue: d('revenue'),
      net: d('net'),
      wRvu: d('wRvu'),
      netChangePct: baseline.net ? pct(projected.net - baseline.net, Math.abs(baseline.net)) : null,
    },
    levers,
  };
}
