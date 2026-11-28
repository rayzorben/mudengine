/**
 * Walking a sell run (`shared/sellRun.ts`): each stop in the plan's order, the
 * picked floor items taken with one `get` each and the picked items sold with
 * one `sell` each (`Handover`, the pack gaining or losing it the
 * confirmation). Started only by the player from the Inventory card's Sell
 * face. In the floor's room it takes what the room lists now, searching first
 * for a picked item no list shows (`Collect`), and what is no longer there is
 * said. A `get` the pack did not confirm leaves the item in its room, and
 * once a round has sold something the rest is planned again from there, up
 * to `tuning.sellRun.maxRounds`. Each leg is planned from where the character
 * stands; a fight on the way is waited out. Yields to an escape; holds the
 * lap; dropped on a death; every ending said. See `mudengine-automation` ›
 * `parts/gear.md`.
 */
import { Collect, type CollectEnd, type CollectPlanner } from './Collect';
import type { CommandQueue } from './CommandQueue';
import { Handover, type HandoverEnd, type HandoverPlanner } from './Handover';
import type { SessionModule } from './Module';
import { tripRefusal, type TripPlanner } from './askedTrip';
import { walkLeg } from './errandLeg';
import { stoppedByPerson } from './personStop';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SafetyDecision } from '../../shared/automation';
import type { Block } from '../../shared/blocks';
import { fightIsRunning, type CharacterState } from '../../shared/character';
import { sameItem } from '../../shared/items';
import {
  planSales,
  type SellChoice,
  type SellItem,
  type SellPick,
  type SellRunPlan,
  type SellRunProgress,
  type SellRunStage,
  type SellStop
} from '../../shared/sellRun';
import type { RoomId } from '../../shared/world';
import { errorMessage } from '../../shared/values';

export interface SellRunPlanner extends TripPlanner, HandoverPlanner, CollectPlanner {
  /** The character as it stands. */
  current(): CharacterState;
  /** An escape in flight, which outranks the run once it is under way. */
  escaping(): boolean;
  /** The Sell face's rows. */
  choices(): SellChoice[];
  /** The rounds for the card's picks, from where the character stands. */
  plan(picks: readonly SellPick[]): Promise<SellRunPlan>;
  /** The rounds for what a take left lying in `room`. */
  again(floor: readonly SellItem[], room: RoomId): Promise<SellRunPlan>;
  /** Starts with automation turned on if it was off, as a route the player asked for is. */
  switchedOnFor(start: () => string | null): string | null;
  /** Ends the leg the run is walking. */
  stopWalk(reason: string): void;
}

export interface SellRunEvents {
  notice?(message: string): void;
  decided?(decision: SafetyDecision): void;
  sellRun?(progress: SellRunProgress | null): void;
}

interface Run {
  plan: SellRunPlan;
  /** Whether the lap was running and is held for the run. */
  held: boolean;
  stop: number;
  stage: SellRunStage;
  /** Waiting out a fight before the leg is planned again. */
  waiting: boolean;
  legs: number;
  /** How many times the rest was planned again. */
  replans: number;
  /** Whether anything sold since the last plan: a round that sold nothing made no room. */
  soldSince: boolean;
  sold: string[];
  taken: string[];
  missed: string[];
  /** What a take did not get, by the room it lies in. */
  lying: { room: RoomId; items: SellItem[] } | null;
  /** Picked off the floor and no longer there when the run came for it. */
  absent: string[];
}

const ACTION = 'sell run';
const KEY = 'sell-run';

/** A stop's names, one per copy: each `get` and `sell` takes one. */
function copies(items: ReadonlyArray<{ name: string; count: number }>): string[] {
  return items.flatMap((item) => Array.from({ length: item.count }, () => item.name));
}

/** The unworn copies of `name` in the pack: `sell` would take a worn one after them. */
function unworn(state: CharacterState, name: string): number {
  return state.inventory.items.filter((item) => !item.equipped && sameItem(item.name, name)).length;
}

