import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL; // memory backend

const { warehouse, warehouseBackend, loadDatasets } = await import('../lib/warehouse.js');

test('uses the in-memory warehouse without DATABASE_URL', () => {
  assert.equal(warehouseBackend, 'memory');
});

test('ingest appends, query returns rows, replace clears first', async () => {
  await warehouse.ingest('claims', [{ payer: 'Aetna', expected: 100, paid: 100 }]);
  await warehouse.ingest('claims', [{ payer: 'BCBS', expected: 200, paid: 150 }]);
  let rows = await warehouse.query('claims');
  assert.equal(rows.length, 2);

  await warehouse.ingest('claims', [{ payer: 'Cigna', expected: 50, paid: 50 }], { replace: true });
  rows = await warehouse.query('claims');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payer, 'Cigna');
});

test('counts and loadDatasets reflect ingested data', async () => {
  await warehouse.ingest('studies', [{ modality: 'MR' }], { replace: true });
  const counts = await warehouse.counts();
  assert.equal(counts.studies, 1);
  const ds = await loadDatasets();
  assert.ok(Array.isArray(ds.claims) && Array.isArray(ds.studies));
});
