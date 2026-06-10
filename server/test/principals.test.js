import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;
delete process.env.NODE_ENV;

import { principals, TOKEN_PREFIX } from '../lib/principals.js';
import { currentUser } from '../lib/rbac.js';

function req(headers = {}) {
  return { headers };
}

test('create mints a one-time token and never exposes the hash', async () => {
  const { principal, token } = await principals.create({ name: 'ci-bot', roles: ['executive'], createdBy: 'admin@v.com' });
  assert.ok(token.startsWith(TOKEN_PREFIX));
  assert.equal(principal.name, 'ci-bot');
  assert.equal(principal.token_hash, undefined);
  const listed = await principals.list();
  assert.ok(listed.every((p) => p.token_hash === undefined));
});

test('findByToken resolves active principals; revoke kills the token', async () => {
  const { principal, token } = await principals.create({ name: 'mcp-surface', roles: ['executive', 'admin'] });
  const found = await principals.findByToken(token);
  assert.equal(found.name, 'mcp-surface');
  assert.ok(found.last_used_at);

  await principals.revoke(principal.id);
  assert.equal(await principals.findByToken(token), null);
});

test('duplicate names are rejected', async () => {
  await principals.create({ name: 'dupe', roles: ['scheduler'] });
  await assert.rejects(() => principals.create({ name: 'dupe', roles: ['scheduler'] }), /already exists/);
});

// ---- rbac resolution ----
test('currentUser resolves a bearer principal as svc:<name> with its scoped roles', async () => {
  const { token } = await principals.create({ name: 'worklist-agent', roles: ['radiologist'] });
  const user = await currentUser(req({ authorization: `Bearer ${token}` }));
  assert.equal(user.id, 'svc:worklist-agent');
  assert.deepEqual(user.roles, ['radiologist']);
  assert.equal(user.principal, true);
});

test('bad or revoked bearer tokens resolve to null (401), not dev fallback', async () => {
  assert.equal(await currentUser(req({ authorization: `Bearer ${TOKEN_PREFIX}deadbeef`, 'x-valuerad-user': 'x', 'x-valuerad-roles': 'admin' })), null);
  assert.equal(await currentUser(req({ authorization: 'Bearer not-a-valuerad-token' })), null);
});

test('dev headers work in development but never in production', async () => {
  const headers = { 'x-valuerad-user': 'dev@v.com', 'x-valuerad-roles': 'executive,admin' };
  const dev = await currentUser(req(headers));
  assert.equal(dev.id, 'dev@v.com');
  assert.deepEqual(dev.roles, ['executive', 'admin']);

  process.env.NODE_ENV = 'production';
  try {
    assert.equal(await currentUser(req(headers)), null);
  } finally {
    delete process.env.NODE_ENV;
  }
});
