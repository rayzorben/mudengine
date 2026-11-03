/**
 * The registration proof of work the art server and the peer gateway both ask
 * for: a decimal `nonce` for which `sha256("<challenge>:<nonce>")` starts with
 * `bits` zero bits. The client solves it on a worker thread
 * (`main/art/proofOfWork.ts`); the peer gateway checks it (`gateway/Registrar.ts`).
 */
import { createHash } from 'node:crypto';

export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

function workOf(challenge: string, nonce: string): Uint8Array {
  return createHash('sha256').update(`${challenge}:${nonce}`).digest();
}

export function solveProofOfWork(challenge: string, bits: number): string {
  for (let nonce = 0; ; nonce += 1) {
    if (leadingZeroBits(workOf(challenge, String(nonce))) >= bits) return String(nonce);
  }
}

/** Whether `nonce` does the work `challenge` asked for. */
export function meetsProofOfWork(challenge: string, nonce: string, bits: number): boolean {
  return leadingZeroBits(workOf(challenge, nonce)) >= bits;
}
