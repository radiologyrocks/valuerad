import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;

import { attestFeature, verifyAttestation, attestationMode } from '../lib/attest.js';

const FEATURE = {
  feature_key: 'referrer-scorecard',
  version: 2,
  kind: 'report',
  tier: 1,
  content_hash: 'abc123',
  engine_version: '1.0.0',
  test_evidence: { snapshotHash: 'def456' },
};

test('attestFeature signs the activation payload and verifyAttestation accepts it', () => {
  const att = attestFeature(FEATURE, { approvedBy: 'ceo@valuerad.com' });
  assert.equal(att.featureKey, 'referrer-scorecard');
  assert.equal(att.contentHash, 'abc123');
  assert.equal(att.evidenceHash, 'def456');
  assert.equal(att.approvedBy, 'ceo@valuerad.com');
  assert.ok(att.signature && att.publicKey && att.signedAt);
  assert.equal(verifyAttestation(att), true);
});

test('any tampering breaks verification', () => {
  const att = attestFeature(FEATURE, { approvedBy: 'ceo@valuerad.com' });
  assert.equal(verifyAttestation({ ...att, contentHash: 'tampered' }), false);
  assert.equal(verifyAttestation({ ...att, approvedBy: 'mallory@evil.com' }), false);
  assert.equal(verifyAttestation({ ...att, version: 3 }), false);
  assert.equal(verifyAttestation({ ...att, signature: Buffer.from('nope').toString('base64') }), false);
});

test('verification is robust to junk input', () => {
  assert.equal(verifyAttestation(null), false);
  assert.equal(verifyAttestation({}), false);
  assert.equal(verifyAttestation({ signature: 'x', publicKey: 'not a pem' }), false);
});

test('without a configured key, attestations are stamped ephemeral-dev', () => {
  assert.equal(attestationMode, 'ephemeral-dev'); // no ATTESTATION_PRIVATE_KEY in tests
  assert.equal(attestFeature(FEATURE).mode, 'ephemeral-dev');
});
