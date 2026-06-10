/**
 * SMART App Launch routes
 *
 * GET  /epic/launch    – receives iss + launch from Epic EHR
 * GET  /epic/callback  – receives authorization code, exchanges for tokens
 * GET  /epic/context   – returns current session context (for the SPA)
 * GET  /epic/fhir/...  – audited read proxy
 * POST /epic/fhir/...  – audited write proxy
 *
 * Stage 0: sessions, tokens (encrypted), and an append-only audit log live in
 * the store (Postgres in prod, in-memory in dev). Tokens are refreshed
 * automatically when expired. Every FHIR read and write is audited.
 */

import { Router } from 'express';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  discoverSmartConfig,
  buildAuthUrl,
  exchangeCodeForTokens,
  refreshTokens,
} from '../lib/smart.js';

import { FhirClient } from '../lib/fhir.js';
import { store } from '../lib/store.js';

const router = Router();

const CLIENT_ID     = process.env.EPIC_CLIENT_ID     ?? 'YOUR_EPIC_CLIENT_ID';
const CLIENT_SECRET = process.env.EPIC_CLIENT_SECRET ?? null; // public app = no secret
const REDIRECT_URI  = process.env.EPIC_REDIRECT_URI  ?? 'https://valuerad.example.com/epic/callback';

