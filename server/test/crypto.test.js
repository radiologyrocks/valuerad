import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

test('encrypt/decrypt round-trips with a key set', async () => {
  process.env.TOKEN_ENC_KEY = randomBytes(32).toString('base64');
  // Fresh module instance that reads the key at import time.
  const { encrypt, decrypt, encryptionEnabled } = await import('../lib/crypto.js?withkey');
  assert.equal(encryptionEnabled, true);

  const secret = 'access-token-abc.123';
  const ct = encrypt(secret);
  assert.ok(ct.startsWith('gcm:'), 'ciphertext should be tagged gcm:');
  assert.notEqual(ct, secret);
  assert.equal(decrypt(ct), secret);
});

test('null values pass through', async () => {
  process.env.TOKEN_ENC_KEY = randomBytes(32).toString('base64');
  const { encrypt, decrypt } = await import('../lib/crypto.js?withkey2');
  assert.equal(encrypt(null), null);
  assert.equal(decrypt(null), null);
});

test('passthrough mode round-trips when no key configured', async () => {
  delete process.env.TOKEN_ENC_KEY;
  const { encrypt, decrypt, encryptionEnabled } = await import('../lib/crypto.js?nokey');
  assert.equal(encryptionEnabled, false);
  const v = 'token';
  const stored = encrypt(v);
  assert.ok(stored.startsWith('plain:'));
  assert.equal(decrypt(stored), v);
});
