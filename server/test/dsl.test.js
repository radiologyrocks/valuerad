import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;

import {
  validateDefinition, executeDefinition, applyMapper, toCsv, resolvePath,
  METRICS, ENGINE_VERSION, LIMITS,
} from '../domain/dsl.js';
import { GOLDEN } from '../domain/fixtures.js';
import { parseCsv } from '../lib/csv.js';

const REPORT = {
  kind: 'report',
  title: 'Referrer scorecard',
  blocks: [
    { id: 'referrers', metric: 'referralAnalytics' },
    { id: 'tat', metric: 'turnaroundTime', params: { slaHours: 12 } },
  ],
  access: { roles: ['executive'] },
};

const EXPORT = {
  kind: 'export',
  title: 'Denials by payer',
  blocks: [{ id: 'denials', metric: 'denialAnalytics' }],
  output: {
    format: 'csv',
    from: 'denials.byPayer',
    columns: [
      { header: 'Payer', path: 'payer' },
      { header: 'Dollars', path: 'dollars' },
    ],
  },
};

// ---- validation ----
test('valid report and export definitions pass validation', () => {
  assert.deepEqual(validateDefinition(REPORT), []);
  assert.deepEqual(validateDefinition(EXPORT), []);
});

test('validation rejects unknown kinds, metrics, ops, roles, and targets', () => {
  assert.ok(validateDefinition({ kind: 'webhook', title: 'x' }).length > 0);
  assert.ok(validateDefinition({ kind: 'report', title: 'x', blocks: [{ id: 'a', metric: 'dropTables' }] })
    .some((e) => e.includes('unknown metric')));
  assert.ok(validateDefinition({
    kind: 'report', title: 'x',
    blocks: [{ id: 'a', metric: 'arAging', filters: [{ dataset: 'claims', field: 'payer', op: 'regex', value: '.*' }] }],
  }).some((e) => e.includes('op')));
  assert.ok(validateDefinition({ ...REPORT, access: { roles: ['agent'] } }).some((e) => e.includes('access.roles')));
  assert.ok(validateDefinition({
    kind: 'report', title: 'x',
    blocks: [{ id: 'a', metric: 'scorecard', params: { targets: { madeUpKpi: { target: 1 } } } }],
  }).some((e) => e.includes('unknown scorecard target')));
});

test('validation enforces caps and unique block ids', () => {
  const tooMany = {
    kind: 'report', title: 'x',
    blocks: Array.from({ length: LIMITS.MAX_BLOCKS + 1 }, (_, i) => ({ id: `b${i}`, metric: 'arAging' })),
  };
  assert.ok(validateDefinition(tooMany).some((e) => e.includes('too many blocks')));

  const dup = { kind: 'report', title: 'x', blocks: [{ id: 'a', metric: 'arAging' }, { id: 'a', metric: 'arAging' }] };
  assert.ok(validateDefinition(dup).some((e) => e.includes('duplicate block id')));
});

test('export output.from must start with a block id', () => {
  const bad = { ...EXPORT, output: { ...EXPORT.output, from: 'nope.byPayer' } };
  assert.ok(validateDefinition(bad).some((e) => e.includes('output.from')));
});

// ---- interpreter ----
test('report executes every block over golden fixtures', () => {
  const result = executeDefinition(REPORT, GOLDEN);
  assert.equal(result.kind, 'report');
  assert.ok(result.blocks.referrers.topReferrers.length > 0);
  assert.equal(result.blocks.tat.slaHours, 12);
});

test('block filters narrow the dataset before the metric runs', () => {
  const all = executeDefinition({
    kind: 'report', title: 'x', blocks: [{ id: 't', metric: 'turnaroundTime' }],
  }, GOLDEN);
  const mrOnly = executeDefinition({
    kind: 'report', title: 'x',
    blocks: [{ id: 't', metric: 'turnaroundTime', filters: [{ dataset: 'studies', field: 'modality', op: 'eq', value: 'MR' }] }],
  }, GOLDEN);
  assert.ok(mrOnly.blocks.t.count < all.blocks.t.count);
  assert.equal(mrOnly.blocks.t.count, 2);
});

test('scorecard targets override merges onto defaults', () => {
  const result = executeDefinition({
    kind: 'report', title: 'x',
    blocks: [{ id: 'card', metric: 'scorecard', params: { targets: { utilizationPct: { target: 99 } } } }],
  }, GOLDEN);
  const kpi = result.blocks.card.kpis.find((k) => k.key === 'utilizationPct');
  assert.equal(kpi.target, 99);
  // untouched targets keep their defaults
  const noShow = result.blocks.card.kpis.find((k) => k.key === 'noShowPct');
  assert.equal(noShow.target, 8);
});

test('export produces CSV with header + escaped values', () => {
  const result = executeDefinition(EXPORT, GOLDEN);
  assert.equal(result.format, 'csv');
  assert.ok(result.rowCount > 0);
  const lines = result.csv.split('\n');
  assert.equal(lines[0], 'Payer,Dollars');
  assert.equal(lines.length, result.rowCount + 1);
});

test('toCsv escapes commas and quotes', () => {
  const csv = toCsv([{ a: 'x,y', b: 'he said "hi"' }], [{ header: 'A', path: 'a' }, { header: 'B', path: 'b' }]);
  assert.equal(csv.split('\n')[1], '"x,y","he said ""hi"""');
});

test('resolvePath walks dotted paths', () => {
  assert.equal(resolvePath({ a: { b: [{ c: 7 }] } }, 'a.b.0.c'), 7);
  assert.equal(resolvePath({}, 'a.b'), undefined);
});

test('rule packs and mappers are not directly executable', () => {
  assert.throws(() => executeDefinition({ kind: 'rule_pack', title: 'x', payerRules: { A: { exempt: ['US'] } } }, {}),
    /not directly executable/);
});

test('row cap throws instead of silently truncating', () => {
  const huge = Array.from({ length: LIMITS.MAX_ROWS + 1 }, () => ({ status: 'completed' }));
  assert.throws(() => executeDefinition({
    kind: 'report', title: 'x', blocks: [{ id: 'n', metric: 'noShowRate' }],
  }, { appointments: huge }), /row cap/);
});

// ---- ingest mapper ----
test('applyMapper renames columns and applies transforms', () => {
  const def = {
    kind: 'ingest_mapper', title: 'x', dataset: 'claims',
    columns: { 'Payer Name': 'payer', 'Billed': 'expected', 'Status': 'status' },
    transforms: [{ field: 'expected', op: 'number' }, { field: 'status', op: 'lowercase' }],
  };
  const rows = parseCsv('Payer Name,Billed,Status,Ignored\nAetna,1200,Denied,zzz\n');
  const mapped = applyMapper(def, rows);
  assert.deepEqual(mapped, [{ payer: 'Aetna', expected: 1200, status: 'denied' }]);
});

test('every metric in the registry declares datasets and runs on fixtures', () => {
  for (const [name, m] of Object.entries(METRICS)) {
    assert.ok(Array.isArray(m.datasets) && m.datasets.length > 0, `${name} declares datasets`);
    assert.ok(typeof m.describe === 'string');
    const result = m.run(GOLDEN, {});
    assert.ok(result != null, `${name} runs on golden fixtures`);
  }
});

test('engine version is a semver-ish string', () => {
  assert.match(ENGINE_VERSION, /^\d+\.\d+\.\d+$/);
});
