/**
 * The eval suite — verification beyond "executes correctly".
 *
 * Golden tests (domain/feature.js) prove a definition runs; evals prove the
 * system still produces the SAME answers. Three deterministic layers:
 *
 *   1. Metric coverage — every metric in the engine produces non-degenerate
 *      output on the golden fixtures.
 *   2. Catalog regression — every certified report/export's output on the
 *      fixtures hashes to a pinned baseline. An engine change that shifts a
 *      number fails here FIRST, with the feature named — that is the signal
 *      to either fix the regression or consciously re-baseline
 *      (`npm run eval:update`) and bump ENGINE_VERSION.
 *   3. Seam coverage — certified rule packs decide every golden payer×modality
 *      combination; certified mappers round-trip their sample CSVs.
 *
 * Builder *quality* (does a spec yield a good definition?) needs a live
 * model — that lives in scripts/eval-builder.mjs, not here, so CI stays
 * hermetic.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { METRICS, executeDefinition, applyMapper } from './dsl.js';
import { rulePackCanary } from './feature.js';
import { CATALOG } from './catalog.js';
import { GOLDEN } from './fixtures.js';
import { parseCsv } from '../lib/csv.js';
import { authRequired } from './priorauth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINES_PATH = join(__dirname, 'evalBaselines.json');

const VOLATILE_KEYS = new Set(['generatedAt', 'ranAt', 'signedAt']);

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (!VOLATILE_KEYS.has(k)) out[k] = stripVolatile(v);
    }
    return out;
  }
  return value;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function outputHash(result) {
  return createHash('sha256').update(stableStringify(stripVolatile(result))).digest('hex');
}

/** Compute the current catalog output hashes (used by eval:update and the suite). */
export function computeCatalogBaselines(fixtures = GOLDEN) {
  const baselines = {};
  for (const entry of CATALOG) {
    if (entry.definition.kind === 'report' || entry.definition.kind === 'export') {
      baselines[entry.featureKey] = outputHash(executeDefinition(entry.definition, fixtures));
    }
  }
  return baselines;
}

export function loadBaselines() {
  try {
    return JSON.parse(readFileSync(BASELINES_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Run the full deterministic eval suite.
 * @returns {{ ok: boolean, checks: [{name, ok, detail?}] }}
 */
export function runEvalSuite({ fixtures = GOLDEN, baselines = loadBaselines() } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

  // 1. Metric coverage — non-degenerate output for every engine instruction.
  for (const [name, metric] of Object.entries(METRICS)) {
    try {
      const result = metric.run(fixtures, {});
      const degenerate = result == null || (typeof result === 'object' && Object.keys(result).length === 0);
      add(`metric.${name}`, !degenerate, degenerate ? 'degenerate output on golden fixtures' : undefined);
    } catch (err) {
      add(`metric.${name}`, false, err.message);
    }
  }

  // 2. Catalog regression against pinned baselines.
  if (!baselines) {
    add('catalog.baselines_present', false, 'evalBaselines.json missing — run `npm run eval:update`');
  } else {
    const current = computeCatalogBaselines(fixtures);
    for (const [key, hash] of Object.entries(current)) {
      const pinned = baselines[key];
      add(
        `catalog.${key}`,
        pinned === hash,
        pinned === hash ? undefined : pinned
          ? 'output changed vs baseline — engine regression, or re-baseline deliberately via `npm run eval:update`'
          : 'no pinned baseline — run `npm run eval:update`'
      );
    }
  }

  // 3a. Certified rule packs decide every golden payer×modality combination.
  const orders = fixtures.claims.filter((c) => c.payer && c.modality).map((c) => ({ payer: c.payer, modality: c.modality }));
  for (const entry of CATALOG.filter((e) => e.definition.kind === 'rule_pack')) {
    try {
      const report = rulePackCanary(entry.definition, orders);
      const everyDecided = orders.every((o) => authRequired(o, { name: o.payer }, entry.definition).reason);
      add(`rule_pack.${entry.featureKey}`, report.totalOrders === orders.length && everyDecided);
    } catch (err) {
      add(`rule_pack.${entry.featureKey}`, false, err.message);
    }
  }

  // 3b. Certified mappers round-trip their sample CSVs with typed output.
  for (const entry of CATALOG.filter((e) => e.definition.kind === 'ingest_mapper')) {
    try {
      const mapped = applyMapper(entry.definition, parseCsv(entry.definition.sampleCsv ?? ''));
      const typedOk = mapped.length > 0 && mapped.every((r) => typeof r.expected === 'number' || r.expected === undefined);
      add(`mapper.${entry.featureKey}`, typedOk, typedOk ? undefined : 'mapper produced no rows or untyped numerics');
    } catch (err) {
      add(`mapper.${entry.featureKey}`, false, err.message);
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}
