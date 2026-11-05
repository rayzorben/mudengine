/**
 * The route worker (`LapPlanner`): plans batches of a lap's legs over its own
 * copy of the realm, read from the file main loaded it from, with the tuning
 * main sent, so not one leg holds the thread that reads every socket. Keeps
 * the last realm it read; a batch for another file reads that one instead.
 */
import { parentPort } from 'node:worker_threads';

import { setTuning } from '../app/tuning';
import { errorMessage } from '../../shared/values';
import type { TuningConfig } from '../../shared/internal';
import { planLapLegs, type LapLegsAnswer, type LapLegsAsk } from './lapLegs';
import { WorldGraph } from './WorldGraph';

/** One batch to plan. */
export interface LapWork {
  id: number;
  file: string;
  tuning: TuningConfig;
  ask: LapLegsAsk;
}

/** What comes back for one batch. */
export type LapWorkDone = { id: number; answer: LapLegsAnswer } | { id: number; error: string };

let held: { file: string; graph: WorldGraph } | null = null;

parentPort?.on('message', (work: LapWork) => {
  let done: LapWorkDone;
  try {
    setTuning(work.tuning);
    if (held?.file !== work.file) held = { file: work.file, graph: WorldGraph.load(work.file) };
    done = { id: work.id, answer: planLapLegs(held.graph, work.ask) };
  } catch (error) {
    done = { id: work.id, error: errorMessage(error) };
  }
  parentPort?.postMessage(done);
});
