/**
 * The living-software EXECUTION SURFACE.
 *
 * A definition is *data* — datasets, filters, metric blocks, an output shape —
 * interpreted here against the metric library in domain/bi.js. Nothing in a
 * definition is executable: the model (or a human) emits configuration for this
 * trusted engine, never code. That single boundary is what makes generated
 * features safe to run in a regulated environment.
 *
 * Definition kinds:
 *   report        — metric blocks → JSON          (Tier 1)
 *   export        — metric blocks → CSV           (Tier 1)
 *   rule_pack     — per-payer auth rules as data  (Tier 2; consumed by priorauth)
 *   ingest_mapper — CSV column mapping as data    (Tier 2; consumed by bi/ingest)
 */

import {
  utilization, noShowRate, authPerformance, modalityMix, payerLeakage,
  denialAnalytics, arAging, referralAnalytics, turnaroundTime, productivity,
  schedulingFunnel, executiveSnapshot, scorecard, DEFAULT_TARGETS,
} from './bi.js';

/** Bump when a metric contract changes; active features are revalidated against it. */
export const ENGINE_VERSION = '1.0.0';

export const DEFINITION_KINDS = ['report', 'export', 'rule_pack', 'ingest_mapper'];
export const DSL_DATASETS = ['claims', 'appointments', 'studies', 'slots', 'auths', 'referrals', 'referrals_prior'];
export const ACCESS_ROLES = ['scheduler', 'auth_specialist', 'radiologist', 'admin', 'executive'];

// Interpreter resource caps — part of the guardrail, not tunables.
export const LIMITS = Object.freeze({ MAX_BLOCKS: 12, MAX_FILTERS: 50, MAX_COLUMNS: 40, MAX_ROWS: 100_000 });

const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'];
const MAPPER_TRANSFORMS = ['number', 'uppercase', 'lowercase', 'trim', 'date'];

/** Merge partial per-key target overrides onto the defaults. */
function mergeTargets(overrides = {}) {
  const merged = { ...DEFAULT_TARGETS };
  for (const [key, o] of Object.entries(overrides)) {
    if (!merged[key]) continue; // unknown KPI keys are rejected by validation
    merged[key] = { ...merged[key], ...o };
  }
  return merged;
}

/**
 * The metric registry — the DSL's entire instruction set. Each entry names the
 * datasets it consumes so the interpreter (and the builder) know what to feed it.
 */
export const METRICS = {
  utilization: { datasets: ['slots'], describe: 'Scanner utilization % from slot minutes', run: (d) => utilization(d.slots) },
  noShowRate: { datasets: ['appointments'], describe: 'No-show and cancellation rates', run: (d) => noShowRate(d.appointments) },
  authPerformance: { datasets: ['auths'], describe: 'Prior-auth approval/denial rates', run: (d) => authPerformance(d.auths) },
  modalityMix: { datasets: ['studies'], describe: 'Study mix by modality + estimated margin (params.marginByModality)', run: (d, p) => modalityMix(d.studies, p.marginByModality ?? {}) },
  payerLeakage: { datasets: ['claims'], describe: 'Payers paying below contract (params.thresholdPct, default 5)', run: (d, p) => payerLeakage(d.claims, p.thresholdPct ?? 5) },
  denialAnalytics: { datasets: ['claims'], describe: 'Denial rate, $ at risk, by reason and payer', run: (d) => denialAnalytics(d.claims) },
  arAging: { datasets: ['claims'], describe: 'A/R aging buckets, net collection, clean-claim rate', run: (d) => arAging(d.claims) },
  referralAnalytics: { datasets: ['referrals', 'referrals_prior'], describe: 'Top referrers, concentration, leakage vs prior period', run: (d) => referralAnalytics(d.referrals, d.referrals_prior) },
  turnaroundTime: { datasets: ['studies'], describe: 'Report turnaround vs SLA (params.slaHours, default 24)', run: (d, p) => turnaroundTime(d.studies, p.slaHours ?? 24) },
  productivity: { datasets: ['studies'], describe: 'RVUs and read volume per radiologist', run: (d) => productivity(d.studies) },
  schedulingFunnel: { datasets: ['studies', 'appointments', 'claims'], describe: 'Ordered→scheduled→arrived→completed→read→billed conversion', run: (d) => schedulingFunnel(d) },
  executiveSnapshot: { datasets: ['slots', 'appointments', 'auths', 'studies', 'claims'], describe: 'The full executive snapshot (params.marginByModality)', run: (d, p) => executiveSnapshot({ ...d, marginByModality: p.marginByModality ?? {} }) },
  scorecard: { datasets: DSL_DATASETS, describe: 'CEO KPI scorecard; params.targets overrides per-KPI {target,direction}', run: (d, p) => scorecard(d, mergeTargets(p.targets)) },
};

