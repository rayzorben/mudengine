/**
 * The route worker (`LapPlanner`): plans batches of a lap's legs, and of the
 * quest reach's rooms, over its own copy of the realm, read from the file
 * main loaded it from, with the tuning main sent, so not one leg holds the
 * thread that reads every socket. Keeps the last realm it read; a batch for
 * another file reads that one instead.
 */
import { parentPort } from 'node:worker_threads';

import { setTuning } from '../app/tuning';
import { errorMessage } from '../../shared/values';
import type { TuningConfig } from '../../shared/internal';
import { planLapLegs, type LapLegsAnswer, type LapLegsAsk } from './lapLegs';
import { planReachLegs, type ReachLegsAnswer, type ReachLegsAsk } from './reachLegs';
import { WorldGraph } from './WorldGraph';

/** What one batch plans: a lap's legs, or the quest reach's rooms. */
export type RouteJob = { kind: 'lap'; ask: LapLegsAsk } | { kind: 'reach'; ask: ReachLegsAsk };

/** One batch to plan. */
export type LapWork = { id: number; file: string; tuning: TuningConfig } & RouteJob;

/** One batch's answer, tagged with the kind of job it answers. */
export type RouteAnswer =
  { kind: 'lap'; answer: LapLegsAnswer } | { kind: 'reach'; answer: ReachLegsAnswer };

/** What comes back for one batch. */
export type LapWorkDone = ({ id: number } & RouteAnswer) | { id: number; error: string };

let held: { file: string; graph: WorldGraph } | null = null;

function answerOf(graph: WorldGraph, job: RouteJob): RouteAnswer {
  switch (job.kind) {
    case 'lap':
      return { kind: 'lap', answer: planLapLegs(graph, job.ask) };
    case 'reach':
      return { kind: 'reach', answer: planReachLegs(graph, job.ask) };
    default: {
      const exhausted: never = job;
      throw new Error(`A route job of no known kind: ${JSON.stringify(exhausted)}`);
    }
  }
}

parentPort?.on('message', (work: LapWork) => {
  let done: LapWorkDone;
  try {
    setTuning(work.tuning);
    if (held?.file !== work.file) held = { file: work.file, graph: WorldGraph.load(work.file) };
    done = { id: work.id, ...answerOf(held.graph, work) };
  } catch (error) {
    done = { id: work.id, error: errorMessage(error) };
  }
  parentPort?.postMessage(done);
});