/** How many of `name` the room's floors list: in the open, or turned up by a search. */
function listed(state: CharacterState, name: string): number {
  return [...state.room.items, ...state.room.hidden]
    .filter((pile) => sameItem(pile.name, name))
    .reduce((sum, pile) => sum + (pile.count ?? 1), 0);
}

export class SellRun implements SessionModule {
  private run: Run | null = null;
  private readonly handover: Handover;
  /** The search for a picked item no floor lists, and the first `get` of each it turns up. */
  private readonly collect: Collect;
  private last: SellRunProgress | null = null;
  /** A start still planning; a Stop, a reset or the switch going off drops it before it sets off. */
  private asked: symbol | null = null;

  constructor(
    private enabled: boolean,
    queue: CommandQueue,
    private readonly planner: SellRunPlanner,
    private readonly events: SellRunEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {
    this.handover = new Handover(queue, planner, { ended: (end) => this.served(end) }, now);
    const looked = { ended: (end: CollectEnd, state: CharacterState) => this.looked(end, state) };
    this.collect = new Collect(queue, planner, looked, now);
  }

  configure(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) return;
    this.asked = null;
    if (this.run !== null) this.end(t('automation.hostTrip.endedSwitchedOff'));
  }

  reset(): void {
    this.handover.cancel();
    this.collect.cancel();
    this.run = null;
    this.asked = null;
  }

  get busy(): boolean {
    return this.run !== null;
  }

  /** The run under way, or the last one as it ended. */
  get progress(): SellRunProgress | null {
    return this.run === null ? this.last : this.progressOf(this.run, null);
  }

  choices(): SellChoice[] {
    return this.planner.choices();
  }

  plan(picks: readonly SellPick[]): Promise<SellRunPlan> {
    return this.planner.plan(picks);
  }

  /** A death, or a walk back for a member: the run ends, saying `why`. */
  abandon(why: string): void {
    if (this.run !== null) this.end(why);
  }

  /** The player's Stop. */
  stop(): void {
    // A start still planning is dropped here, and says so when its plan comes back.
    this.asked = null;
    if (this.run === null) return;
    const why = t('automation.sellRun.stoppedByPlayer');
    this.end(why);
    this.planner.stopWalk(why);
  }

  /** Plans from here and sets off; the refusal, said, or null once under way. */
  async start(picks: readonly SellPick[]): Promise<string | null> {
    const ask = Symbol('sell run');
    this.asked = ask;
    const plan = await this.planner.plan(picks);
    if (this.asked !== ask) {
      const dropped = t('automation.sellRun.refusalDropped');
      this.say(t('automation.sellRun.refused', { why: dropped }), dropped);
      return dropped;
    }
    this.asked = null;
    return this.planner.switchedOnFor(() => this.begin(plan, this.planner.current()));
  }

