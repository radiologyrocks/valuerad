/**
 * MBMS billing-exception adapter.
 *
 * MBMS is the radiology group's outside billing company. When a claim is
 * rejected because the image/charge doesn't match the dictation or technique
 * (e.g. a CT charged with contrast but the report says "without contrast",
 * or a missing laterality), MBMS sends an "exception" that a radiologist must
 * resolve with an addendum. Today that data lives in a separate web portal and
 * has to be re-keyed by hand into PowerScribe.
 *
 * This module normalizes whatever MBMS exposes into a single `BillingException`
 * shape so the rest of the app never has to care about the source. Two sources
 * are provided:
 *
 *   - MbmsApiSource  — talks to a real MBMS REST API (endpoints/auth are
 *                      configurable; the exact contract must be confirmed with
 *                      MBMS — see the TODOs).
 *   - MbmsMockSource — in-memory seed data for local dev / demo / tests, so the
 *                      whole workflow runs end-to-end without MBMS credentials.
 *
 * Select the source with the MBMS_SOURCE env var ("api" | "mock", default mock).
 *
 * Normalized BillingException:
 *   {
 *     id,                 // stable id within the source
 *     exceptionNumber,    // the number the radiologist types into PowerScribe today
 *     status,             // 'open' | 'in_progress' | 'resolved'
 *     receivedAt,         // ISO timestamp
 *     accessionNumber,    // links the exception to the imaging study / report
 *     studyDescription,   // human-readable exam name
 *     modality,           // 'CT' | 'MR' | 'US' | 'XR' | 'NM' | ...
 *     patient: { mrn, name, dob },
 *     cptCode,            // billed CPT
 *     icd10Codes: [],     // diagnosis codes on the claim
 *     category,           // coarse reason bucket — drives addendum guidance
 *     reason,             // free-text description of the mismatch from MBMS
 *     payer,              // insurer that flagged the claim
 *     dateOfService,
 *     notes,              // anything else MBMS sent
 *     raw,                // the untouched source record (for debugging)
 *   }
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import fetch from 'node-fetch';
import { parseExceptionFile } from './mbms-parsers.js';

// ---------------------------------------------------------------------------
// Categories — coarse buckets we map MBMS reasons into. These steer the
// addendum prompt (see lib/addendum.js) so the LLM knows what kind of
// reconciliation the biller is asking for.
// ---------------------------------------------------------------------------
export const EXCEPTION_CATEGORIES = {
  TECHNIQUE_MISMATCH: 'technique_mismatch', // report technique vs. charge disagree
  CONTRAST_MISMATCH: 'contrast_mismatch',   // with/without/with-and-without contrast
  LATERALITY: 'laterality',                 // missing/incorrect left/right/bilateral
  BODY_PART_MISMATCH: 'body_part_mismatch', // charged region vs. dictated region
  MISSING_DOCUMENTATION: 'missing_documentation', // medical necessity / element absent
  CODE_MISMATCH: 'code_mismatch',           // CPT vs. dictation
  OTHER: 'other',
};

/**
 * Best-effort mapping of an MBMS free-text reason to a category. Sites word
 * these differently, so keep the heuristics generous and fall back to OTHER.
 */
export function categorizeReason(reason = '') {
  const r = reason.toLowerCase();
  if (/(contrast|with and without|w\/o contrast|without contrast|with contrast)/.test(r)) {
    return EXCEPTION_CATEGORIES.CONTRAST_MISMATCH;
  }
  if (/(laterality|left|right|bilateral|side)/.test(r)) {
    return EXCEPTION_CATEGORIES.LATERALITY;
  }
  if (/(technique|protocol|phase|sequence)/.test(r)) {
    return EXCEPTION_CATEGORIES.TECHNIQUE_MISMATCH;
  }
  if (/(body part|region|anatomy|wrong exam|exam mismatch)/.test(r)) {
    return EXCEPTION_CATEGORIES.BODY_PART_MISMATCH;
  }
  if (/(cpt|code|charge code|miscoded)/.test(r)) {
    return EXCEPTION_CATEGORIES.CODE_MISMATCH;
  }
  if (/(medical necessity|documentation|missing|not documented|indication)/.test(r)) {
    return EXCEPTION_CATEGORIES.MISSING_DOCUMENTATION;
  }
  return EXCEPTION_CATEGORIES.OTHER;
}

