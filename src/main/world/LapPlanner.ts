/**
 * Where a lap's legs (`lapLegs.ts`) and the quest reach's rooms
 * (`reachLegs.ts`) are planned: on the route worker (`lapWorker.ts`) when the
 * realm came from a file, so neither the Loops window's lap index nor the
 * Quests card holds the thread that reads every socket; on main, a leg a
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
import type { LapWork, LapWorkDone, RouteAnswer, RouteJob } from './lapWorker';
import {
  planReachLegs,
  type Opening,
  type PlanReach,
  type ReachLegsAnswer,
  type ReachLegsAsk,
  type ReachWorld
} from './reachLegs';

type LapWorld = Parameters<typeof planLapLegs>[0];

/** What a lap index plans its legs with. */
export interface LapLegPlanner {
  /** One batch, planned over `world`, read from `file` where the realm has one. */
  plan(file: string | null, world: LapWorld, ask: LapLegsAsk): Promise<LapLegsAnswer>;
}

/** What the quest reach plans its rooms with. */
export interface ReachLegPlanner {
  /** One batch, planned over `world`, read from `file` where the realm has one. */
  reach(file: string | null, world: ReachWorld, ask: ReachLegsAsk): Promise<ReachLegsAnswer>;
}

/** A batch out on the worker, and how it is answered should the worker go. */
interface Waiting {
  /** The worker's answer; one of another kind than the batch is a broken invariant. */
  readonly answered: (done: RouteAnswer) => void;
  /** Planned on main instead. */
  readonly onMain: () => void;
  /** Answered with nothing, at quit. */
  readonly nothing: () => void;
}

export class LapPlanner implements LapLegPlanner, ReachLegPlanner {
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
    return this.post(
      file,
      { kind: 'lap', ask },
      (done) => (done.kind === 'lap' ? done.answer : null),
      () => lapsOnMain(world, ask),
      () => nothingPlanned(ask)
    );
  }

  reach(file: string | null, world: ReachWorld, ask: ReachLegsAsk): Promise<ReachLegsAnswer> {
    return this.post(
      file,
      { kind: 'reach', ask },
      (done) => (done.kind === 'reach' ? done.answer : null),
      () => reachOnMain(world, ask),
      () => nothingReached(ask)
    );
  }

  /**
   * One batch to the worker; on main where the realm has no file or the
   * worker failed, and nothing once put down. `take` reads the worker's
   * answer for `job`'s kind, null for any other.
   */
  private post<A>(
    file: string | null,
    job: RouteJob,
    take: (done: RouteAnswer) => A | null,
    onMain: () => Promise<A>,
    nothing: () => A
  ): Promise<A> {
    if (this.disposed) return Promise.resolve(nothing());
    if (file === null || this.failed) return onMain();
    return new Promise<A>((resolve) => {
      const id = this.nextId++;
      this.waiting.set(id, {
        answered: (done) => {
          const answer = take(done);
          if (answer !== null) {
            resolve(answer);
            return;
          }
          // The worker answered another kind of batch: main plans this one, and every one after.
          resolve(onMain());
          this.fail(t('notices.routeWorker.wrongKind', { asked: job.kind, answered: done.kind }));
        },
        onMain: () => resolve(onMain()),
        nothing: () => resolve(nothing())
      });
      const work: LapWork = { id, file, tuning: tuning(), ...job };
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
    for (const waiting of this.waiting.values()) waiting.nothing();
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
      waiting.answered(done);
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
    for (const waiting of owed) waiting.onMain();
  }
}

/** A batch answered with no way for any leg, for a planner put down at quit. */
function nothingPlanned(ask: LapLegsAsk): LapLegsAnswer {
  return { rooms: ask.legs.map(() => []), asked: [], unsure: [] };
}

/** A reach answered unknown for every room, for a planner put down at quit. */
function nothingReached(ask: ReachLegsAsk): ReachLegsAnswer {
  return { levels: ask.rooms.map(() => 'spent'), asked: [], unsure: [] };
}

/** One item's answer out of a batch of one: its result, the fights it asked, and whether it is unsure. */
interface OneAnswer<R> {
  result: R;
  asked: readonly FightAsked[];
  unsure: boolean;
}

/** A batch planned on main, an item a turn, so no more than one leg holds the thread at once. */
async function aTurnEach<T, R>(
  items: readonly T[],
  one: (item: T) => OneAnswer<R>
): Promise<{ results: R[]; asked: FightAsked[]; unsure: number[] }> {
  const answer = { results: [] as R[], asked: [] as FightAsked[], unsure: [] as number[] };
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    await nextTurn();
    const planned = one(item);
    answer.results.push(planned.result);
    if (planned.unsure) answer.unsure.push(index);
    for (const asked of planned.asked) {
      const key = fightKey(asked);
      if (!seen.has(key)) answer.asked.push(asked);
      seen.add(key);
    }
  }
  return answer;
}

