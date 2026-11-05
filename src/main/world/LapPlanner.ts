/**
 * Where a lap's legs are planned (`lapLegs.ts`): on the route worker
 * (`lapWorker.ts`) when the realm came from a file, so the Loops window's
 * lap index never holds the thread that reads every socket; on main, a leg a
 * turn, for a realm with no file, or for every batch once the worker failed
 * (said once). The worker exits after `world.routeWorkerIdleMs` with nothing
 * to plan, handing back its copy of the realm. See `mudengine-world` › *The
 * lap index is planned on the route worker*.
 */
import { Worker } from 'node:worker_threads';

import { t } from '../app/i18n';
import { nextTurn } from '../app/nextTurn';
import { tuning } from '../app/tuning';
import { errorMessage } from '../../shared/values';
import type { FightOdds } from '../../shared/world';
import {
  fightKey,
  planLapLegs,
  type FightAsked,
  type LapLegsAnswer,
  type LapLegsAsk
} from './lapLegs';
import type { PlanLegs } from './lapIndex';
import type { LapWork, LapWorkDone } from './lapWorker';

type LapWorld = Parameters<typeof planLapLegs>[0];

/** What a lap index plans its legs with. */
export interface LapLegPlanner {
  /** One batch, planned over `world`, read from `file` where the realm has one. */
  plan(file: string | null, world: LapWorld, ask: LapLegsAsk): Promise<LapLegsAnswer>;
}

interface Waiting {
  readonly world: LapWorld;
  readonly ask: LapLegsAsk;
  readonly settle: (answer: Promise<LapLegsAnswer>) => void;
}

export class LapPlanner implements LapLegPlanner {
  private worker: Worker | null = null;
  private readonly waiting = new Map<number, Waiting>();
  private nextId = 1;
  private failed = false;
  private disposed = false;
  private idle: NodeJS.Timeout | null = null;

  constructor(
    /** The worker's built entry (`lapWorker.js` beside `index.js`). */
    private readonly workerFile: string,
    private readonly say: (message: string) => void
  ) {}

  plan(file: string | null, world: LapWorld, ask: LapLegsAsk): Promise<LapLegsAnswer> {
    if (this.disposed) return Promise.resolve(nothingPlanned(ask));
    if (file === null || this.failed) return onMain(world, ask);
    return new Promise<LapLegsAnswer>((resolve) => {
      const id = this.nextId++;
      this.waiting.set(id, { world, ask, settle: (answer) => resolve(answer) });
      const work: LapWork = { id, file, tuning: tuning(), ask };
      try {
        this.started().postMessage(work);
      } catch (error) {
        // A batch that cannot be cloned to the worker: main plans it, and every one after.
        this.fail(errorMessage(error));
      }
    });
  }

  /** Stops the worker at quit: nothing is planned after it, and a batch still out is answered with no rooms. */
  dispose(): void {
    this.disposed = true;
    for (const waiting of this.waiting.values()) {
      waiting.settle(Promise.resolve(nothingPlanned(waiting.ask)));
    }
    this.waiting.clear();
    this.fail(null);
  }

  private started(): Worker {
    if (this.idle !== null) clearTimeout(this.idle);
    this.idle = null;
    if (this.worker !== null) return this.worker;
    const worker = new Worker(this.workerFile);
    worker.on('message', (done: LapWorkDone) => {
      if (worker !== this.worker) return;
      // A batch the worker could not plan: main plans it, and every one after.
      if ('error' in done) {
        this.fail(done.error);
        return;
      }
      const waiting = this.waiting.get(done.id);
      if (waiting === undefined) return;
      this.waiting.delete(done.id);
      waiting.settle(Promise.resolve(done.answer));
      if (this.waiting.size === 0) this.restAfter(worker);
    });
    worker.on('error', (error) => this.fail(errorMessage(error)));
    worker.on('messageerror', (error) => this.fail(errorMessage(error)));
    worker.on('exit', (code) => {
      if (worker === this.worker && this.waiting.size > 0) this.fail(`exited with code ${code}`);
      if (worker === this.worker) this.worker = null;
    });
    // Waiting on nothing, it never holds the process open on the way out.
    worker.unref();
    this.worker = worker;
    return worker;
  }

  /** Lets the worker go after a quiet spell, with its copy of the realm. */
  private restAfter(worker: Worker): void {
    this.idle = setTimeout(() => {
      this.idle = null;
      if (worker !== this.worker || this.waiting.size > 0) return;
      this.worker = null;
      void worker.terminate();
    }, tuning().world.routeWorkerIdleMs);
    this.idle.unref?.();
  }

  /** Every batch from now on, the ones out included, planned on main; `why` said once, null when put down. */
  private fail(why: string | null): void {
    if (this.idle !== null) clearTimeout(this.idle);
    this.idle = null;
    const worker = this.worker;
    this.worker = null;
    if (worker !== null) void worker.terminate();
    if (why !== null && !this.failed) this.say(t('notices.routeWorker.failed', { error: why }));
    this.failed = true;
    const owed = [...this.waiting.values()];
    this.waiting.clear();
    for (const waiting of owed) waiting.settle(onMain(waiting.world, waiting.ask));
  }
}

/** A batch answered with no way for any leg, for a planner put down at quit. */
function nothingPlanned(ask: LapLegsAsk): LapLegsAnswer {
  return { rooms: ask.legs.map(() => []), asked: [], unsure: [] };
}

/** A batch planned on main, a leg a turn, so no more than one leg holds the thread at once. */
async function onMain(world: LapWorld, ask: LapLegsAsk): Promise<LapLegsAnswer> {
  const answer: LapLegsAnswer = { rooms: [], asked: [], unsure: [] };
  const seen = new Set<string>();
  for (const [index, legOf] of ask.legs.entries()) {
    await nextTurn();
    const one = planLapLegs(world, { ...ask, legs: [legOf] });
    answer.rooms.push(one.rooms[0] ?? []);
    if (one.unsure.length > 0) answer.unsure.push(index);
    for (const asked of one.asked) {
      const key = fightKey(asked);
      if (!seen.has(key)) answer.asked.push(asked);
      seen.add(key);
    }
  }
  return answer;
}

/**
 * A lap index's `planLegs` for one build: each loop's legs as one batch, and
 * every fight a batch asked that the table did not hold looked up in `fight`
 * (the session's odds book) and those legs planned again, until a round asks
 * nothing new. The table only grows and holds a finite set of monsters where
 * they stand, so the rounds end.
 */
export function planningLegs(
  planner: LapLegPlanner,
  file: string | null,
  world: LapWorld,
  base: Pick<LapLegsAsk, 'traveller' | 'purse'>,
  fight: (asked: FightAsked) => FightOdds
): PlanLegs {
  const fights: Record<string, FightOdds> = {};
  return async (legs) => {
    let answer = await planner.plan(file, world, { ...base, fights: { ...fights }, legs });
    const rooms = answer.rooms;
    let unsure = answer.unsure;
    while (answer.asked.length > 0 && unsure.length > 0) {
      for (const asked of answer.asked) fights[fightKey(asked)] = fight(asked);
      const again = unsure.map((index) => legs[index]!);
      answer = await planner.plan(file, world, { ...base, fights: { ...fights }, legs: again });
      for (const [at, planned] of answer.rooms.entries()) rooms[unsure[at]!] = planned;
      const before = unsure;
      unsure = answer.unsure.map((at) => before[at]!);
    }
    return rooms;
  };
}
