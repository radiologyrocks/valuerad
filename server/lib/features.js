/**
 * Living-feature registry — the system of record for generated features.
 *
 * Two interchangeable backends behind one interface, like lib/warehouse.js:
 *   - PostgresFeatureRegistry (durable)  — when DATABASE_URL is set
 *   - MemoryFeatureRegistry  (dev only)  — fallback
 *
 * Rows are versioned, never overwritten: a new version of a feature_key is a
 * new row; rollback re-points the active version. Status/history changes go
 * through domain/feature.js transitions, and every change is audited by the
 * routes layer.
 */

import { pool, databaseEnabled } from './db.js';

const COLUMNS = `id, feature_key, version, name, kind, tier, spec, definition, status,
  content_hash, engine_version, created_by, approved_by, test_evidence, history,
  created_at, updated_at`;

class PostgresFeatureRegistry {
  async create(f) {
    const { rows } = await pool.query(
      `INSERT INTO living_features
         (feature_key, version, name, kind, tier, spec, definition, status,
          content_hash, engine_version, created_by, test_evidence, history)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING ${COLUMNS}`,
      [
        f.feature_key, f.version, f.name, f.kind, f.tier, f.spec ?? null,
        f.definition, f.status, f.content_hash, f.engine_version,
        f.created_by ?? null, f.test_evidence ?? null, JSON.stringify(f.history ?? []),
      ]
    );
    return rows[0];
  }

  async get(id) {
    const { rows } = await pool.query(`SELECT ${COLUMNS} FROM living_features WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async list({ kind, status, featureKey } = {}) {
    const where = [];
    const args = [];
    if (kind) { args.push(kind); where.push(`kind = $${args.length}`); }
    if (status) { args.push(status); where.push(`status = $${args.length}`); }
    if (featureKey) { args.push(featureKey); where.push(`feature_key = $${args.length}`); }
    const { rows } = await pool.query(
      `SELECT ${COLUMNS} FROM living_features
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY feature_key, version DESC`,
      args
    );
    return rows;
  }

  async update(id, patch) {
    const sets = [];
    const args = [id];
    for (const [col, val] of Object.entries(patch)) {
      args.push(col === 'history' ? JSON.stringify(val) : val);
      sets.push(`${col} = $${args.length}`);
    }
    const { rows } = await pool.query(
      `UPDATE living_features SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
      args
    );
    return rows[0] ?? null;
  }

  async maxVersion(featureKey) {
    const { rows } = await pool.query(
      `SELECT COALESCE(MAX(version), 0)::int AS v FROM living_features WHERE feature_key = $1`,
      [featureKey]
    );
    return rows[0].v;
  }
}

class MemoryFeatureRegistry {
  constructor() {
    this.rows = [];
    this._seq = 0;
  }

  async create(f) {
    const row = {
      id: ++this._seq,
      spec: null, created_by: null, approved_by: null, test_evidence: null, history: [],
      ...f,
      created_at: new Date(),
      updated_at: new Date(),
    };
    this.rows.push(row);
    return { ...row };
  }

  async get(id) {
    const row = this.rows.find((r) => r.id === Number(id));
    return row ? { ...row } : null;
  }

  async list({ kind, status, featureKey } = {}) {
    return this.rows
      .filter((r) => (!kind || r.kind === kind) && (!status || r.status === status) && (!featureKey || r.feature_key === featureKey))
      .sort((a, b) => a.feature_key.localeCompare(b.feature_key) || b.version - a.version)
      .map((r) => ({ ...r }));
  }

  async update(id, patch) {
    const row = this.rows.find((r) => r.id === Number(id));
    if (!row) return null;
    Object.assign(row, patch, { updated_at: new Date() });
    return { ...row };
  }

  async maxVersion(featureKey) {
    return this.rows.filter((r) => r.feature_key === featureKey).reduce((m, r) => Math.max(m, r.version), 0);
  }
}

export const featureRegistry = databaseEnabled && pool ? new PostgresFeatureRegistry() : new MemoryFeatureRegistry();
export const featureRegistryBackend = databaseEnabled && pool ? 'postgres' : 'memory';

/** All active features of a kind (e.g. every active rule_pack). */
export async function activeFeatures(kind) {
  return featureRegistry.list({ kind, status: 'active' });
}

/** The single active version of a feature_key, or null. */
export async function activeByKey(featureKey) {
  const rows = await featureRegistry.list({ featureKey, status: 'active' });
  return rows[0] ?? null;
}

/**
 * Merge every active rule pack into one rules-as-data object for
 * domain/priorauth.authRequired. Later packs win per payer.
 */
export async function loadActiveRulePack() {
  const packs = await activeFeatures('rule_pack');
  if (packs.length === 0) return null;
  const payerRules = {};
  for (const p of packs) Object.assign(payerRules, p.definition?.payerRules ?? {});
  return { payerRules, sources: packs.map((p) => `${p.feature_key}@v${p.version}`) };
}