/**
 * The definition format, documented for the builder agent (and humans).
 * Returned by the builder's list_metrics tool so the model composes against
 * the real shape instead of guessing field names.
 */
export const DEFINITION_GUIDE = Object.freeze({
  report: {
    shape: '{ kind:"report", title, blocks:[{ id, metric, params?, filters?:[{dataset,field,op,value}] }], access?:{roles:[...]} }',
    filterOps: FILTER_OPS,
    example: {
      kind: 'report',
      title: 'MR turnaround vs 12h SLA',
      blocks: [
        { id: 'tat', metric: 'turnaroundTime', params: { slaHours: 12 }, filters: [{ dataset: 'studies', field: 'modality', op: 'eq', value: 'MR' }] },
      ],
      access: { roles: ['executive', 'admin'] },
    },
  },
  export: {
    shape: 'report shape + output:{ format:"csv", from:"blockId.path.to.array", columns:[{header,path}] }',
    example: {
      kind: 'export',
      title: 'Denied dollars by payer',
      blocks: [{ id: 'denials', metric: 'denialAnalytics' }],
      output: { format: 'csv', from: 'denials.byPayer', columns: [{ header: 'Payer', path: 'payer' }, { header: 'Dollars', path: 'dollars' }] },
    },
  },
  rule_pack: {
    shape: '{ kind:"rule_pack", title, payerRules:{ [payerName]: { exempt?:[modality], require?:[modality] } }, access? }',
    example: { kind: 'rule_pack', title: 'Medicare imaging rules', payerRules: { Medicare: { exempt: ['CT', 'MR'] } } },
  },
  ingest_mapper: {
    shape: '{ kind:"ingest_mapper", title, dataset, columns:{ "Source Header":"targetField" }, transforms?:[{field,op:number|uppercase|lowercase|trim|date}], sampleCsv }',
    example: {
      kind: 'ingest_mapper',
      title: 'RCM claims mapper',
      dataset: 'claims',
      columns: { 'Payer Name': 'payer', 'Billed': 'expected' },
      transforms: [{ field: 'expected', op: 'number' }],
      sampleCsv: 'Payer Name,Billed\nAetna,1200\n',
    },
  },
});

// ---------------------------------------------------------------------------
// Validation — every definition is schema-checked before it can be tested,
// proposed, approved, or run. Returns an array of error strings (empty = valid).
// ---------------------------------------------------------------------------

function validateFilters(filters, errors, where) {
  if (filters == null) return;
  if (!Array.isArray(filters)) { errors.push(`${where}: filters must be an array`); return; }
  if (filters.length > LIMITS.MAX_FILTERS) errors.push(`${where}: too many filters (max ${LIMITS.MAX_FILTERS})`);
  for (const f of filters) {
    if (!DSL_DATASETS.includes(f?.dataset)) errors.push(`${where}: filter dataset must be one of ${DSL_DATASETS.join(', ')}`);
    if (typeof f?.field !== 'string' || !f.field) errors.push(`${where}: filter needs a field`);
    if (!FILTER_OPS.includes(f?.op)) errors.push(`${where}: filter op must be one of ${FILTER_OPS.join(', ')}`);
    if (f?.value === undefined) errors.push(`${where}: filter needs a value`);
  }
}

function validateAccess(def, errors) {
  const roles = def.access?.roles;
  if (roles == null) return;
  if (!Array.isArray(roles) || roles.length === 0 || !roles.every((r) => ACCESS_ROLES.includes(r))) {
    errors.push(`access.roles must be a non-empty subset of: ${ACCESS_ROLES.join(', ')}`);
  }
}

