import { describe, expect, it } from 'vitest';

import { isPublicKey } from '../../shared/peerWire';
import { newEd25519Pair, signEd25519, verifyEd25519 } from '../ed25519';

describe('a character key', () => {
  it('signs what its public half verifies, and nothing another key or text does', () => {
    const pair = newEd25519Pair();
    const other = newEd25519Pair();
    expect(isPublicKey(pair.publicKey)).toBe(true);
    const signature = signEd25519(pair, 'mudengine-peer-claim\nrealm\nBrakkle\nnonce');
    expect(
      verifyEd25519(pair.publicKey, 'mudengine-peer-claim\nrealm\nBrakkle\nnonce', signature)
    ).toBe(true);
    expect(
      verifyEd25519(other.publicKey, 'mudengine-peer-claim\nrealm\nBrakkle\nnonce', signature)
    ).toBe(false);
    expect(
      verifyEd25519(pair.publicKey, 'mudengine-peer-claim\nrealm\nSoul\nnonce', signature)
    ).toBe(false);
  });
});
