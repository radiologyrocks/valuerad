/**
 * PowerScribe adapter.
 *
 * PowerScribe (Nuance / Microsoft — "PowerScribe 360 | Reporting" and the newer
 * "PowerScribe One") is the radiology dictation/reporting system. Today the
 * radiologist manually types the MBMS exception/accession number into
 * PowerScribe to pull up the correct report, reads it, then dictates an
 * addendum. This adapter automates the two integration points we need:
 *
 *   1. Read the existing signed report text for an accession (so the LLM can
 *      draft an addendum grounded in what was actually dictated).
 *   2. Push a *draft* addendum back onto that report for the radiologist to
 *      review, edit, and sign. We never auto-sign — a human always signs.
 *
 *   It also produces a launch URL/handle that opens the study directly in
 *   PowerScribe, replacing the manual accession-number lookup.
 *
 * PowerScribe exposes a SOAP/REST "Reporting" web-services API; the exact
 * endpoint shape and auth differ by version and are typically provisioned by
 * the Nuance/site integration team. The real calls are stubbed below with the
 * fields we need and clear TODOs. A mock source lets the workflow run without a
 * live PowerScribe connection.
 *
 * Select with POWERSCRIBE_SOURCE ("api" | "mock", default mock).
 */

import fetch from 'node-fetch';

/**
 * Build the URL/handle the front-end uses to open a study in PowerScribe.
 * PowerScribe desktop is commonly launched via a custom URI scheme or a
 * site-hosted launch endpoint that takes the accession number. Both are
 * configurable; default to a query-string launch endpoint.
 */
export function buildLaunchUrl(accession) {
  const base = process.env.POWERSCRIBE_LAUNCH_URL ?? '';
  const scheme = process.env.POWERSCRIBE_LAUNCH_SCHEME ?? ''; // e.g. "powerscribe://open?accession="
  if (scheme) return `${scheme}${encodeURIComponent(accession)}`;
  if (base) {
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}accession=${encodeURIComponent(accession)}`;
  }
  // No launch target configured — return a relative marker the UI can show.
  return `#powerscribe-launch-not-configured-${encodeURIComponent(accession)}`;
}

// ===========================================================================
// API source
// ===========================================================================
class PowerScribeApiSource {
  constructor({ baseUrl, apiKey } = {}) {
    this.baseUrl = (baseUrl ?? process.env.POWERSCRIBE_API_BASE_URL ?? '').replace(/\/$/, '');
    this.apiKey = apiKey ?? process.env.POWERSCRIBE_API_KEY ?? '';
    if (!this.baseUrl) {
      throw new Error('POWERSCRIBE_API_BASE_URL is required when POWERSCRIBE_SOURCE=api');
    }
  }

  _headers(extra = {}) {
    const headers = { Accept: 'application/json', ...extra };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    return headers;
  }

  // TODO: confirm the PowerScribe report-lookup endpoint with the Nuance/site
  // integration team. Returns the report metadata + narrative for an accession.
  async getReport(accession) {
    const url = `${this.baseUrl}/reports?accession=${encodeURIComponent(accession)}`;
    const res = await fetch(url, { headers: this._headers() });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`PowerScribe getReport failed (${res.status}): ${JSON.stringify(data)}`);
    }
    const rec = data?.data ?? (Array.isArray(data) ? data[0] : data);
    if (!rec) return null;
    return {
      accessionNumber: accession,
      reportId: rec.reportId ?? rec.id ?? null,
      status: rec.status ?? 'unknown', // 'final' | 'preliminary' | 'addended' | ...
      signedBy: rec.signedBy ?? rec.radiologist ?? '',
      signedAt: rec.signedAt ?? '',
      text: rec.text ?? rec.narrative ?? rec.body ?? '',
      sections: rec.sections ?? null, // { technique, findings, impression, ... } if available
      raw: rec,
    };
  }

  async getReportText(accession) {
    const report = await this.getReport(accession);
    return report?.text ?? '';
  }

  // TODO: confirm the addendum-create endpoint. We always create a *draft*
  // (unsigned) addendum so the radiologist reviews and signs in PowerScribe.
  async createAddendumDraft({ accession, text, author }) {
    const url = `${this.baseUrl}/reports/addendum`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        accession,
        author,
        text,
        sign: false, // never auto-sign — human-in-the-loop
        createdAt: new Date().toISOString(),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`PowerScribe createAddendumDraft failed (${res.status}): ${JSON.stringify(data)}`);
    }
    return {
      accessionNumber: accession,
      addendumId: data.addendumId ?? data.id ?? null,
      status: 'draft',
      launchUrl: buildLaunchUrl(accession),
    };
  }
}

