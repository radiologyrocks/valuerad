/**
 * Envelope encryption for tokens at rest (AES-256-GCM).
 *
 * Stage 0 requirement: OAuth access/refresh tokens are secrets that grant
 * access to PHI. They must never be stored in plaintext.
 *
 * Key: 32 bytes, base64-encoded, supplied via TOKEN_ENC_KEY.
 *   Generate one with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * If no key is configured we fall back to a clearly-marked passthrough so the
 * server still boots in local development. index.js refuses to start in
 * production without a real key.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const PLAIN_PREFIX = 'plain:'; // marks unencrypted dev values
const ENC_PREFIX = 'gcm:';

function loadKey() {
  const b64 = process.env.TOKEN_ENC_KEY;
  if (!b64) return null;
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    throw new Error('TOKEN_ENC_KEY must decode to exactly 32 bytes (base64).');
  }
  return key;
}

const KEY = loadKey();

export const encryptionEnabled = KEY !== null;

let warned = false;
function warnOnce() {
  if (!warned) {
    console.warn(
      '[crypto] TOKEN_ENC_KEY not set — tokens stored UNENCRYPTED. ' +
        'Dev only; set TOKEN_ENC_KEY before handling real PHI.'
    );
    warned = true;
  }
}

export function encrypt(plaintext) {
  if (plaintext == null) return null;
  if (!KEY) {
    warnOnce();
    return PLAIN_PREFIX + plaintext;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decrypt(stored) {
  if (stored == null) return null;
  if (stored.startsWith(PLAIN_PREFIX)) {
    return stored.slice(PLAIN_PREFIX.length);
  }
  if (!stored.startsWith(ENC_PREFIX)) {
    throw new Error('Unrecognized ciphertext format.');
  }
  if (!KEY) {
    throw new Error('Encrypted value found but TOKEN_ENC_KEY is not set.');
  }
  const raw = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
