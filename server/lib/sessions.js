/**
 * Shared in-process session store.
 *
 * Used by both the SMART App Launch flow (OAuth state + post-login FHIR context)
 * and the billing routes (which optionally reuse the FHIR access token to pull
 * Epic context for an accession). Replace with Redis/DB for production and
 * multi-instance deployments — the access token here must never reach the
 * browser.
 *
 * Keys:
 *   <state>        → in-flight OAuth state (PKCE verifier, endpoints)
 *   ctx:<sessionId> → post-login context (accessToken, fhirBaseUrl, patientId, ...)
 */

export const sessions = new Map();

/** Look up the post-login FHIR context for a SPA session handle, if any. */
export function getContext(sessionId) {
  if (!sessionId) return null;
  return sessions.get(`ctx:${sessionId}`) ?? null;
}