// ===========================================================================
// Mock source
// ===========================================================================
const MOCK_REPORTS = {
  A10293847: {
    status: 'final',
    signedBy: 'Dr. Elliott Brown',
    signedAt: '2026-05-28T18:40:00Z',
    text:
`EXAM: CT ABDOMEN AND PELVIS

CLINICAL HISTORY: Abdominal pain.

TECHNIQUE: Axial CT images of the abdomen and pelvis were obtained without IV contrast. Oral contrast was administered. Multiplanar reformations were generated.

FINDINGS:
Lung bases are clear. Liver, spleen, pancreas, adrenal glands, and kidneys are unremarkable without contrast. No hydronephrosis. No free air or free fluid. No bowel obstruction. No acute osseous abnormality.

IMPRESSION:
No acute intra-abdominal or pelvic abnormality.`,
  },
  A10294511: {
    status: 'final',
    signedBy: 'Dr. Elliott Brown',
    signedAt: '2026-05-30T16:12:00Z',
    text:
`EXAM: ULTRASOUND OF THE EXTREMITY

CLINICAL HISTORY: Knee pain, evaluate for effusion.

TECHNIQUE: Grayscale ultrasound images of the knee were obtained.

FINDINGS:
There is a small joint effusion. No discrete Baker cyst. Quadriceps and patellar tendons are intact. No focal collection.

IMPRESSION:
Small joint effusion. No Baker cyst.`,
  },
  A10295003: {
    status: 'final',
    signedBy: 'Dr. Elliott Brown',
    signedAt: '2026-06-01T20:05:00Z',
    text:
`EXAM: MRI BRAIN

CLINICAL HISTORY: Headache, history of migraine.

TECHNIQUE: Multiplanar, multisequence MRI of the brain was performed on a 1.5T scanner, including pre- and post-gadolinium T1-weighted sequences, T2/FLAIR, DWI, and SWI.

FINDINGS:
No acute infarct on DWI. No intracranial hemorrhage. No mass, midline shift, or abnormal enhancement. Ventricles and sulci are normal for age. Paranasal sinuses are clear.

IMPRESSION:
No acute intracranial abnormality.`,
  },
};

class PowerScribeMockSource {
  async getReport(accession) {
    const rec = MOCK_REPORTS[accession];
    if (!rec) return null;
    return {
      accessionNumber: accession,
      reportId: `RPT-${accession}`,
      status: rec.status,
      signedBy: rec.signedBy,
      signedAt: rec.signedAt,
      text: rec.text,
      sections: null,
      raw: rec,
    };
  }

  async getReportText(accession) {
    const report = await this.getReport(accession);
    return report?.text ?? '';
  }

  async createAddendumDraft({ accession, text, author }) {
    // In mock mode we just echo back a synthetic draft handle.
    return {
      accessionNumber: accession,
      addendumId: `ADD-${accession}-${Date.now()}`,
      status: 'draft',
      author,
      text,
      launchUrl: buildLaunchUrl(accession),
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createPowerScribeClient() {
  const source = (process.env.POWERSCRIBE_SOURCE ?? 'mock').toLowerCase();
  if (source === 'api') return new PowerScribeApiSource();
  return new PowerScribeMockSource();
}

let _singleton = null;
export function getPowerScribeClient() {
  if (!_singleton) _singleton = createPowerScribeClient();
  return _singleton;
}