const LAUNCH_TTL_MS  = 10 * 60 * 1000;       // 10 min to complete the OAuth dance
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;   // 8 h working session
const REFRESH_SKEW_MS = 60 * 1000;           // refresh 60s before expiry

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

    const state         = generateState();
    const codeVerifier  = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    await store.putLaunchState(
      state,
      {
        iss,
        launch,
        codeVerifier,
        authorizationEndpoint: smart.authorizationEndpoint,
        tokenEndpoint: smart.tokenEndpoint,
      },
      LAUNCH_TTL_MS
    );

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

  const launchState = await store.takeLaunchState(state);
  if (!launchState) {
    return res.status(400).json({ error: 'invalid_state', detail: 'Unknown or expired state.' });
  }

  try {
    const tokens = await exchangeCodeForTokens({
      tokenEndpoint: launchState.tokenEndpoint,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      code,
      codeVerifier: launchState.codeVerifier,
    });

    const { access_token, patient, encounter } = tokens;

    const fhir = new FhirClient({ baseUrl: launchState.iss, accessToken: access_token });
    const patientResource = patient ? await fhir.patient(patient) : null;

    const sessionId = generateState();
    await store.createSession({
      id: sessionId,
      fhirBaseUrl: launchState.iss,
      tokenEndpoint: launchState.tokenEndpoint,
      patientId: patient ?? null,
      encounterId: encounter ?? null,
      patientResource,
      scope: tokens.scope ?? null,
      tokens,
      ttlMs: SESSION_TTL_MS,
    });

    await store.audit({
      sessionId,
      action: 'session.create',
      resource: patient ? `Patient/${patient}` : null,
      outcome: 'success',
    });

    return res.redirect(`/?session=${sessionId}`);
  } catch (err) {
    console.error('[callback] token exchange error:', err.message);
    return res.status(502).json({ error: 'token_exchange_failed', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Step 3 — SPA polls for its context after redirect
// ---------------------------------------------------------------------------
router.get('/context', async (req, res) => {
  const { session } = req.query;
  if (!session) return res.status(400).json({ error: 'session param required' });

  const ctx = await store.getSession(session);
  if (!ctx) return res.status(404).json({ error: 'session not found or expired' });

  // Never expose tokens to the browser.
  return res.json({
    patientId: ctx.patientId,
    encounterId: ctx.encounterId,
    patient: ctx.patientResource,
    fhirBaseUrl: ctx.fhirBaseUrl,
    scope: ctx.scope,
  });
});

// ---------------------------------------------------------------------------
// Return a FHIR client for a session, refreshing the token if it is expiring.
// ---------------------------------------------------------------------------
async function fhirForSession(sessionId) {
  const ctx = await store.getSessionWithTokens(sessionId);
  if (!ctx) return null;

  const expMs = ctx.tokenExpiresAt ? new Date(ctx.tokenExpiresAt).getTime() : Infinity;
  if (ctx.refreshToken && expMs - Date.now() < REFRESH_SKEW_MS) {
    try {
      const refreshed = await refreshTokens({
        tokenEndpoint: ctx.tokenEndpoint,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: ctx.refreshToken,
      });
      await store.updateTokens(sessionId, refreshed);
      await store.audit({ sessionId, action: 'token.refresh', outcome: 'success' });
      ctx.accessToken = refreshed.access_token;
    } catch (err) {
      await store.audit({ sessionId, action: 'token.refresh', outcome: 'error', detail: { message: err.message } });
      // Fall through with the (possibly still valid) existing token.
    }
  }

  return { fhir: new FhirClient({ baseUrl: ctx.fhirBaseUrl, accessToken: ctx.accessToken }), ctx };
}

// ---------------------------------------------------------------------------
// Audited READ proxy
// GET /epic/fhir/:resource/:id?
// ---------------------------------------------------------------------------
router.get('/fhir/:resource/:id?', async (req, res) => {
  const sessionId = req.headers['x-valuerad-session'];
  const bundle = await fhirForSession(sessionId);
  if (!bundle) return res.status(401).json({ error: 'session not found' });

  const { fhir, ctx } = bundle;
  const { resource, id } = req.params;

  try {
    let data;
    switch (resource) {
      case 'Patient':           data = await fhir.patient(id ?? ctx.patientId); break;
      case 'Encounter':         data = await fhir.encounter(id ?? ctx.encounterId); break;
      case 'ServiceRequest':    data = await fhir.serviceRequests(ctx.patientId); break;
      case 'DiagnosticReport':  data = await fhir.diagnosticReports(ctx.patientId); break;
      case 'Appointment':       data = await fhir.appointments(ctx.patientId); break;
      case 'Coverage':          data = await fhir.coverage(ctx.patientId); break;
      default:
        return res.status(404).json({ error: `Resource ${resource} not proxied` });
    }
    await store.audit({ sessionId, action: 'fhir.read', resource: id ? `${resource}/${id}` : resource, outcome: 'success' });
    return res.json(data);
  } catch (err) {
    await store.audit({ sessionId, action: 'fhir.read', resource, outcome: 'error', detail: { message: err.message } });
    return res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Audited WRITE proxy
// POST /epic/fhir/:resource          → create
// PUT  /epic/fhir/:resource/:id      → update
// Every write is recorded BEFORE the response returns.
// ---------------------------------------------------------------------------
router.post('/fhir/:resource', async (req, res) => {
  const sessionId = req.headers['x-valuerad-session'];
  const bundle = await fhirForSession(sessionId);
  if (!bundle) return res.status(401).json({ error: 'session not found' });

  const { resource } = req.params;
  try {
    const data = await bundle.fhir.create(resource, req.body);
    await store.audit({ sessionId, action: 'fhir.write', resource, outcome: 'success', detail: { op: 'create' } });
    return res.status(201).json(data);
  } catch (err) {
    await store.audit({ sessionId, action: 'fhir.write', resource, outcome: 'error', detail: { op: 'create', message: err.message } });
    return res.status(502).json({ error: err.message });
  }
});

router.put('/fhir/:resource/:id', async (req, res) => {
  const sessionId = req.headers['x-valuerad-session'];
  const bundle = await fhirForSession(sessionId);
  if (!bundle) return res.status(401).json({ error: 'session not found' });

  const { resource, id } = req.params;
  try {
    const data = await bundle.fhir.update(resource, id, req.body);
    await store.audit({ sessionId, action: 'fhir.write', resource: `${resource}/${id}`, outcome: 'success', detail: { op: 'update' } });
    return res.json(data);
  } catch (err) {
    await store.audit({ sessionId, action: 'fhir.write', resource: `${resource}/${id}`, outcome: 'error', detail: { op: 'update', message: err.message } });
    return res.status(502).json({ error: err.message });
  }
});

export { router as smartRouter };
