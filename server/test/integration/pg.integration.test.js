/**
 * Postgres integration pass — exercises the REAL database backends that the
 * unit suite deliberately avoids (every unit file deletes DATABASE_URL so the
 * memory backends are used; node:test runs each file in its own process, so
 * this file keeps it).
 *
 * Skips itself when DATABASE_URL is unset (local dev without Postgres).
 * CI provides a postgres service container and sets PGSSL=disable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  test('postgres integration (skipped — DATABASE_URL not set)', { skip: true }, () => {});
} else {
  const { migrate, pool, closeDb } = await import('../../lib/db.js');
  const { store, storeBackend } = await import('../../lib/store.js');
  const { warehouse, warehouseBackend } = await import('../../lib/warehouse.js');
  const { featureRegistry, featureRegistryBackend } = await import('../../lib/features.js');
  const { principals, principalsBackend } = await import('../../lib/principals.js');
  const { transitionFeature } = await import('../../domain/feature.js');

  test('pg: schema migrates idempotently and the postgres backends are selected', async () => {
    await migrate();
    await migrate(); // idempotent — CREATE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS
    assert.equal(storeBackend, 'postgres');
    assert.equal(warehouseBackend, 'postgres');
    assert.equal(featureRegistryBackend, 'postgres');
    assert.equal(principalsBackend, 'postgres');

    // clean slate for this run
    await pool.query('TRUNCATE wh_facts, living_features, service_principals RESTART IDENTITY');
  });

  test('pg: audit log appends and reads back', async () => {
    await store.audit({ actor: 'it-test', action: 'integration.check', resource: 'x/1', detail: { n: 1 } });
    const { rows } = await pool.query(`SELECT actor, action, outcome, detail FROM audit_log WHERE actor = 'it-test' ORDER BY id DESC LIMIT 1`);
    assert.equal(rows[0].action, 'integration.check');
    assert.equal(rows[0].outcome, 'success');
    assert.equal(rows[0].detail.n, 1);
  });

  test('pg: launch state round-trip is one-shot', async () => {
    await store.putLaunchState('it-state', { verifier: 'v' }, 60_000);
    assert.deepEqual(await store.takeLaunchState('it-state'), { verifier: 'v' });
    assert.equal(await store.takeLaunchState('it-state'), null); // consumed
  });

  test('pg: warehouse ingest/query/counts/replace', async () => {
    await warehouse.ingest('claims', [{ payer: 'Aetna', expected: 100 }, { payer: 'BCBS', expected: 200 }], { source: 'it' });
    assert.equal((await warehouse.query('claims')).length, 2);
    assert.equal((await warehouse.counts()).claims, 2);
    await warehouse.ingest('claims', [{ payer: 'Cigna', expected: 300 }], { replace: true });
    const rows = await warehouse.query('claims');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payer, 'Cigna');
  });

  test('pg: feature registry versioning, JSONB columns, lifecycle updates', async () => {
    const created = await featureRegistry.create({
      feature_key: 'it-report', version: 1, name: 'IT report', kind: 'report', tier: 1,
      spec: 'integration test', outcome: { rubric: ['works on postgres'] },
      definition: { kind: 'report', title: 'IT', blocks: [{ id: 'a', metric: 'arAging' }] },
      status: 'proposed', content_hash: 'hash1', engine_version: '1.0.0',
      created_by: 'it-test', test_evidence: { ok: true, snapshotHash: 's1' },
      history: [{ from: null, to: 'proposed' }],
    });
    assert.equal(created.version, 1);
    assert.deepEqual(created.outcome, { rubric: ['works on postgres'] });

    assert.equal(await featureRegistry.maxVersion('it-report'), 1);
    assert.equal(await featureRegistry.maxVersion('nope'), 0);

    const updates = transitionFeature(created, 'active', { by: 'it-test' });
    const updated = await featureRegistry.update(created.id, {
      ...updates, approved_by: 'it-test', attestation: { signature: 'sig', mode: 'ephemeral-dev' },
    });
    assert.equal(updated.status, 'active');
    assert.equal(updated.history.length, 2);
    assert.equal(updated.attestation.signature, 'sig');

    const active = await featureRegistry.list({ featureKey: 'it-report', status: 'active' });
    assert.equal(active.length, 1);
    assert.equal((await featureRegistry.list({ kind: 'report' })).length >= 1, true);
  });

  test('pg: principals mint/find/revoke with hashed tokens', async () => {
    const { principal, token } = await principals.create({ name: 'it-bot', roles: ['executive'], createdBy: 'it-test' });
    assert.ok(token.startsWith('vrad_sp_'));
    assert.equal(principal.token_hash, undefined);

    const found = await principals.findByToken(token);
    assert.equal(found.name, 'it-bot');
    assert.deepEqual(found.roles, ['executive']);

    await principals.revoke(principal.id);
    assert.equal(await principals.findByToken(token), null);

    // token is stored hashed, never in plaintext
    const { rows } = await pool.query(`SELECT token_hash FROM service_principals WHERE name = 'it-bot'`);
    assert.notEqual(rows[0].token_hash, token);
  });

  test('pg: teardown', async () => {
    await closeDb();
  });
}