/**
 * Normalize an arbitrary MBMS API record into a BillingException. The field
 * names below are a reasonable guess; adjust the right-hand side once the real
 * MBMS payload is known (a single edit here updates the whole app).
 */
export function normalizeMbmsRecord(rec = {}) {
  const reason = rec.reason ?? rec.denialReason ?? rec.description ?? '';
  return {
    id: String(rec.id ?? rec.exceptionId ?? rec.exceptionNumber ?? rec.accessionNumber),
    exceptionNumber: String(rec.exceptionNumber ?? rec.exceptionId ?? rec.id ?? ''),
    status: normalizeStatus(rec.status),
    receivedAt: rec.receivedAt ?? rec.createdAt ?? new Date().toISOString(),
    accessionNumber: String(rec.accessionNumber ?? rec.accession ?? ''),
    studyDescription: rec.studyDescription ?? rec.examDescription ?? rec.procedure ?? '',
    modality: rec.modality ?? '',
    patient: {
      mrn: String(rec.mrn ?? rec.patientMrn ?? rec.patient?.mrn ?? ''),
      name: rec.patientName ?? rec.patient?.name ?? '',
      dob: rec.patientDob ?? rec.dob ?? rec.patient?.dob ?? '',
    },
    cptCode: String(rec.cptCode ?? rec.cpt ?? ''),
    icd10Codes: rec.icd10Codes ?? rec.icd10 ?? rec.diagnosisCodes ?? [],
    category: rec.category ?? categorizeReason(reason),
    reason,
    payer: rec.payer ?? rec.insurance ?? '',
    dateOfService: rec.dateOfService ?? rec.dos ?? '',
    notes: rec.notes ?? '',
    raw: rec,
  };
}

function normalizeStatus(status) {
  const s = String(status ?? '').toLowerCase();
  if (['resolved', 'closed', 'complete', 'completed'].includes(s)) return 'resolved';
  if (['in_progress', 'in progress', 'working', 'assigned'].includes(s)) return 'in_progress';
  return 'open';
}

// ===========================================================================
// API source
// ===========================================================================
class MbmsApiSource {
  constructor({ baseUrl, apiKey, authHeader } = {}) {
    this.baseUrl = (baseUrl ?? process.env.MBMS_API_BASE_URL ?? '').replace(/\/$/, '');
    this.apiKey = apiKey ?? process.env.MBMS_API_KEY ?? '';
    // Some vendors use "Authorization: Bearer", others "X-API-Key". Configurable.
    this.authHeader = authHeader ?? process.env.MBMS_AUTH_HEADER ?? 'Authorization';
    if (!this.baseUrl) {
      throw new Error('MBMS_API_BASE_URL is required when MBMS_SOURCE=api');
    }
  }

  _headers() {
    const headers = { Accept: 'application/json' };
    if (this.apiKey) {
      headers[this.authHeader] =
        this.authHeader === 'Authorization' ? `Bearer ${this.apiKey}` : this.apiKey;
    }
    return headers;
  }

