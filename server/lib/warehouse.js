/**
 * BI warehouse — fact ingestion + query.
 *
 * Two interchangeable backends behind one interface:
 *   - PostgresWarehouse (durable)   — when DATABASE_URL is set
 *   - MemoryWarehouse (dev only)    — fallback
 *
 * A "dataset" is a kind of fact: claims | appointments | studies | slots |
 * referrals | referrals_prior. Rows arrive from CSV extracts or direct JSON and
 * are stored as-is; domain/bi.js coerces fields as it reads them.
 */

import { pool, databaseEnabled } from './db.js';

export const DATASETS = ['claims', 'appointments', 'studies', 'slots', 'referrals', 'referrals_prior'];

class PostgresWarehouse {
  async ingest(dataset, rows, { source = null, replace = false } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (replace) await client.query('DELETE FROM wh_facts WHERE dataset = $1', [dataset]);
      let count = 0;
      for (const row of rows) {
        await client.query('INSERT INTO wh_facts (dataset, payload, source) VALUES ($1,$2,$3)', [dataset, row, source]);
        count++;
      }
      await client.query('COMMIT');
      return count;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async query(dataset) {
    const { rows } = await pool.query('SELECT payload FROM wh_facts WHERE dataset = $1 ORDER BY id', [dataset]);
    return rows.map((r) => r.payload);
  }

  async counts() {
    const { rows } = await pool.query('SELECT dataset, count(*)::int AS n FROM wh_facts GROUP BY dataset');
    return Object.fromEntries(rows.map((r) => [r.dataset, r.n]));
  }
}

class MemoryWarehouse {
  constructor() {
    this.data = new Map();
  }
  async ingest(dataset, rows, { replace = false } = {}) {
    const existing = replace ? [] : this.data.get(dataset) ?? [];
    this.data.set(dataset, existing.concat(rows));
    return rows.length;
  }
  async query(dataset) {
    return this.data.get(dataset) ?? [];
  }
  async counts() {
    return Object.fromEntries([...this.data.entries()].map(([k, v]) => [k, v.length]));
  }
}

export const warehouse = databaseEnabled && pool ? new PostgresWarehouse() : new MemoryWarehouse();
export const warehouseBackend = databaseEnabled && pool ? 'postgres' : 'memory';

/** Pull every dataset the snapshot/scorecard needs into one object. */
export async function loadDatasets() {
  const out = {};
  for (const ds of DATASETS) out[ds] = await warehouse.query(ds);
  return out;
}
