/**
 * SMART on FHIR helper utilities.
 *
 * Implements the App Launch Framework (SMART v1/v2):
 * https://www.hl7.org/fhir/smart-app-launch/
 */

import { randomBytes, createHash } from 'node:crypto';
import fetch from 'node-fetch';

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export function generateCodeVerifier() {
  return randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

// ---------------------------------------------------------------------------
// State nonce (CSRF protection)
// ---------------------------------------------------------------------------

export function generateState() {
  return randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// Discover OAuth endpoints from SMART well-known config or FHIR metadata
// ---------------------------------------------------------------------------

export async function discoverSmartConfig(fhirBaseUrl) {
  const wellKnownUrl = `${fhirBaseUrl.replace(/\/$/, '')}/.well-known/smart-configuration`;

  const res = await fetch(wellKnownUrl, {
    headers: { Accept: 'application/json' },
  });

  if (res.ok) {
    const config = await res.json();
    return {
      authorizationEndpoint: config.authorization_endpoint,
      tokenEndpoint: config.token_endpoint,
      capabilities: config.capabilities ?? [],
      raw: config,
    };
  }

  // Fall back to FHIR capability statement (DSTU2/R4 metadata)
  const metaUrl = `${fhirBaseUrl.replace(/\/$/, '')}/metadata`;
  const metaRes = await fetch(metaUrl, {
    headers: { Accept: 'application/fhir+json' },
  });

  if (!metaRes.ok) {
    throw new Error(`SMART discovery failed: well-known ${res.status}, metadata ${metaRes.status}`);
  }

  const meta = await metaRes.json();
  const secExt = meta?.rest?.[0]?.security?.extension?.find(
    (e) => e.url === 'http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris'
  );

  if (!secExt) {
    throw new Error('No SMART OAuth URIs found in FHIR metadata');
  }

  const auth = secExt.extension?.find((e) => e.url === 'authorize')?.valueUri;
  const token = secExt.extension?.find((e) => e.url === 'token')?.valueUri;

  if (!auth || !token) {
    throw new Error('Incomplete SMART OAuth URIs in FHIR metadata');
  }

  return { authorizationEndpoint: auth, tokenEndpoint: token, capabilities: [], raw: meta };
}

// ---------------------------------------------------------------------------
// Build the authorization redirect URL
// ---------------------------------------------------------------------------

export function buildAuthUrl({
  authorizationEndpoint,
  clientId,
  redirectUri,
  scopes,
  state,
  launch,
  codeChallenge,
  aud,
}) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    state,
    aud,
  });

  if (launch) params.set('launch', launch);

  if (codeChallenge) {
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }

  return `${authorizationEndpoint}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Exchange authorization code for tokens
// ---------------------------------------------------------------------------

export async function exchangeCodeForTokens({
  tokenEndpoint,
  clientId,
  clientSecret,
  redirectUri,
  code,
  codeVerifier,
}) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
  });

  if (codeVerifier) body.set('code_verifier', codeVerifier);

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };

  if (clientSecret) {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
  }

  const res = await fetch(tokenEndpoint, { method: 'POST', headers, body });
  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${JSON.stringify(data)}`);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Refresh an access token using a refresh_token (SMART "online"/"offline" access)
// ---------------------------------------------------------------------------

export async function refreshTokens({ tokenEndpoint, clientId, clientSecret, refreshToken, scopes }) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });

  if (scopes) body.set('scope', Array.isArray(scopes) ? scopes.join(' ') : scopes);

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (clientSecret) {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
  }

  const res = await fetch(tokenEndpoint, { method: 'POST', headers, body });
  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${JSON.stringify(data)}`);
  }

  return data;
}