function validateBlocks(def, errors) {
  const blocks = def.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) { errors.push('blocks must be a non-empty array'); return; }
  if (blocks.length > LIMITS.MAX_BLOCKS) errors.push(`too many blocks (max ${LIMITS.MAX_BLOCKS})`);
  const ids = new Set();
  for (const b of blocks) {
    if (typeof b?.id !== 'string' || !b.id) errors.push('every block needs a string id');
    else if (ids.has(b.id)) errors.push(`duplicate block id "${b.id}"`);
    else ids.add(b.id);
    if (!METRICS[b?.metric]) errors.push(`unknown metric "${b?.metric}" — must be one of ${Object.keys(METRICS).join(', ')}`);
    if (b?.params != null && (typeof b.params !== 'object' || Array.isArray(b.params))) errors.push(`block "${b?.id}": params must be an object`);
    if (b?.metric === 'scorecard' && b?.params?.targets) {
      for (const key of Object.keys(b.params.targets)) {
        if (!DEFAULT_TARGETS[key]) errors.push(`block "${b.id}": unknown scorecard target "${key}"`);
      }
    }
    validateFilters(b?.filters, errors, `block "${b?.id}"`);
  }
}

function validateExportOutput(def, errors) {
  const out = def.output;
  if (out?.format !== 'csv') { errors.push('export definitions need output.format = "csv"'); return; }
  if (typeof out.from !== 'string' || !out.from) {
    errors.push('export needs output.from ("blockId.path.to.array")');
  } else {
    const blockIds = new Set((def.blocks ?? []).map((b) => b.id));
    if (!blockIds.has(out.from.split('.')[0])) {
      errors.push(`output.from must start with a block id (${[...blockIds].join(', ')})`);
    }
  }
  if (!Array.isArray(out.columns) || out.columns.length === 0) errors.push('export needs output.columns');
  else {
    if (out.columns.length > LIMITS.MAX_COLUMNS) errors.push(`too many columns (max ${LIMITS.MAX_COLUMNS})`);
    for (const c of out.columns) {
      if (typeof c?.header !== 'string' || typeof c?.path !== 'string') errors.push('every column needs {header, path}');
    }
  }
}

function validateRulePack(def, errors) {
  const rules = def.payerRules;
  if (rules == null || typeof rules !== 'object' || Array.isArray(rules) || Object.keys(rules).length === 0) {
    errors.push('rule_pack needs a non-empty payerRules object');
    return;
  }
  for (const [payer, r] of Object.entries(rules)) {
    for (const list of ['exempt', 'require']) {
      if (r?.[list] != null && (!Array.isArray(r[list]) || !r[list].every((m) => typeof m === 'string'))) {
        errors.push(`payerRules["${payer}"].${list} must be an array of modality strings`);
      }
    }
    if (r?.exempt == null && r?.require == null) errors.push(`payerRules["${payer}"] needs exempt and/or require`);
  }
}

function validateIngestMapper(def, errors) {
  if (!DSL_DATASETS.includes(def.dataset)) errors.push(`ingest_mapper dataset must be one of ${DSL_DATASETS.join(', ')}`);
  const cols = def.columns;
  if (cols == null || typeof cols !== 'object' || Array.isArray(cols) || Object.keys(cols).length === 0) {
    errors.push('ingest_mapper needs a non-empty columns object (source header -> target field)');
  } else if (![...Object.entries(cols)].every(([k, v]) => k && typeof v === 'string' && v)) {
    errors.push('every columns entry must map a source header to a target field name');
  }
  if (def.transforms != null) {
    if (!Array.isArray(def.transforms)) errors.push('transforms must be an array');
    else for (const t of def.transforms) {
      if (typeof t?.field !== 'string' || !MAPPER_TRANSFORMS.includes(t?.op)) {
        errors.push(`every transform needs {field, op: ${MAPPER_TRANSFORMS.join('|')}}`);
      }
    }
  }
  if (def.sampleCsv != null && typeof def.sampleCsv !== 'string') errors.push('sampleCsv must be a CSV string');
}

