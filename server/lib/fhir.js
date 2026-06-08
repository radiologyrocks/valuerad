/**
 * Thin FHIR R4 client. Pass an access token; handles Bearer auth and
 * returns parsed JSON or throws on HTTP error.
 */

import fetch from 'node-fetch';

export class FhirClient {
  constructor({ baseUrl, accessToken }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.accessToken = accessToken;
  }

  async _get(path, params = {}) {
    const url = new URL(`${this.baseUrl}/${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/fhir+json',
      },
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(`FHIR ${path} failed (${res.status}): ${JSON.stringify(data)}`);
    }
    return data;
  }

  patient(id)          { return this._get(`Patient/${id}`); }
  encounter(id)        { return this._get(`Encounter/${id}`); }
  serviceRequests(patientId) {
    return this._get('ServiceRequest', { patient: patientId, _sort: '-authored' });
  }
  diagnosticReports(patientId) {
    return this._get('DiagnosticReport', { patient: patientId, _sort: '-issued' });
  }
  appointments(patientId) {
    return this._get('Appointment', { patient: patientId, _sort: 'date' });
  }

  // ---------------------------------------------------------------------------
  // Accession-based lookups — the bridge between a billing exception (which
  // carries the radiology accession number) and the Epic study/report it refers
  // to. `accessionSystem` is the identifier system Epic assigns to accessions;
  // it varies by site, so it's configurable via ACCESSION_IDENTIFIER_SYSTEM.
  // ---------------------------------------------------------------------------

  /**
   * Find the DiagnosticReport for a radiology accession number.
   * Returns the first matching report, or null if none is found.
   */
  async diagnosticReportByAccession(accession, accessionSystem) {
    const identifier = accessionSystem ? `${accessionSystem}|${accession}` : accession;
    const bundle = await this._get('DiagnosticReport', { identifier });
    return bundle?.entry?.[0]?.resource ?? null;
  }

  /**
   * Find the ImagingStudy for a radiology accession number. Useful for
   * launching the images (the study carries the PACS/viewer endpoints).
   */
  async imagingStudyByAccession(accession, accessionSystem) {
    const identifier = accessionSystem ? `${accessionSystem}|${accession}` : accession;
    const bundle = await this._get('ImagingStudy', { identifier });
    return bundle?.entry?.[0]?.resource ?? null;
  }
}
