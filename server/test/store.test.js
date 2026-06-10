import { test } from 'node:test';
import assert from 'node:assert/strict';

// No DATABASE_URL -> MemoryStore backend.
delete process.env.DATABASE_URL;

const { store, storeBackend } = await import('../lib/store.js');

test('uses the in-memory backend without DATABASE_URL', () => {
  assert.equal(storeBackend, 'memory');
});

test('launch state can be taken exactly once', async () => {
  await store.putLaunchState('state-1', { iss: 'https://ehr.example' }, 60_000);
  const first = await store.takeLaunchState('state-1');
  assert.deepEqual(first, { iss: 'https://ehr.example' });
  const second = await store.takeLaunchState('state-1');
  assert.equal(second, null);
});

test('expired launch state is not returned', async () => {
  await store.putLaunchState('state-2', { iss: 'x' }, -1);
  assert.equal(await store.takeLaunchState('state-2'), null);
});

test('session lifecycle: create, safe read, token read', async () => {
  await store.createSession({
    id: 'sess-1',
    fhirBaseUrl: 'https://ehr.example/fhir',
    tokenEndpoint: 'https://ehr.example/token',
    patientId: 'pat-1',
    encounterId: 'enc-1',
    patientResource: { resourceType: 'Patient', id: 'pat-1' },
    scope: 'patient/Patient.read',
    tokens: { access_token: 'AT', refresh_token: 'RT', token_type: 'Bearer', expires_in: 3600 },
    ttlMs: 60_000,
  });

  const safe = await store.getSession('sess-1');
  assert.equal(safe.patientId, 'pat-1');
  assert.equal(safe.tokenEndpoint, 'https://ehr.example/token');
  assert.equal(safe.accessToken, undefined, 'safe read must not include tokens');

  const withTokens = await store.getSessionWithTokens('sess-1');
  assert.equal(withTokens.accessToken, 'AT');
  assert.equal(withTokens.refreshToken, 'RT');
});

test('updateTokens replaces the access token', async () => {
  await store.updateTokens('sess-1', { access_token: 'AT2', expires_in: 3600 });
  const t = await store.getSessionWithTokens('sess-1');
  assert.equal(t.accessToken, 'AT2');
  assert.equal(t.refreshToken, 'RT', 'refresh token preserved when not re-issued');
});

test('audit and leads append', async () => {
  await store.audit({ sessionId: 'sess-1', action: 'fhir.read', resource: 'Patient/pat-1', outcome: 'success' });
  const id = await store.createLead({ name: 'A', email: 'a@b.com', organization: 'Org' });
  assert.ok(id);
});
