/**
 * The art server's registration proof of work (`node/proofOfWork.ts`, its
 * README's step 2), solved off main. About a million hashes at 20 bits, a
 * median 3.1 s and up to 5.8 s in Node (todo 20261019-0931-01's `pow.mjs`),
 * so it runs on a worker thread (`artWorker.ts`), never on main.
 */
import { Worker } from 'node:worker_threads';

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
