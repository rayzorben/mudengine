/**
 * Ed25519 for the peer gateway's claims: the gateway checks an answer
 * (`ChecksSignature`, `shared/peerWire.ts`), and an install makes a key pair
 * per character and realm and signs its answers with it. Keys and signatures
 * are base64url, a public key its 32 bytes (`x`) and a private key its 32
 * bytes (`d`), as a JWK holds them. A key or signature that does not decode
 * is a signature that does not verify.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

import type { ChecksSignature } from '../shared/peerWire';

/** A character's key pair, both halves base64url. The private half never leaves the install. */
export interface Ed25519Pair {
  publicKey: string;
  privateKey: string;
}

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

export function newEd25519Pair(): Ed25519Pair {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string' || typeof jwk.d !== 'string') {
    throw new Error('Node made an Ed25519 key with no x or d in its JWK');
  }
  return { publicKey: jwk.x, privateKey: jwk.d };
}

/** `pair`'s signature over `text`, base64url. */
export function signEd25519(pair: Ed25519Pair, text: string): string {
  const privateKey = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: pair.publicKey, d: pair.privateKey },
    format: 'jwk'
  });
  return sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64url');
}
