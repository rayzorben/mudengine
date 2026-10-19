/**
 * The art server's registration proof of work: a decimal `nonce` for which
 * `sha256("<challenge>:<nonce>")` starts with `bits` zero bits (its README,
 * step 2). About a million hashes at 20 bits, a median 3.1 s and up to 5.8 s
 * in Node (todo 20261019-0931-01's `pow.mjs`), so it runs on a worker thread
 * (`artWorker.ts`), never on main.
 */
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

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

export function solveProofOfWork(challenge: string, bits: number): string {
  for (let nonce = 0; ; nonce += 1) {
    const digest = createHash('sha256').update(`${challenge}:${nonce}`).digest();
    if (leadingZeroBits(digest) >= bits) return String(nonce);
  }
}

/**
 * The same, on a worker thread from `workerFile` (`artWorker.js` beside
 * `index.js`), ended when it answers, fails or `deadlineMs` passes.
 */
export function solveOnWorker(
  workerFile: string,
  challenge: string,
  bits: number,
  deadlineMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile, { workerData: { challenge, bits } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`the proof of work took longer than ${Math.round(deadlineMs / 1000)} s`));
    }, deadlineMs);
    const finish = (): void => {
      clearTimeout(timer);
      void worker.terminate();
    };
    worker.once('message', (nonce: unknown) => {
      finish();
      if (typeof nonce === 'string') resolve(nonce);
      else reject(new Error('the proof of work answered with no nonce'));
    });
    worker.once('error', (error) => {
      finish();
      reject(new Error(`the proof of work failed: ${error.message}`));
    });
  });
}
