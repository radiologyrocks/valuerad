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
}
