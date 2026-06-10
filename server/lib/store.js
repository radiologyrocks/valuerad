/**
 * Persistence layer for Stage 0.
 *
 * One interface, two backends:
 *   - PostgresStore  (durable, encrypted, audited)  — used when DATABASE_URL is set
 *   - MemoryStore    (dev only, non-durable)         — fallback, logs a warning
 *
 * Tokens are encrypted at rest by the Postgres backend (lib/crypto.js).
 * Every PHI read/write should be recorded via audit().
 */

import { pool, databaseEnabled } from './db.js';
import { encrypt, decrypt } from './crypto.js';

function expiresAt(tokenResponse) {
  const seconds = Number(tokenResponse?.expires_in ?? 0);
  return seconds > 0 ? new Date(Date.now() + seconds * 1000) : null;
}

// ---------------------------------------------------------------------------
// Postgres backend
// ---------------------------------------------------------------------------
class PostgresStore {
  async putLaunchState(state, data, ttlMs) {
    await pool.query(
      `INSERT INTO launch_states (state, data, expires_at)
       VALUES ($1, $2, now() + ($3::int * interval '1 millisecond'))
       ON CONFLICT (state) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
      [state, data, ttlMs]
    );
  }

  async takeLaunchState(state) {
    const { rows } = await pool.query(
      `DELETE FROM launch_states WHERE state = $1 AND expires_at > now() RETURNING data`,
      [state]
    );
    return rows[0]?.data ?? null;
  }

  async createSession({ id, fhirBaseUrl, tokenEndpoint, patientId, encounterId, patientResource, scope, tokens, ttlMs }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO sessions (id, fhir_base_url, token_endpoint, patient_id, encounter_id, patient_resource, scope, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8::int * interval '1 millisecond'))`,
        [id, fhirBaseUrl, tokenEndpoint ?? null, patientId, encounterId, patientResource ?? null, scope ?? null, ttlMs]
      );
      await client.query(
        `INSERT INTO oauth_tokens (session_id, access_token_enc, refresh_token_enc, token_type, scope, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          id,
          encrypt(tokens.access_token),
          encrypt(tokens.refresh_token ?? null),
          tokens.token_type ?? null,
          tokens.scope ?? null,
          expiresAt(tokens),
        ]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getSession(id) {
    const { rows } = await pool.query(
      `SELECT fhir_base_url, token_endpoint, patient_id, encounter_id, patient_resource, scope
       FROM sessions WHERE id = $1 AND expires_at > now()`,
      [id]
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      fhirBaseUrl: r.fhir_base_url,
      tokenEndpoint: r.token_endpoint,
      patientId: r.patient_id,
      encounterId: r.encounter_id,
      patientResource: r.patient_resource,
      scope: r.scope,
    };
  }

  async getSessionWithTokens(id) {
    const session = await this.getSession(id);
    if (!session) return null;
    const { rows } = await pool.query(
      `SELECT access_token_enc, refresh_token_enc, token_type, expires_at
       FROM oauth_tokens WHERE session_id = $1`,
      [id]
    );
    const t = rows[0];
    return {
      ...session,
      accessToken: t ? decrypt(t.access_token_enc) : null,
      refreshToken: t ? decrypt(t.refresh_token_enc) : null,
      tokenType: t?.token_type ?? null,
      tokenExpiresAt: t?.expires_at ?? null,
    };
  }

  async updateTokens(id, tokens) {
    await pool.query(
      `UPDATE oauth_tokens
       SET access_token_enc = $2,
           refresh_token_enc = COALESCE($3, refresh_token_enc),
           expires_at = $4,
           updated_at = now()
       WHERE session_id = $1`,
      [id, encrypt(tokens.access_token), tokens.refresh_token ? encrypt(tokens.refresh_token) : null, expiresAt(tokens)]
    );
  }

  async audit(entry) {
    await pool.query(
      `INSERT INTO audit_log (actor, session_id, action, resource, outcome, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        entry.actor ?? 'system',
        entry.sessionId ?? null,
        entry.action,
        entry.resource ?? null,
        entry.outcome ?? 'success',
        entry.detail ?? null,
      ]
    );
  }

  async createLead(lead) {
    const { rows } = await pool.query(
      `INSERT INTO leads (name, email, organization, message)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [lead.name, lead.email, lead.organization, lead.message ?? null]
    );
    return rows[0].id;
  }
}

// ---------------------------------------------------------------------------
// In-memory backend (dev only)
// ---------------------------------------------------------------------------
class MemoryStore {
  constructor() {
    this.launchStates = new Map();
    this.sessions = new Map();
    this.tokens = new Map();
    this.auditLog = [];
    this.leads = [];
    this._leadSeq = 0;
    console.warn('[store] DATABASE_URL not set — using in-memory store. Non-durable; dev only.');
  }

  async putLaunchState(state, data, ttlMs) {
    this.launchStates.set(state, { data, expiresAt: Date.now() + ttlMs });
  }

  async takeLaunchState(state) {
    const entry = this.launchStates.get(state);
    this.launchStates.delete(state);
    if (!entry || entry.expiresAt < Date.now()) return null;
    return entry.data;
  }

  async createSession({ id, fhirBaseUrl, tokenEndpoint, patientId, encounterId, patientResource, scope, tokens, ttlMs }) {
    this.sessions.set(id, {
      fhirBaseUrl,
      tokenEndpoint,
      patientId,
      encounterId,
      patientResource,
      scope,
      expiresAt: Date.now() + ttlMs,
    });
    this.tokens.set(id, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenType: tokens.token_type ?? null,
      tokenExpiresAt: expiresAt(tokens),
    });
  }

  async getSession(id) {
    const s = this.sessions.get(id);
    if (!s || s.expiresAt < Date.now()) return null;
    const { expiresAt: _omit, ...safe } = s;
    return safe;
  }

  async getSessionWithTokens(id) {
    const session = await this.getSession(id);
    if (!session) return null;
    return { ...session, ...(this.tokens.get(id) ?? {}) };
  }

  async updateTokens(id, tokens) {
    const existing = this.tokens.get(id) ?? {};
    this.tokens.set(id, {
      ...existing,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? existing.refreshToken ?? null,
      tokenExpiresAt: expiresAt(tokens),
    });
  }

  async audit(entry) {
    this.auditLog.push({ at: new Date(), outcome: 'success', actor: 'system', ...entry });
  }

  async createLead(lead) {
    const id = ++this._leadSeq;
    this.leads.push({ id, ...lead, created_at: new Date() });
    return id;
  }
}

export const store = databaseEnabled && pool ? new PostgresStore() : new MemoryStore();
export const storeBackend = databaseEnabled && pool ? 'postgres' : 'memory';