  private begin(plan: SellRunPlan, state: CharacterState): string | null {
    const names = plan.stops.flatMap((stop) => stop.items.map((item) => item.name));
    const running = this.run !== null;
    const refused =
      plan.refusal ?? tripRefusal(names, { enabled: this.enabled, running }, state, this.planner);
    if (refused !== null) {
      this.say(t('automation.sellRun.refused', { why: refused }), refused);
      return refused;
    }
    const held = this.planner.looping();
    const run: Run = {
      plan,
      held,
      stop: 0,
      stage: 'walking',
      waiting: false,
      legs: 0,
      replans: 0,
      soldSince: false,
      sold: [],
      taken: [],
      missed: [],
      lying: null,
      absent: []
    };
    this.run = run;
    if (held) this.planner.hold();
    const going = { items: planSales(plan), stops: plan.stops.length, moves: plan.moves };
    this.events.notice?.(
      plan.stops.length === 1
        ? t('automation.sellRun.going.one', going)
        : t('automation.sellRun.going.many', going)
    );
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.sellRun.because'),
      acted: true
    });
    this.toStop(run, state);
    return null;
  }

  /** A search's answer, for the look round the floor's room. */
  onBlock(block: Block): void {
    if (this.run !== null) this.collect.onBlock(block);
  }

  onCharacter(state: CharacterState): void {
    const run = this.run;
    if (run === null) return;
    this.handover.onCharacter(state);
    if (this.run === run) this.collect.onCharacter(state);
    if (this.run === run && run.waiting) {
      if (fightIsRunning(state) || this.planner.moveInFlight()) return;
      run.waiting = false;
      this.leg(run);
    }
  }

  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    const run = this.run;
    if (run === null || run.stage !== 'walking' || run.waiting) return;
    const stop = run.plan.stops[run.stop];
    if (stop === undefined) return;
    if (arrived && this.planner.here() === stop.room) {
      this.arrive(run, stop, state);
      return;
    }
    // A fight stops the walker and is waited out; anything else ends the run, said.
    if (!stoppedByPerson(reason) && fightIsRunning(state)) {
      run.waiting = true;
      return;
    }
    const why = reason ?? t('automation.hostTrip.whyStopped');
    this.end(t('automation.sellRun.notReached', { place: stop.place, why }));
  }

  private toStop(run: Run, state: CharacterState): void {
    const stop = run.plan.stops[run.stop];
    if (stop === undefined) {
      this.roundsOver(run);
      return;
    }
    run.stage = 'walking';
    run.legs = 0;
    run.waiting = false;
    if (this.planner.here() === stop.room) {
      this.arrive(run, stop, state);
      return;
    }
    this.leg(run);
  }

  /** Plan and walk the leg to the current stop from where the character stands. */
  private leg(run: Run): void {
    const stop = run.plan.stops[run.stop]!;
    run.legs += 1;
    const refused = walkLeg(
      this.planner,
      stop.room as RoomId,
      stop.place,
      run.legs,
      tuning().sellRun.maxLegs
    );
    if (refused === null) {
      this.publish(run);
      return;
    }
    this.end(
      'ends' in refused
        ? refused.ends
        : t('automation.sellRun.notReached', { place: stop.place, why: refused.notReached })
    );
  }

  private arrive(run: Run, stop: SellStop, state: CharacterState): void {
    const { confirmMs } = tuning().sellRun;
    switch (stop.kind) {
      case 'floor':
        run.stage = 'taking';
        this.publish(run);
        this.look(run, stop, state);
        return;
      case 'shop': {
        run.stage = 'selling';
        this.publish(run);
        // Only what is carried unworn is sold: a take that failed is still in its room.
        const carried = stop.items.map((item) => ({
          name: item.name,
          count: Math.min(item.count, unworn(state, item.name))
        }));
        const short = stop.items
          .map((item, at) => ({ name: item.name, count: item.count - carried[at]!.count }))
          .filter((item) => item.count > 0 && !this.neverTaken(run, item.name));
        if (short.length > 0) {
          const names = short.map((item) => item.name);
          run.missed.push(...copies(short));
          this.say(
            t('automation.sellRun.notCarried', { items: names.join(', ') }),
            names.join(', ')
          );
        }
        this.handover.start(
          {
            at: null,
            verb: 'sell',
            items: copies(carried),
            key: KEY,
            reason: (item) => t('automation.sellRun.reasonSell', { item, shop: stop.shop }),
            confirmMs
          },
          state
        );
        return;
      }
      default: {
        const never: never = stop;
        return never;
      }
    }
  }

  /** Still in its room for a later round, or gone from it: either way it was said there. */
  private neverTaken(run: Run, name: string): boolean {
    return (
      run.lying?.items.some((item) => sameItem(item.name, name)) === true ||
      run.absent.some((gone) => sameItem(gone, name))
    );
  }

  /**
   * In the floor's room: what the room lists now is what is taken. A picked
   * item on neither list is searched for first, since a hidden pile is listed
   * only by a search and each search can miss it (`Collect`).
   */
  private look(run: Run, stop: SellStop, state: CharacterState): void {
    const unseen = stop.items.filter((item) => listed(state, item.name) < item.count);
    if (unseen.length === 0) {
      this.take(run, stop, state, [], []);
      return;
    }
    const { confirmMs, searches } = tuning().sellRun;
    const started = this.collect.start(
      {
        to: stop.room as RoomId,
        items: unseen.map((item) => item.name),
        search: { times: searches, reason: t('automation.sellRun.reasonSearch') },
        key: `${KEY}-look`,
        reason: (item) => t('automation.sellRun.reasonTake', { item }),
        collectMs: confirmMs,
        expiresMs: confirmMs
      },
      state
    );
    // The run stands in the room, so anything but a start here is a room it is no longer in.
    if (started.kind !== 'here') this.end(t('automation.sellRun.leftRoom', { place: stop.place }));
  }

  /** What the search and its first `get`s came to; the rest of each pile is taken after. */
  private looked(end: CollectEnd, state: CharacterState): void {
    const run = this.run;
    const stop = run?.plan.stops[run.stop];
    if (run === null || stop?.kind !== 'floor') return;
    switch (end.kind) {
      case 'not-reached':
      case 'left':
        this.end(t('automation.sellRun.leftRoom', { place: stop.place }));
        return;
      case 'nothing-here':
        this.take(run, stop, state, [], []);
        return;
      case 'taken': {
        const refused = end.asked.filter((item) => !end.arrived.includes(item));
        this.take(run, stop, state, end.arrived, refused);
        return;
      }
      default: {
        const never: never = end;
        return never;
      }
    }
  }

  /**
   * One `get` a copy the room still lists. `got` came with the search, one
   * of each; `refused` the pack did not take then, so they wait for a later
   * round with the rest of their pile. What no list shows is gone, and said.
   */
  private take(
    run: Run,
    stop: SellStop,
    state: CharacterState,
    got: readonly string[],
    refused: readonly string[]
  ): void {
    const named = (names: readonly string[], item: SellItem): boolean =>
      names.some((name) => sameItem(name, item.name));
    if (got.length > 0) {
      run.taken.push(...got);
      this.events.notice?.(t('automation.sellRun.took', { items: got.join(', ') }));
    }
    const wanted = stop.items.map((item) => {
      const left = item.count - (named(got, item) ? 1 : 0);
      const there = Math.min(left, listed(state, item.name));
      return { name: item.name, left, there, waits: named(refused, item) };
    });
    const waiting = wanted.filter((item) => item.waits);
    if (waiting.length > 0) {
      const names = copies(waiting.map((item) => ({ name: item.name, count: item.left })));
      this.leave(run, stop, names);
      this.say(
        t('automation.sellRun.notTaken', { items: names.join(', '), place: stop.place }),
        names.join(', ')
      );
    }
    const gone = wanted
      .filter((item) => !item.waits && item.there < item.left)
      .map((item) => ({ name: item.name, count: item.left - item.there }));
    if (gone.length > 0) {
      const names = copies(gone);
      run.absent.push(...names);
      run.missed.push(...names);
      this.say(
        t('automation.sellRun.notThere', { items: names.join(', '), place: stop.place }),
        names.join(', ')
      );
    }
    const taking = wanted
      .filter((item) => !item.waits)
      .map((item) => ({ name: item.name, count: item.there }));
    this.handover.start(
      {
        at: null,
        verb: 'get',
        items: copies(taking),
        key: KEY,
        reason: (item) => t('automation.sellRun.reasonTake', { item }),
        receives: true,
        confirmMs: tuning().sellRun.confirmMs
      },
      state
    );
  }

  /** What the stop's verbs came to. */
  private served(end: HandoverEnd): void {
    const run = this.run;
    const stop = run?.plan.stops[run.stop];
    if (run === null || stop === undefined || end.kind !== 'handed') return;
    const unanswered = [...end.unanswered, ...end.unsent];
    switch (stop.kind) {
      case 'floor':
        run.taken.push(...end.gone);
        if (end.gone.length > 0) {
          this.events.notice?.(t('automation.sellRun.took', { items: end.gone.join(', ') }));
        }
        if (unanswered.length > 0) {
          this.leave(run, stop, unanswered);
          this.say(
            t('automation.sellRun.notTaken', { items: unanswered.join(', '), place: stop.place }),
            unanswered.join(', ')
          );
        }
        break;
      case 'shop':
        run.sold.push(...end.gone);
        run.soldSince = run.soldSince || end.gone.length > 0;
        if (end.gone.length > 0) {
          this.events.notice?.(
            t('automation.sellRun.sold', { items: end.gone.join(', '), shop: stop.shop })
          );
        }
        if (unanswered.length > 0) {
          run.missed.push(...unanswered);
          this.say(
            t('automation.sellRun.notSold', { items: unanswered.join(', '), shop: stop.shop }),
            unanswered.join(', ')
          );
        }
        break;
      default: {
        const never: never = stop;
        return never;
      }
    }
    run.stop += 1;
    this.toStop(run, this.planner.current());
  }

  /** Remembers what a take did not get, a count a name, for the round planned after this one. */
  private leave(run: Run, stop: SellStop, names: readonly string[]): void {
    const lying = run.lying ?? { room: stop.room as RoomId, items: [] };
    for (const name of names) {
      const kept = lying.items.find((item) => item.name === name);
      const planned = stop.items.find((item) => item.name === name);
      if (kept !== undefined) kept.count += 1;
      else if (planned !== undefined) lying.items.push({ ...planned, count: 1 });
    }
    run.lying = lying;
  }

  /**
   * Past the last stop. What a take left lying is planned again from here
   * while the round sold something to make the room for it; a round that sold
   * nothing, or the last round allowed, leaves it and says so.
   */
  private roundsOver(run: Run): void {
    const lying = run.lying;
    if (lying === null || lying.items.length === 0) {
      this.end(null);
      return;
    }
    const names = lying.items.map((item) => item.name).join(', ');
    if (!run.soldSince || run.replans >= tuning().sellRun.maxRounds) {
      run.missed.push(...copies(lying.items));
      this.say(t('automation.sellRun.leftLying', { items: names }), names);
      this.end(null);
      return;
    }
    run.stage = 'planning';
    run.replans += 1;
    run.soldSince = false;
    run.lying = null;
    this.publish(run);
    this.events.notice?.(t('automation.sellRun.goingBack', { items: names }));
    void this.planner.again(lying.items, lying.room).then(
      (plan) => {
        if (this.run !== run) return;
        if (plan.refusal !== undefined || plan.stops.length === 0) {
          run.missed.push(...copies(lying.items));
          this.say(t('automation.sellRun.leftLying', { items: names }), plan.refusal ?? names);
          this.end(null);
          return;
        }
        run.plan = plan;
        run.stop = 0;
        this.toStop(run, this.planner.current());
      },
      (error: unknown) => {
        if (this.run === run)
          this.end(t('automation.sellRun.planFailed', { why: errorMessage(error) }));
      }
    );
  }

  /** Over: `why` null is the run past its last stop. */
  private end(why: string | null): void {
    const run = this.run;
    if (run === null) return;
    this.handover.cancel();
    this.collect.cancel();
    this.run = null;
    if (run.held) this.planner.release();
    const ended =
      why ?? t('automation.sellRun.done', { sold: run.sold.length, missed: run.missed.length });
    if (why === null) this.events.notice?.(ended);
    else this.say(t('automation.sellRun.ended', { why }), why);
    run.stage = 'ended';
    this.last = this.progressOf(run, ended, why === null);
    this.events.sellRun?.(this.last);
  }

  private publish(run: Run): void {
    this.events.sellRun?.(this.progressOf(run, null));
  }

  private progressOf(run: Run, ended: string | null, done = false): SellRunProgress {
    return {
      plan: run.plan,
      stop: run.stop,
      stage: run.stage,
      sold: [...run.sold],
      taken: [...run.taken],
      missed: [...run.missed],
      ended,
      done
    };
  }

  /** A refusal or a setback, said and traced. */
  private say(message: string, refused: string): void {
    this.events.notice?.(message);
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.sellRun.because'),
      acted: false,
      refused
    });
  }
}