  async _get(path, params = {}) {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\//, '')}`);
    Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
    const res = await fetch(url.toString(), { headers: this._headers() });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`MBMS ${path} failed (${res.status}): ${JSON.stringify(data)}`);
    }
    return data;
  }

  // TODO: confirm the real MBMS endpoint + response envelope with the vendor.
  // Common shapes: { data: [...] }, { exceptions: [...] }, or a bare array.
  async listExceptions({ status } = {}) {
    const data = await this._get('exceptions', { status });
    const records = data?.data ?? data?.exceptions ?? (Array.isArray(data) ? data : []);
    return records.map(normalizeMbmsRecord);
  }

  async getException(id) {
    const data = await this._get(`exceptions/${encodeURIComponent(id)}`);
    return normalizeMbmsRecord(data?.data ?? data);
  }

  // TODO: confirm whether MBMS supports write-back (marking an exception
  // resolved). If not, resolution is tracked locally and reconciled out-of-band.
  async markResolved(id, { addendumText, resolvedBy } = {}) {
    const res = await fetch(
      `${this.baseUrl}/exceptions/${encodeURIComponent(id)}/resolve`,
      {
        method: 'POST',
        headers: { ...this._headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ addendumText, resolvedBy, resolvedAt: new Date().toISOString() }),
      }
    );
    if (!res.ok) {
      throw new Error(`MBMS markResolved failed (${res.status})`);
    }
    return { id, status: 'resolved' };
  }
}

// ===========================================================================
// Mock source — realistic radiology-billing seed data so the workflow runs
// end-to-end without MBMS access.
// ===========================================================================
const MOCK_SEED = [
  {
    id: 'EX-100482',
    exceptionNumber: '100482',
    status: 'open',
    receivedAt: '2026-06-05T13:22:00Z',
    accessionNumber: 'A10293847',
    studyDescription: 'CT ABDOMEN AND PELVIS',
    modality: 'CT',
    mrn: 'MRN0093122',
    patientName: 'Garcia, Robert',
    patientDob: '1958-03-11',
    cptCode: '74178',
    icd10Codes: ['R10.9'],
    reason:
      'Claim billed as CT abdomen/pelvis WITH AND WITHOUT contrast (74178), but the '
      + 'report technique states "without IV contrast" only. Please reconcile technique '
      + 'with the charge or addend the report.',
    payer: 'Medicare',
    dateOfService: '2026-05-28',
  },
  {
    id: 'EX-100517',
    exceptionNumber: '100517',
    status: 'open',
    receivedAt: '2026-06-06T09:05:00Z',
    accessionNumber: 'A10294511',
    studyDescription: 'US EXTREMITY NON-VASCULAR',
    modality: 'US',
    mrn: 'MRN0088410',
    patientName: 'Nguyen, Linda',
    patientDob: '1971-09-02',
    cptCode: '76882',
    icd10Codes: ['M25.561'],
    reason:
      'Laterality not documented. Order and charge specify RIGHT knee, but the report '
      + 'impression does not state a side. Payer requires laterality in the body of the report.',
    payer: 'Aetna',
    dateOfService: '2026-05-30',
  },
  {
    id: 'EX-100533',
    exceptionNumber: '100533',
    status: 'in_progress',
    receivedAt: '2026-06-06T15:48:00Z',
    accessionNumber: 'A10295003',
    studyDescription: 'MRI BRAIN',
    modality: 'MR',
    mrn: 'MRN0101547',
    patientName: 'Okafor, James',
    patientDob: '1984-12-19',
    cptCode: '70553',
    icd10Codes: ['G43.909'],
    reason:
      'Billed as MRI brain WITH AND WITHOUT contrast (70553). Report technique lists '
      + 'pre- and post-gadolinium sequences but the impression does not mention contrast '
      + 'administration. Confirm contrast was given and addend the technique/impression.',
    payer: 'UnitedHealthcare',
    dateOfService: '2026-06-01',
  },
  {
    id: 'EX-100540',
    exceptionNumber: '100540',
    status: 'resolved',
    receivedAt: '2026-06-04T11:10:00Z',
    accessionNumber: 'A10291002',
    studyDescription: 'XR CHEST 2 VIEWS',
    modality: 'XR',
    mrn: 'MRN0077215',
    patientName: 'Petrov, Anna',
    patientDob: '1990-06-25',
    cptCode: '71046',
    icd10Codes: ['R05.9'],
    reason: 'Number of views did not match charge. Resolved 2026-06-05.',
    payer: 'Cigna',
    dateOfService: '2026-05-25',
  },
];