async function lapsOnMain(world: LapWorld, ask: LapLegsAsk): Promise<LapLegsAnswer> {
  const { results, asked, unsure } = await aTurnEach(ask.legs, (legOf) => {
    const one = planLapLegs(world, { ...ask, legs: [legOf] });
    return { result: one.rooms[0] ?? [], asked: one.asked, unsure: one.unsure.length > 0 };
  });
  return { rooms: results, asked, unsure };
}

async function reachOnMain(world: ReachWorld, ask: ReachLegsAsk): Promise<ReachLegsAnswer> {
  const { results, asked, unsure } = await aTurnEach(ask.rooms, (room) => {
    const one = planReachLegs(world, { ...ask, rooms: [room] });
    const result: Opening = one.levels[0] ?? 'spent';
    return { result, asked: one.asked, unsure: one.unsure.length > 0 };
  });
  return { levels: results, asked, unsure };
}

/**
 * A batch planned, and every fight it asked that the table did not hold
 * looked up in `fight` (the session's odds book) and those items planned
 * again, until a round asks nothing new. The table only grows and holds a
 * finite set of monsters where they stand, so the rounds end.
 */
async function withFightsAnswered<T, R>(
  items: readonly T[],
  fights: Record<string, FightOdds>,
  plan: (
    items: readonly T[],
    fights: Readonly<Record<string, FightOdds>>
  ) => Promise<{ results: readonly R[]; asked: readonly FightAsked[]; unsure: readonly number[] }>,
  fight: (asked: FightAsked) => FightOdds,
  /** Stops the rounds where a later ask replaced this one, with what is planned so far. */
  superseded: () => boolean = () => false
): Promise<R[]> {
  let answer = await plan(items, { ...fights });
  const results = [...answer.results];
  let unsure = answer.unsure;
  while (answer.asked.length > 0 && unsure.length > 0 && !superseded()) {
    for (const asked of answer.asked) fights[fightKey(asked)] = fight(asked);
    const again = unsure.map((index) => items[index]!);
    answer = await plan(again, { ...fights });
    for (const [at, planned] of answer.results.entries()) results[unsure[at]!] = planned;
    const before = unsure;
    unsure = answer.unsure.map((at) => before[at]!);
  }
  return results;
}

/** A lap index's `planLegs` for one build: each loop's legs as one batch (`withFightsAnswered`). */
export function planningLegs(
  planner: LapLegPlanner,
  file: string | null,
  world: LapWorld,
  base: Pick<LapLegsAsk, 'traveller' | 'purse'>,
  fight: (asked: FightAsked) => FightOdds
): PlanLegs {
  const fights: Record<string, FightOdds> = {};
  return (legs) =>
    withFightsAnswered(
      legs,
      fights,
      async (some, known) => {
        const answer = await planner.plan(file, world, { ...base, fights: known, legs: some });
        return { ...answer, results: answer.rooms };
      },
      fight
    );
}

/**
 * The quest reach's `PlanReach` for one ask: a room a batch, each with its
 * fights answered (`withFightsAnswered`), so a later ask stops this one
 * between rooms on the worker as on main. A whole reach in one batch held
 * the worker, and every lap batch behind it, for over a minute; one room
 * holds it for up to `questReachLegMs`. A room left unplanned is `spent`,
 * which nobody reads once superseded.
 */
export function planningReach(
  planner: ReachLegPlanner,
  file: string | null,
  world: ReachWorld,
  fight: (asked: FightAsked) => FightOdds
): PlanReach {
  const fights: Record<string, FightOdds> = {};
  return async (base, rooms, superseded) => {
    const levels: Opening[] = [];
    for (const room of rooms) {
      if (superseded()) {
        levels.push('spent');
        continue;
      }
      const [opened] = await withFightsAnswered(
        [room],
        fights,
        async (some, known) => {
          const answer = await planner.reach(file, world, { ...base, fights: known, rooms: some });
          return { ...answer, results: answer.levels };
        },
        fight,
        superseded
      );
      levels.push(opened ?? 'spent');
    }
    return levels;
  };
}
