/**
 * Service principals — first-class machine identities for agents and
 * integrations (the MCP surface, CI, a tenant's own bots).
 *
 * Every autonomous actor gets its OWN identity with scoped roles, not a
 * shared role string: audit rows answer "which agent, authorized by whom,
 * to do what". Tokens (`vrad_sp_...`) are stored as SHA-256 hashes; the
 * plaintext is returned exactly once at creation. Revocation is a flag flip.
 *
 * Two backends behind one interface, like every other store in lib/.
 */

import { createHash, randomBytes } from 'node:crypto';
import { pool, databaseEnabled } from './db.js';

export const TOKEN_PREFIX = 'vrad_sp_';

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function mintToken() {
  return TOKEN_PREFIX + randomBytes(24).toString('hex');
}

function publicPrincipal(row) {
  if (!row) return null;
  const { token_hash: _omit, ...safe } = row;
  return safe;
}

class PostgresPrincipals {
  async create({ name, roles, createdBy }) {
    const token = mintToken();
    const { rows } = await pool.query(
      `INSERT INTO service_principals (name, token_hash, roles, created_by)
       VALUES ($1,$2,$3,$4)
       RETURNING id, name, roles, is_active, created_by, created_at`,
      [name, hashToken(token), JSON.stringify(roles), createdBy ?? null]
    );
    return { principal: rows[0], token };
  }

  async findByToken(token) {
    const { rows } = await pool.query(
      `UPDATE service_principals SET last_used_at = now()
       WHERE token_hash = $1 AND is_active
       RETURNING id, name, roles, is_active, created_by, created_at`,
      [hashToken(token)]
    );
    return rows[0] ?? null;
  }

  async list() {
    const { rows } = await pool.query(
      `SELECT id, name, roles, is_active, created_by, created_at, last_used_at
       FROM service_principals ORDER BY id`
    );
    return rows;
  }

  async revoke(id) {
    const { rows } = await pool.query(
      `UPDATE service_principals SET is_active = false WHERE id = $1
       RETURNING id, name, roles, is_active`,
      [id]
    );
    return rows[0] ?? null;
  }
}

class MemoryPrincipals {
  constructor() {
    this.rows = [];
    this._seq = 0;
  }

  async create({ name, roles, createdBy }) {
    if (this.rows.some((r) => r.name === name)) throw new Error(`principal "${name}" already exists`);
    const token = mintToken();
    const row = {
      id: ++this._seq,
      name,
      token_hash: hashToken(token),
      roles,
      is_active: true,
      created_by: createdBy ?? null,
      created_at: new Date(),
      last_used_at: null,
    };
    this.rows.push(row);
    return { principal: publicPrincipal(row), token };
  }

  async findByToken(token) {
    const hash = hashToken(token);
    const row = this.rows.find((r) => r.token_hash === hash && r.is_active);
    if (!row) return null;
    row.last_used_at = new Date();
    return publicPrincipal(row);
  }

  async list() {
    return this.rows.map(publicPrincipal);
  }

  async revoke(id) {
    const row = this.rows.find((r) => r.id === Number(id));
    if (!row) return null;
    row.is_active = false;
    return publicPrincipal(row);
  }
}

export const principals = databaseEnabled && pool ? new PostgresPrincipals() : new MemoryPrincipals();
export const principalsBackend = databaseEnabled && pool ? 'postgres' : 'memory';
