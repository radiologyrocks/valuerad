/**
 * Postgres connection + idempotent schema migration.
 *
 * If DATABASE_URL is unset the server runs with an in-memory store (dev only).
 * lib/store.js decides which backend to use based on `pool`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

export const databaseEnabled = Boolean(process.env.DATABASE_URL);

export const pool = databaseEnabled
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX ?? 10),
    })
  : null;

export async function migrate() {
  if (!pool) return;
  const schema = readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('[db] schema migrated');
}

export async function closeDb() {
  if (pool) await pool.end();
}
