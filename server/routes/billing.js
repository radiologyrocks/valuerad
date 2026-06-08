/**
 * Billing-exception workflow routes.
 *
 * This is the core of the automation: MBMS exceptions are pulled in, matched to
 * the PowerScribe report (and optionally to Epic via FHIR), an addendum is
 * drafted by Claude, the radiologist reviews/edits it, and the draft is pushed
 * back to PowerScribe for signature. The exception is then marked resolved.
 *
 *   GET    /billing/exceptions                      worklist (the embedded Epic view)
 *   GET    /billing/exceptions/:id                  detail: exception + report + launch
 *   GET    /billing/exceptions/:id/launch           study launch URL (+ Epic ImagingStudy)
 *   POST   /billing/exceptions/:id/draft-addendum   Claude-drafted addendum
 *   POST   /billing/exceptions/:id/push-addendum    push draft to PowerScribe
 *   POST   /billing/exceptions/:id/resolve          mark resolved in MBMS
 *
 * FHIR/Epic context is optional. If the request carries an `x-valuerad-session`
 * header (from the SMART login flow), the accession is resolved to an Epic
 * DiagnosticReport/ImagingStudy for in-Epic navigation. Without it, the
 * workflow still runs end-to-end on MBMS + PowerScribe.
 */

import { Router } from 'express';
import { getMbmsClient } from '../lib/mbms.js';
import { getPowerScribeClient, buildLaunchUrl } from '../lib/powerscribe.js';
import { draftAddendum } from '../lib/addendum.js';
import { getContext } from '../lib/sessions.js';
import { FhirClient } from '../lib/fhir.js';

const router = Router();

const mbms = getMbmsClient();
const powerscribe = getPowerScribeClient();

const ACCESSION_SYSTEM = process.env.ACCESSION_IDENTIFIER_SYSTEM ?? '';

// Optionally resolve an accession to Epic resources using the caller's SMART
// session. Never throws — Epic context is a nice-to-have, not a hard dependency.
async function resolveEpicContext(req, accession) {
  const ctx = getContext(req.headers['x-valuerad-session']);
  if (!ctx?.accessToken || !ctx?.fhirBaseUrl || !accession) return null;
  try {
    const fhir = new FhirClient({ baseUrl: ctx.fhirBaseUrl, accessToken: ctx.accessToken });
    const [report, study] = await Promise.all([
      fhir.diagnosticReportByAccession(accession, ACCESSION_SYSTEM).catch(() => null),
      fhir.imagingStudyByAccession(accession, ACCESSION_SYSTEM).catch(() => null),
    ]);
    return {
      diagnosticReportId: report?.id ?? null,
      imagingStudyId: study?.id ?? null,
      // Endpoints on the ImagingStudy point at the PACS/viewer for the images.
      viewerEndpoints: (study?.endpoint ?? []).map((e) => e.reference),
    };
  } catch {
    return null;
  }
}

const ASSERT_FOUND = (res, value, what) => {
  if (!value) {
    res.status(404).json({ error: 'not_found', detail: `${what} not found` });
    return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Worklist
// ---------------------------------------------------------------------------
router.get('/exceptions', async (req, res) => {
  try {
    const { status } = req.query;
    const exceptions = await mbms.listExceptions({ status });
    res.json({ count: exceptions.length, exceptions });
  } catch (err) {
    console.error('[billing] listExceptions:', err.message);
    res.status(502).json({ error: 'mbms_error', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Detail — exception + matched PowerScribe report + launch handle (+ Epic)
// ---------------------------------------------------------------------------
router.get('/exceptions/:id', async (req, res) => {
  try {
    const exception = await mbms.getException(req.params.id);
    if (!ASSERT_FOUND(res, exception, 'Exception')) return;

    const [report, epic] = await Promise.all([
      powerscribe.getReport(exception.accessionNumber).catch((e) => {
        console.error('[billing] getReport:', e.message);
        return null;
      }),
      resolveEpicContext(req, exception.accessionNumber),
    ]);

    res.json({
      exception,
      report, // { status, signedBy, signedAt, text, ... } or null
      epic,   // { diagnosticReportId, imagingStudyId, viewerEndpoints } or null
      launchUrl: buildLaunchUrl(exception.accessionNumber),
    });
  } catch (err) {
    console.error('[billing] detail:', err.message);
    res.status(502).json({ error: 'detail_error', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Launch — the URL/handle that opens the study (replaces manual accession entry)
// ---------------------------------------------------------------------------
router.get('/exceptions/:id/launch', async (req, res) => {
  try {
    const exception = await mbms.getException(req.params.id);
    if (!ASSERT_FOUND(res, exception, 'Exception')) return;
    const epic = await resolveEpicContext(req, exception.accessionNumber);
    res.json({
      accessionNumber: exception.accessionNumber,
      launchUrl: buildLaunchUrl(exception.accessionNumber),
      epic,
    });
  } catch (err) {
    res.status(502).json({ error: 'launch_error', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Draft addendum (Claude)
// ---------------------------------------------------------------------------
router.post('/exceptions/:id/draft-addendum', async (req, res) => {
  try {
    const exception = await mbms.getException(req.params.id);
    if (!ASSERT_FOUND(res, exception, 'Exception')) return;

    const reportText = await powerscribe.getReportText(exception.accessionNumber);
    if (!reportText) {
      return res.status(409).json({
        error: 'no_report',
        detail: `No PowerScribe report text found for accession ${exception.accessionNumber}.`,
      });
    }

    const radiologistName = req.body?.radiologistName ?? req.headers['x-valuerad-user'];
    const draft = await draftAddendum({ exception, reportText, radiologistName });
    res.json(draft);
  } catch (err) {
    if (err.code === 'NO_API_KEY' || err.code === 'NO_SDK') {
      return res.status(503).json({ error: err.code.toLowerCase(), detail: err.message });
    }
    console.error('[billing] draft-addendum:', err.message);
    res.status(502).json({ error: 'draft_error', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Push the (radiologist-reviewed) draft addendum to PowerScribe
// ---------------------------------------------------------------------------
router.post('/exceptions/:id/push-addendum', async (req, res) => {
  try {
    const exception = await mbms.getException(req.params.id);
    if (!ASSERT_FOUND(res, exception, 'Exception')) return;

    const text = req.body?.text;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'missing_text', detail: 'Addendum text is required.' });
    }
    const author = req.body?.author ?? req.headers['x-valuerad-user'] ?? 'unknown';

    const result = await powerscribe.createAddendumDraft({
      accession: exception.accessionNumber,
      text,
      author,
    });
    res.json(result);
  } catch (err) {
    console.error('[billing] push-addendum:', err.message);
    res.status(502).json({ error: 'push_error', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Mark the exception resolved in MBMS
// ---------------------------------------------------------------------------
router.post('/exceptions/:id/resolve', async (req, res) => {
  try {
    const resolvedBy = req.body?.resolvedBy ?? req.headers['x-valuerad-user'] ?? 'unknown';
    const updated = await mbms.markResolved(req.params.id, {
      addendumText: req.body?.addendumText,
      resolvedBy,
    });
    res.json(updated);
  } catch (err) {
    console.error('[billing] resolve:', err.message);
    res.status(502).json({ error: 'resolve_error', detail: err.message });
  }
});

export { router as billingRouter };
