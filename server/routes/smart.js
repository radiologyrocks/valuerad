/**
 * SMART App Launch routes
 *
 * GET /epic/launch    – receives iss + launch from Epic EHR
 * GET /epic/callback  – receives authorization code, exchanges for tokens
 * GET /epic/context   – returns current session context (for the SPA)
 */

import { Router } from 'express';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  discoverSmartConfig,
  buildAuthUrl,
  exchangeCodeForTokens,
} from '../lib/smart.js';

import { FhirClient } from '../lib/fhir.js';

const router = Router();

// In-process session store (replace with Redis/DB in production)
const sessions = new Map();

const CLIENT_ID     = process.env.EPIC_CLIENT_ID     ?? 'YOUR_EPIC_CLIENT_ID';
const CLIENT_SECRET = process.env.EPIC_CLIENT_SECRET ?? null; // public app = no secret
const REDIRECT_URI  = process.env.EPIC_REDIRECT_URI  ?? 'https://valuerad.example.com/epic/callback';

const SCOPES = [
  'launch',
  'openid',
  'fhirUser',
  'patient/Patient.read',
  'patient/Encounter.read',
  'patient/ServiceRequest.read',
  'patient/DiagnosticReport.read',
  'patient/Appointment.read',
];

// ---------------------------------------------------------------------------
// Step 1 — EHR-launched entry point
// Epic opens: GET /epic/launch?iss=<fhir_base>&launch=<opaque_token>
// ---------------------------------------------------------------------------
router.get('/launch', async (req, res) => {
  const { iss, launch } = req.query;

  if (!iss || !launch) {
    return res.status(400).json({
      error: 'missing_params',
      detail: 'Expected iss and launch query parameters from Epic.',
    });
  }

  try {
    const smart = await discoverSmartConfig(iss);

    const state        = generateState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // Persist state → session data (PKCE verifier, iss, smart endpoints)
    sessions.set(state, {
      iss,
      launch,
      codeVerifier,
      authorizationEndpoint: smart.authorizationEndpoint,
      tokenEndpoint: smart.tokenEndpoint,
      createdAt: Date.now(),
    });

    const authorizeUrl = buildAuthUrl({
      authorizationEndpoint: smart.authorizationEndpoint,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scopes: SCOPES,
      state,
      launch,
      codeChallenge,
      aud: iss,
    });

    return res.redirect(authorizeUrl);
  } catch (err) {
    console.error('[launch] SMART discovery error:', err.message);
    return res.status(502).json({ error: 'smart_discovery_failed', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Step 2 — Epic redirects back with ?code=...&state=...
// ---------------------------------------------------------------------------
router.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.error('[callback] OAuth error:', error, error_description);
    return res.status(400).json({ error, error_description });
  }

  if (!code || !state) {
    return res.status(400).json({ error: 'missing_params', detail: 'code and state are required.' });
  }

  const session = sessions.get(state);
  if (!session) {
    return res.status(400).json({ error: 'invalid_state', detail: 'Unknown or expired state.' });
  }
  sessions.delete(state);

  try {
    const tokens = await exchangeCodeForTokens({
      tokenEndpoint: session.tokenEndpoint,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      code,
      codeVerifier: session.codeVerifier,
    });

    // tokens.patient, tokens.encounter may be present (context from token response)
    const { access_token, patient, encounter } = tokens;

    const fhir = new FhirClient({ baseUrl: session.iss, accessToken: access_token });

    // Fetch patient demographics as a first FHIR read
    const patientResource = patient ? await fhir.patient(patient) : null;

    // Store minimal context keyed by a short session ID
    const sessionId = generateState();
    sessions.set(`ctx:${sessionId}`, {
      accessToken: access_token,
      tokenResponse: tokens,
      fhirBaseUrl: session.iss,
      patientId: patient ?? null,
      encounterId: encounter ?? null,
      patientResource,
      createdAt: Date.now(),
    });

    // Redirect to SPA with session handle; SPA then calls /epic/context
    return res.redirect(`/?session=${sessionId}`);
  } catch (err) {
    console.error('[callback] token exchange error:', err.message);
    return res.status(502).json({ error: 'token_exchange_failed', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Step 3 — SPA polls for its context after redirect
// GET /epic/context?session=<id>
// ---------------------------------------------------------------------------
router.get('/context', (req, res) => {
  const { session } = req.query;
  if (!session) return res.status(400).json({ error: 'session param required' });

  const ctx = sessions.get(`ctx:${session}`);
  if (!ctx) return res.status(404).json({ error: 'session not found or expired' });

  // Return safe subset — never expose access_token to the browser via JSON
  return res.json({
    patientId:   ctx.patientId,
    encounterId: ctx.encounterId,
    patient:     ctx.patientResource,
    fhirBaseUrl: ctx.fhirBaseUrl,
    scope:       ctx.tokenResponse?.scope,
  });
});

// ---------------------------------------------------------------------------
// FHIR proxy — forward authenticated requests from SPA
// GET /epic/fhir/:resource
// GET /epic/fhir/:resource/:id
// ---------------------------------------------------------------------------
router.get('/fhir/:resource/:id?', async (req, res) => {
  const sessionId = req.headers['x-valuerad-session'];
  const ctx = sessions.get(`ctx:${sessionId}`);
  if (!ctx) return res.status(401).json({ error: 'session not found' });

  const fhir = new FhirClient({ baseUrl: ctx.fhirBaseUrl, accessToken: ctx.accessToken });
  const { resource, id } = req.params;

  try {
    let data;
    switch (resource) {
      case 'Patient':
        data = await fhir.patient(id ?? ctx.patientId);
        break;
      case 'Encounter':
        data = await fhir.encounter(id ?? ctx.encounterId);
        break;
      case 'ServiceRequest':
        data = await fhir.serviceRequests(ctx.patientId);
        break;
      case 'DiagnosticReport':
        data = await fhir.diagnosticReports(ctx.patientId);
        break;
      case 'Appointment':
        data = await fhir.appointments(ctx.patientId);
        break;
      default:
        return res.status(404).json({ error: `Resource ${resource} not proxied` });
    }
    return res.json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

export { router as smartRouter };
