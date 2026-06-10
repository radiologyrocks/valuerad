/**
 * Reimbursement engine — what a study actually pays.
 *
 * Medicare allowed = Σ(component RVU × matching GPCI) × conversion factor.
 * Other payers are resolved relative to that (contract % of Medicare, an explicit
 * fee schedule, or a flat amount). Everything here is config-driven so it is
 * customizable per practice — the CT/Medicare values below are DEFAULTS, meant
 * to be replaced by loading the official CMS PFS RVU file and your signed
 * contract rate sheets.
 *
 * Components: '26' professional (the radiologist read), 'TC' technical (scanner),
 * 'global' both.
 */

// ---------------------------------------------------------------------------
// DEFAULTS — Connecticut. Replace with current CMS values per locality.
// GPCI/CF are illustrative starting points, NOT official figures; load the real
// CMS GPCI + conversion factor for your locality. (See docs/REIMBURSEMENT.md.)
// ---------------------------------------------------------------------------
export const STATE_DEFAULTS = {
  CT: {
    locality: 'CONNECTICUT',
    gpci: { work: 1.041, pe: 1.094, mp: 0.846 }, // editable defaults
    conversionFactor: 32.35,                      // editable default ($/RVU)
  },
};

export function defaultGeography(state = 'CT') {
  return STATE_DEFAULTS[state] ?? STATE_DEFAULTS.CT;
}

// A handful of common radiology codes as sample RVU rows (work / PE non-facility
// / PE facility / malpractice, plus pre-split component totals where useful).
// Replace by loading the CMS PFS RVU file. wRVU is the radiologist's credit.
export const SAMPLE_RVUS = {
  '70553': { desc: 'MRI brain w/wo contrast', wRvu: 2.29, peFacility: 0.86, peOffice: 7.41, mpRvu: 0.18, minutes: 35, modality: 'MR' },
  '72148': { desc: 'MRI lumbar spine wo contrast', wRvu: 1.48, peFacility: 0.55, peOffice: 6.5, mpRvu: 0.12, minutes: 30, modality: 'MR' },
  '73721': { desc: 'MRI lower extremity joint wo', wRvu: 1.46, peFacility: 0.54, peOffice: 6.6, mpRvu: 0.11, minutes: 30, modality: 'MR' },
  '74177': { desc: 'CT abdomen/pelvis w contrast', wRvu: 1.82, peFacility: 0.68, peOffice: 5.2, mpRvu: 0.15, minutes: 20, modality: 'CT' },
  '71260': { desc: 'CT chest w contrast', wRvu: 1.16, peFacility: 0.43, peOffice: 4.0, mpRvu: 0.1, minutes: 15, modality: 'CT' },
  '71046': { desc: 'Chest X-ray 2 views', wRvu: 0.22, peFacility: 0.08, peOffice: 0.55, mpRvu: 0.01, minutes: 8, modality: 'XR' },
  '76700': { desc: 'US abdomen complete', wRvu: 0.81, peFacility: 0.3, peOffice: 2.9, mpRvu: 0.05, minutes: 20, modality: 'US' },
};

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/**
 * Component RVUs for a code. The professional component (read) excludes most
 * practice expense; the technical component carries it. This is a pragmatic
 * model — load true -26/-TC split RVUs from the PFS file for exactness.
 */
export function componentRvus(row, component = '26', pos = 'facility') {
  const work = num(row.wRvu);
  const pe = pos === 'office' ? num(row.peOffice) : num(row.peFacility);
  const mp = num(row.mpRvu);
  if (component === '26') return { work, pe: pe * 0.15, mp: mp * 0.8 }; // PC: small PE share
  if (component === 'TC') return { work: 0, pe: pe * 0.85, mp: mp * 0.2 }; // TC: most PE
  return { work, pe, mp }; // global
}

/** Medicare allowed for a code+component at a locality. */
export function medicareAllowed(row, { component = '26', pos = 'facility', gpci, conversionFactor }) {
  const c = componentRvus(row, component, pos);
  const totalRvu = c.work * gpci.work + c.pe * gpci.pe + c.mp * gpci.mp;
  return Number((totalRvu * conversionFactor).toFixed(2));
}

/**
 * Multiple Procedure Payment Reduction. The first imaging procedure in a session
 * pays full; subsequent reduce. Defaults: PC −5%, TC −50% on ranks > 1.
 */
export function applyMppr(amount, { rank = 1, component = '26', pcReduction = 0.05, tcReduction = 0.5 } = {}) {
  if (rank <= 1) return amount;
  const factor = component === 'TC' ? 1 - tcReduction : component === 'global' ? 1 - (pcReduction + tcReduction) / 2 : 1 - pcReduction;
  return Number((amount * factor).toFixed(2));
}

/**
 * Resolve a payer's allowed from the Medicare baseline using a contract rule.
 * rule: { type:'pct_of_medicare', pct } | { type:'fee_schedule', amount } | { type:'medicare' }
 */
export function resolvePayerAllowed(rule, medicare, code) {
  if (!rule || rule.type === 'medicare') return { allowed: medicare, source: 'medicare' };
  if (rule.type === 'pct_of_medicare') return { allowed: Number((medicare * (num(rule.pct) / 100)).toFixed(2)), source: `pct_of_medicare(${rule.pct}%)` };
  if (rule.type === 'fee_schedule') {
    const amount = rule.schedule?.[code] ?? rule.amount;
    return { allowed: Number(num(amount).toFixed(2)), source: 'fee_schedule' };
  }
  return { allowed: medicare, source: 'fallback_medicare' };
}

/**
 * Estimate payment for one study — the number a radiologist sees at read time.
 * @param exam   { code } (+ optional inline rvu row)
 * @param opts   { config, payer, component, pos, rank }
 * @returns { code, component, wRvu, medicareAllowed, allowed, source }
 */
export function estimatePayment(exam, { config, payer, component, pos, rank = 1 } = {}) {
  const cfg = config ?? {};
  const geo = { gpci: cfg.gpci ?? defaultGeography(cfg.state).gpci, conversionFactor: cfg.conversionFactor ?? defaultGeography(cfg.state).conversionFactor };
  const catalog = cfg.examCatalog ?? SAMPLE_RVUS;
  const row = exam.rvu ?? catalog[exam.code];
  const comp = component ?? cfg.defaultComponent ?? '26';
  const placeOfService = pos ?? cfg.defaultPos ?? 'facility';

  if (!row) return { code: exam.code, component: comp, wRvu: 0, medicareAllowed: 0, allowed: 0, source: 'unknown_code' };

  const med = medicareAllowed(row, { component: comp, pos: placeOfService, ...geo });
  const rule = (cfg.payers ?? {})[payer]?.rate ?? { type: 'medicare' };
  let { allowed, source } = resolvePayerAllowed(rule, med, exam.code);
  allowed = applyMppr(allowed, { rank, component: comp, ...(cfg.mppr ?? {}) });

  return {
    code: exam.code,
    component: comp,
    wRvu: Number(num(row.wRvu).toFixed(2)),
    medicareAllowed: med,
    allowed,
    payer: payer ?? 'medicare',
    source,
  };
}
