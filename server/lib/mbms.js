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

import fetch from 'node-fetch';

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
let _singleton = null;

export function createMbmsClient() {
  const source = (process.env.MBMS_SOURCE ?? 'mock').toLowerCase();
  if (source === 'api') return new MbmsApiSource();
  return new MbmsMockSource();
}

/** Process-wide MBMS client (mock state persists across requests in dev). */
export function getMbmsClient() {
  if (!_singleton) _singleton = createMbmsClient();
  return _singleton;
}
