/**
 * Thin FHIR R4 client. Pass an access token; handles Bearer auth and
 * returns parsed JSON or throws on HTTP error.
 *
 * Stage 0 adds write capability (create/update) so the platform can act in the
 * EHR, not just observe it. Every write should be routed through the audited
 * choke point in routes/smart.js — never call these directly without an audit.
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

  async _send(method, path, body) {
    const res = await fetch(`${this.baseUrl}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/fhir+json',
        'Content-Type': 'application/fhir+json',
      },
      body: JSON.stringify(body),
    });

    // FHIR writes may return 200/201 with the resource, or 200 with no body.
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new Error(`FHIR ${method} ${path} failed (${res.status}): ${text}`);
    }
    return data;
  }

  // Reads
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
  coverage(patientId) {
    return this._get('Coverage', { patient: patientId });
  }

  // Writes
  create(resourceType, body) { return this._send('POST', resourceType, body); }
  update(resourceType, id, body) { return this._send('PUT', `${resourceType}/${id}`, body); }
}

/**
 * Scheduling abstraction seam.
 *
 * Epic scheduling is frequently NOT plain FHIR `Appointment.create` — it uses
 * Epic's scheduling APIs / open-scheduling and `$find`-style slot operations.
 * Stage 1 builds against this interface so it never hardcodes one vendor's
 * quirks. For pure-FHIR servers the default implementation works as-is.
 */
export class SchedulingClient {
  constructor(fhirClient) {
    this.fhir = fhirClient;
  }

  // Default: FHIR Slot search. Override per-EHR vendor as needed.
  findOpenSlots({ scheduleId, start, end }) {
    return this.fhir._get('Slot', {
      schedule: scheduleId,
      status: 'free',
      'start': `ge${start}`,
      'start:below': end,
    });
  }

  // Default: FHIR Appointment.create. Epic may require a vendor endpoint instead.
  bookAppointment(appointment) {
    return this.fhir.create('Appointment', appointment);
  }
}