class MbmsMockSource {
  constructor() {
    this.records = MOCK_SEED.map((r) => ({ ...r }));
  }

  async listExceptions({ status } = {}) {
    let recs = this.records;
    if (status) recs = recs.filter((r) => normalizeStatus(r.status) === status);
    return recs.map(normalizeMbmsRecord);
  }

  async getException(id) {
    const rec = this.records.find((r) => String(r.id) === String(id) || String(r.exceptionNumber) === String(id));
    if (!rec) return null;
    return normalizeMbmsRecord(rec);
  }

  async markResolved(id, { addendumText, resolvedBy } = {}) {
    const rec = this.records.find((r) => String(r.id) === String(id) || String(r.exceptionNumber) === String(id));
    if (!rec) throw new Error(`Unknown exception ${id}`);
    rec.status = 'resolved';
    rec.notes = `Resolved by ${resolvedBy ?? 'unknown'} at ${new Date().toISOString()}`;
    rec.resolvedAddendum = addendumText;
    return normalizeMbmsRecord(rec);
  }
}

// ===========================================================================
// File source — reads CSV exports and/or X12 835 ERA files from a directory
// (an SFTP drop or a portal export folder). This is the most likely real-world
// MBMS channel, since their Resolve platform has no public API.
// ===========================================================================
class MbmsFileSource {
  constructor({ dir } = {}) {
    this.dir = dir ?? process.env.MBMS_FILE_DIR ?? '';
    if (!this.dir) {
      throw new Error('MBMS_FILE_DIR is required when MBMS_SOURCE=file');
    }
    this.columnMap = parseJsonEnv('MBMS_CSV_COLUMNS');
    // Resolutions are tracked locally — inbound files are read-only.
    this._resolved = new Map();
  }

  async _readAll() {
    let names;
    try {
      names = await fs.readdir(this.dir);
    } catch (err) {
      throw new Error(`Cannot read MBMS_FILE_DIR (${this.dir}): ${err.message}`);
    }
    const files = names.filter((n) => /\.(csv|txt|835|era|edi)$/i.test(n));
    const all = [];
    for (const name of files) {
      const text = await fs.readFile(path.join(this.dir, name), 'utf8');
      try {
        for (const rec of parseExceptionFile(text, { columnMap: this.columnMap })) {
          all.push({ ...rec, _sourceFile: name });
        }
      } catch (err) {
        console.error(`[mbms-file] failed to parse ${name}: ${err.message}`);
      }
    }
    return all;
  }

  async listExceptions({ status } = {}) {
    const raw = await this._readAll();
    const exceptions = raw.map((rec) => {
      const norm = normalizeMbmsRecord(rec);
      if (this._resolved.has(norm.id)) norm.status = 'resolved';
      return norm;
    });
    return status ? exceptions.filter((e) => e.status === status) : exceptions;
  }

  async getException(id) {
    const all = await this.listExceptions();
    return all.find((e) => e.id === String(id) || e.exceptionNumber === String(id)) ?? null;
  }

  async markResolved(id, { addendumText, resolvedBy } = {}) {
    this._resolved.set(String(id), { addendumText, resolvedBy, at: new Date().toISOString() });
    const ex = await this.getException(id);
    return ex ?? { id, status: 'resolved' };
  }
}

// ===========================================================================
// Waystar source — Waystar is the clearinghouse/denial-management platform MBMS
// is known to use (waystar.com/insights-resources MBMS case study). Unlike
// MBMS's own Resolve, Waystar publishes a REST API (eligibility, claim status
// 276/277, remittance 835, denial + appeal management). Access requires
// Waystar API credentials scoped to the account — typically OAuth2 client
// credentials. Endpoint paths below must be confirmed against Waystar's API
// docs / your account's API enablement.
// ===========================================================================
class WaystarSource {
  constructor({ baseUrl, clientId, clientSecret } = {}) {
    this.baseUrl = (baseUrl ?? process.env.WAYSTAR_API_BASE_URL ?? '').replace(/\/$/, '');
    this.clientId = clientId ?? process.env.WAYSTAR_CLIENT_ID ?? '';
    this.clientSecret = clientSecret ?? process.env.WAYSTAR_CLIENT_SECRET ?? '';
    this.tokenUrl = process.env.WAYSTAR_TOKEN_URL ?? `${this.baseUrl}/oauth/token`;
    if (!this.baseUrl) {
      throw new Error('WAYSTAR_API_BASE_URL is required when MBMS_SOURCE=waystar');
    }
    this._token = null;
    this._tokenExp = 0;
  }

