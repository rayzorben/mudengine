/**
 * A worker thread that runs fights (`simulatorPool.ts`): one `simulateFight`
 * per message, answered with its id. Pure: it reads no file and no tuning,
 * since everything the fight needs is in its input.
 */
import { parentPort } from 'node:worker_threads';

import { simulateFight, type SurvivalInput } from '../../shared/survival';

parentPort?.on('message', (message: { id: number; input: SurvivalInput }) => {
  parentPort?.postMessage({ id: message.id, survival: simulateFight(message.input) });
});