export function validateDefinition(def) {
  const errors = [];
  if (def == null || typeof def !== 'object' || Array.isArray(def)) return ['definition must be an object'];
  if (!DEFINITION_KINDS.includes(def.kind)) errors.push(`kind must be one of ${DEFINITION_KINDS.join(', ')}`);
  if (typeof def.title !== 'string' || !def.title.trim()) errors.push('title is required');
  validateAccess(def, errors);

  if (def.kind === 'report' || def.kind === 'export') validateBlocks(def, errors);
  if (def.kind === 'export') validateExportOutput(def, errors);
  if (def.kind === 'rule_pack') validateRulePack(def, errors);
  if (def.kind === 'ingest_mapper') validateIngestMapper(def, errors);
  return errors;
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

function matches(row, f) {
  const v = row?.[f.field];
  switch (f.op) {
    case 'eq': return String(v) === String(f.value);
    case 'neq': return String(v) !== String(f.value);
    case 'gt': return Number(v) > Number(f.value);
    case 'gte': return Number(v) >= Number(f.value);
    case 'lt': return Number(v) < Number(f.value);
    case 'lte': return Number(v) <= Number(f.value);
    case 'in': return Array.isArray(f.value) && f.value.map(String).includes(String(v));
    case 'contains': return String(v ?? '').toLowerCase().includes(String(f.value).toLowerCase());
    default: return false;
  }
}

function datasetFor(block, datasets, name) {
  const rows = datasets[name] ?? [];
  if (rows.length > LIMITS.MAX_ROWS) throw new Error(`row cap exceeded for dataset "${name}" (max ${LIMITS.MAX_ROWS})`);
  const filters = (block.filters ?? []).filter((f) => f.dataset === name);
  return filters.length ? rows.filter((r) => filters.every((f) => matches(r, f))) : rows;
}

/** Resolve a dotted path ("denials.byPayer") into an object. */
export function resolvePath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns) {
  const lines = [columns.map((c) => csvEscape(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvEscape(resolvePath(row, c.path))).join(','));
  return lines.join('\n');
}

/**
 * Execute a report/export definition over datasets (warehouse-shaped object).
 * Throws on invalid definitions — validate first.
 */
export function executeDefinition(def, datasets = {}) {
  const errors = validateDefinition(def);
  if (errors.length) throw new Error(`invalid definition: ${errors.join('; ')}`);
  if (def.kind !== 'report' && def.kind !== 'export') {
    throw new Error(`kind "${def.kind}" is not directly executable — it configures a platform seam`);
  }

  const blocks = {};
  for (const block of def.blocks) {
    const metric = METRICS[block.metric];
    const inputs = {};
    for (const name of metric.datasets) inputs[name] = datasetFor(block, datasets, name);
    blocks[block.id] = metric.run(inputs, block.params ?? {});
  }

  if (def.kind === 'report') {
    return { title: def.title, kind: 'report', generatedAt: new Date().toISOString(), blocks };
  }

  const rows = resolvePath(blocks, def.output.from);
  if (!Array.isArray(rows)) throw new Error(`output.from "${def.output.from}" did not resolve to an array`);
  return {
    title: def.title,
    kind: 'export',
    generatedAt: new Date().toISOString(),
    format: 'csv',
    rowCount: rows.length,
    csv: toCsv(rows, def.output.columns),
  };
}

/**
 * Apply an ingest_mapper definition to parsed CSV rows: rename source headers
 * to target fields and apply declared transforms. Pure; used by bi/ingest and
 * by mapper dry-runs.
 */
export function applyMapper(def, rows = []) {
  const transforms = def.transforms ?? [];
  return rows.map((src) => {
    const out = {};
    for (const [from, to] of Object.entries(def.columns)) {
      if (src[from] !== undefined) out[to] = src[from];
    }
    for (const t of transforms) {
      if (out[t.field] === undefined) continue;
      const v = out[t.field];
      if (t.op === 'number') out[t.field] = Number(v);
      else if (t.op === 'uppercase') out[t.field] = String(v).toUpperCase();
      else if (t.op === 'lowercase') out[t.field] = String(v).toLowerCase();
      else if (t.op === 'trim') out[t.field] = String(v).trim();
      else if (t.op === 'date') {
        const ms = Date.parse(v);
        out[t.field] = Number.isFinite(ms) ? new Date(ms).toISOString() : v;
      }
    }
    return out;
  });
}
