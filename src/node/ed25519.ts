/**
 * The peer gateway's check of a claim's answer (`ChecksSignature`,
 * `shared/peerWire.ts`): an Ed25519 signature by the character's key, the
 * key and signature as base64url. A key or signature that does not decode is
 * a signature that does not verify.
 */
import { createPublicKey, verify } from 'node:crypto';

import type { ChecksSignature } from '../shared/peerWire';

export const verifyEd25519: ChecksSignature = (key, text, signature) => {
  try {
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: key },
      format: 'jwk'
    });
    return verify(null, Buffer.from(text, 'utf8'), publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    // A malformed key or signature is a refusal of this one answer, never a fault of the gateway.
    return false;
  }
};
