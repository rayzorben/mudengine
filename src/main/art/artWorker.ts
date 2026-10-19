/**
 * A worker thread that solves one registration proof of work
 * (`proofOfWork.ts`) and answers with the nonce. Started per registration,
 * once an install, and ended when it answers or the registration is given up.
 */
import { parentPort, workerData } from 'node:worker_threads';

import { solveProofOfWork } from './proofOfWork';

const { challenge, bits } = workerData as { challenge: string; bits: number };
parentPort?.postMessage(solveProofOfWork(challenge, bits));
