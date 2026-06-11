/**
 * Signed attestations — provenance a buyer's compliance tooling can verify
 * mechanically, not just read.
 *
 * At activation, a feature gets an Ed25519-signed record binding its content
 * hash, engine version, golden-evidence hash, approver, and timestamp. The
 * signature covers the canonical JSON of the payload; verification needs
 * only the public key (embedded in the record).
 *
 * Key material: set ATTESTATION_PRIVATE_KEY (PKCS#8 PEM) in production —
 * keep it in the vault with the other secrets. Without it, a per-process
 * ephemeral key is generated and every attestation is stamped
 * mode:"ephemeral-dev" so nobody mistakes a dev signature for provenance.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

function loadKeys() {
  if (process.env.ATTESTATION_PRIVATE_KEY) {
    const privateKey = createPrivateKey(process.env.ATTESTATION_PRIVATE_KEY);
    return { privateKey, publicKey: createPublicKey(privateKey), mode: 'configured' };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, mode: 'ephemeral-dev' };
}

const { privateKey, publicKey, mode } = loadKeys();
export const attestationMode = mode;

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Sign an activation. Returns the full attestation record to store with the
 * feature. When an `outcomeReview` is supplied, a hash of the human's rubric
 * grading is bound into the signed payload — so "a human reviewed and graded
 * this" is part of the provenance, not an unsigned field stored beside it.
 */
export function attestFeature(feature, { approvedBy, outcomeReview } = {}) {
  const payload = {
    featureKey: feature.feature_key,
    version: feature.version,
    kind: feature.kind,
    tier: feature.tier,
    contentHash: feature.content_hash,
    engineVersion: feature.engine_version,
    evidenceHash: feature.test_evidence?.snapshotHash ?? null,
    approvedBy: approvedBy ?? feature.approved_by ?? null,
    rubricReviewHash: outcomeReview
      ? createHash('sha256').update(stableStringify(outcomeReview)).digest('hex')
      : null,
    signedAt: new Date().toISOString(),
  };
  const signature = sign(null, Buffer.from(stableStringify(payload)), privateKey).toString('base64');
  return {
    ...payload,
    signature,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    mode,
  };
}

/** Verify an attestation record against its embedded public key. Pure. */
export function verifyAttestation(attestation) {
  if (!attestation?.signature || !attestation?.publicKey) return false;
  const { signature, publicKey: pem, mode: _mode, ...payload } = attestation;
  try {
    return verify(null, Buffer.from(stableStringify(payload)), createPublicKey(pem), Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}