  async _accessToken() {
    if (this._token && Date.now() < this._tokenExp - 30_000) return this._token;
    // OAuth2 client-credentials grant (confirm with Waystar's API docs).
    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Waystar token failed (${res.status}): ${JSON.stringify(data)}`);
    this._token = data.access_token;
    this._tokenExp = Date.now() + (data.expires_in ?? 3600) * 1000;
    return this._token;
  }

  async _get(path, params = {}) {
    const token = await this._accessToken();
    const url = new URL(`${this.baseUrl}/${path.replace(/^\//, '')}`);
    Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Waystar ${path} failed (${res.status}): ${JSON.stringify(data)}`);
    return data;
  }

  // TODO: confirm the denial endpoint + response envelope with Waystar.
  async listExceptions({ status } = {}) {
    const data = await this._get('denials', { status });
    const records = data?.data ?? data?.denials ?? (Array.isArray(data) ? data : []);
    return records.map(normalizeWaystarDenial);
  }

  async getException(id) {
    const data = await this._get(`denials/${encodeURIComponent(id)}`);
    return normalizeWaystarDenial(data?.data ?? data);
  }

  // Waystar exposes appeal-management endpoints; resolving here could file/track
  // an appeal note. Confirm the contract before enabling write-back.
  async markResolved(id, { addendumText, resolvedBy } = {}) {
    const token = await this._accessToken();
    const res = await fetch(`${this.baseUrl}/denials/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ note: addendumText, resolvedBy, resolvedAt: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`Waystar markResolved failed (${res.status})`);
    return { id, status: 'resolved' };
  }
}

/** Map a Waystar denial record into our normalized shape. */
function normalizeWaystarDenial(rec = {}) {
  return normalizeMbmsRecord({
    id: rec.denialId ?? rec.id,
    exceptionNumber: rec.claimNumber ?? rec.claimId ?? rec.id,
    status: rec.status,
    accessionNumber: rec.accessionNumber ?? rec.accession ?? '',
    studyDescription: rec.procedureDescription ?? rec.serviceDescription ?? '',
    modality: rec.modality ?? '',
    mrn: rec.patientMrn ?? rec.mrn ?? '',
    patientName: rec.patientName ?? '',
    cptCode: rec.procedureCode ?? rec.cpt ?? '',
    icd10Codes: rec.diagnosisCodes ?? [],
    // Waystar denials carry CARC/RARC codes — surface them as the reason.
    reason: rec.denialReason
      ?? [rec.carcCode && `[${rec.carcCode}]`, rec.carcDescription].filter(Boolean).join(' ')
      ?? '',
    payer: rec.payerName ?? rec.payer ?? '',
    dateOfService: rec.dateOfService ?? rec.dos ?? '',
    raw: rec,
  });
}

function parseJsonEnv(name) {
  const v = process.env[name];
  if (!v) return undefined;
  try { return JSON.parse(v); } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
let _singleton = null;

export function createMbmsClient() {
  const source = (process.env.MBMS_SOURCE ?? 'mock').toLowerCase();
  switch (source) {
    case 'api': return new MbmsApiSource();
    case 'file': return new MbmsFileSource();
    case 'waystar': return new WaystarSource();
    default: return new MbmsMockSource();
  }
}

/** Process-wide MBMS client (mock state persists across requests in dev). */
export function getMbmsClient() {
  if (!_singleton) _singleton = createMbmsClient();
  return _singleton;
}
