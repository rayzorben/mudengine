/**
 * Going to collect the level — the thing an unattended client has to do and
 * did not (todo 18, 2026-09-12).
 *
 * In this realm experience past the threshold does nothing at all until a
 * trainer is paid: no hit points, no skills, no character points. So a client
 * left to play overnight without this comes back with a night's experience and
 * exactly the character it started with, having fought all night at the
 * statistics it began with.
 *
 * An errand in the shape `Supplies` and `GearRecovery` already have: it yields
 * to everything, walks as a leg, holds the lap rather than ending it, and says
 * every refusal out loud. Off by default. See `mudengine-automation` § *Going
 * to collect the level is an errand, and the trainer is the player's*.
 */
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SafetyDecision } from '../../shared/automation';
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import type { TrainConfig } from '../../shared/config';
import { REFRESH } from '../../shared/staleness';
import { carriedCount } from '../../shared/supplies';
import { bestTrainer, pricedOut, walkSurvived } from '../../shared/training';
import {
  nameAnswersTo,
  roomId,
  type RoomId,
  type Route,
  type TrainerChoice
} from '../../shared/world';
import type { Wanted } from './ItemErrand';
import type { LightFetch } from './LightAhead';
import type { SessionModule } from './Module';

export interface TrainPlanner {
  /** Where the character stands, or null while unplaced. */
  here(): RoomId | null;
  /** The trainers the realm says will take this character at a level (now's by default), cheapest first. */
  trainers(level?: number): TrainerChoice[];
  /**
   * A route to a room, or the reason there is none. A blocked one carries the
   * way through a door whose key the realm says where to get (`Route.unlocks`,
   * with its `needs`), where there is one.
   */
  routeTo(room: RoomId): Route | string;
  /** Hands the route to the walker as a leg. Returns its refusal, or null. */
  walk(route: Route): string | null;
  /** Gets each item (`ItemErrand.collect`), then walks `then`. Returns its refusal, or null. */
  fetch(items: ReadonlyArray<Wanted>, then: Route): string | null;
  /** The light `route`'s dark rooms want bought first (`LightAhead.wanted`), or null. */
  lightFor(route: Route): LightFetch | null;
  /** What became of fetching that light, said (`LightAhead.settle`). */
  lightSettled(light: LightFetch, refused: string | null): void;
  /** Whether that fetch is still under way. */
  fetching(): boolean;
  /**
   * What this room puts out for this character's class that the pack does not
   * hold (`trainerPrize`), or null.
   */
  prize(room: RoomId): { name: string } | null;
  /** A move outstanding, a walk running, an escape in flight: not now. */
  moveInFlight(): boolean;
  walking(): boolean;
  busy(): boolean;
  /** Whether a lap is running, which is what there is to hold. */
  looping(): boolean;
  /** Holds the lap for the errand, and gives it back. */
  hold(): void;
  release(): void;
}

export interface TrainEvents {
  notice?(message: string): void;
  /** The trace: what was done, and what was refused and why. */
  decided?(decision: SafetyDecision): void;
}

/**
 * How to reach a trainer: standing in its room, a route, a route through a
 * door whose key is fetched on the way (`needs`), or the reason there is none.
 */
type Way =
  | { kind: 'here' }
  | { kind: 'route'; route: Route }
  | { kind: 'keyed'; route: Route; needs: ReadonlyArray<{ id: number; name: string }> }
  | { kind: 'none'; why: string };

/** A trainer some way reaches, with the walk there (none where the character stands in it). */
interface Reached {
  trainer: TrainerChoice;
  way: Way;
  route: Pick<Route, 'cost' | 'steps'>;
}

/** The trainer a level would be taken to, as the trip would choose it, and whether a route reaches it. */
export interface TrainerAhead {
  level: number;
  trainer: TrainerChoice;
  /** Null while no route has been planned to its rooms yet (`aheadPlans`): not known. */
  reachable: boolean | null;
}

type Phase =
  | { kind: 'idle' }
  /**
   * `fetching`: the keys the item errand is getting, which has the character
   * until they are in the pack and the walk on has begun; null on a plain walk.
   */
  | {
      kind: 'walking';
      to: RoomId;
      trainer: TrainerChoice;
      fetching: ReadonlyArray<Wanted> | null;
    }
  /** `sentAt` null while the `train` waits in the queue: the screen's hold can still drop it. */
  | { kind: 'training'; trainer: TrainerChoice; queuedAt: number; sentAt: number | null };

const ACTION = 'train level';

export class TrainErrand implements SessionModule {
  private phase: Phase = { kind: 'idle' };
  /**
   * The level the last attempt was made at, so one level is one attempt.
   *
   * Not a clock: a refusal that repeats every status line is the failure this
   * whole module is a fix for, and the level is what actually changes when the
   * errand works. A fresh attempt after a refusal costs the player one level
   * of grinding, which is the right price for not spending commands in a loop.
   */
  private attempted: number | null = null;
  /**
   * The level whose `train` moved nothing, and when it may be tried again
   * (todo 69). Tied to the level so it lifts that mark and no later one: a
   * mark kept after a death, a refused route or a trainer not reached waits
   * for the level to move.
   */
  private retry: { level: number; at: number } | null = null;
  /** The level the *did not move* refusal was last announced at. */
  private unansweredAt: number | null = null;
  /** The level `exp` was last asked at for an unread `expNeeded`, so it is asked once. */
  private askedOwed: number | null = null;
  /** The last refusal said, cleared when a trip sets off. See `refusal`. */
  private said: { why: string; at: number } | null = null;
  /** Whether the *nowhere to go* refusal has been said for this level. */
  private saidNowhere: number | null = null;
  /**
   * The level and room from which no trainer could be reached, and when, so
   * the routes are not planned again on every status line: asked again once
   * the room has changed **and** `tuning.train.reaskMs` has passed (todo 103 —
   * a lap changes room every three seconds).
   */
  private refusedFrom: { level: number; room: RoomId | null; at: number } | null = null;
  /**
   * The routes `trainersAhead` planned, on what (`Errands.reachKey`), and
   * when: kept for `tuning.train.aheadMs` wherever the character walks, while
   * nothing that decides where a route can go has moved, since a plan asks
   * for the prices every few seconds and a trainer nothing reaches costs a
   * search of the whole realm each time. The routes are from where they were
   * planned; only which trainer and whether one is reached are read off them.
   */
  private ahead: {
    key: string;
    at: number;
    ways: Map<RoomId, Way>;
  } | null = null;
  /** The last *none reachable* sentence said, so the same outcome is said once. */
  private saidUnreachable: string | null = null;
  /**
   * A level was just collected and the experience figure has not been said
   * again since (todo 107). `user-levels` leaves `expNeeded` as it was — a
   * stale 0 — and the staleness table asks `exp`; until that answer lands,
   * a second `train` would be sent on a figure a level old, and refused with
   * a sentence the client does not read. Bounded by `tuning.train.confirmMs`
   * so a realm that never answers cannot hold the errand for ever.
   */
  private expStaleSince: number | null = null;
  /**
   * The level and fee a poverty refusal was made at (todo 112). The purse is
   * the fact the refusal stands on, so the purse reaching the fee asks again;
   * it used to spend the level's one attempt, and a player who withdrew the
   * fee and came back was told nothing.
   */
  private poor: { level: number; cost: number } | null = null;

  constructor(
    private config: TrainConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly planner: TrainPlanner,
    private readonly events: TrainEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(config: TrainConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
    // `ahead` stays: the doors a walk may force and the places it keeps out of are in its key.
  }

  reset(): void {
    this.phase = { kind: 'idle' };
    this.attempted = null;
    this.retry = null;
    this.unansweredAt = null;
    this.askedOwed = null;
    this.said = null;
    this.saidNowhere = null;
    this.ahead = null;
  }

  /**
   * Whether the errand has the character: walking to a trainer, or waiting for
   * the level to move.
   *
   * Read by anything that would otherwise start a journey of its own in the
   * gap between arriving and the server answering — `AutoHunt`, whose own
   * `busy()` says *an escape in flight, an armed retreat, an errand*.
   */
  get busy(): boolean {
    return this.phase.kind !== 'idle';
  }

  /** What the errand last said it would not do, and when, until it next sets off. */
  get refusal(): { why: string; at: number } | null {
    return this.said;
  }

  /** Which trainer the errand is walking to or training with, for an extension's card. */
  get heading(): { trainer: string; room: string; copper: number; training: boolean } | null {
    if (this.phase.kind === 'idle') return null;
    const { trainer } = this.phase;
    return {
      trainer: trainer.name,
      room: trainer.roomName,
      copper: trainer.cost,
      training: this.phase.kind === 'training'
    };
  }

  /**
   * A death: the trainer is several maps away now.
   *
   * The fifth holder of a destination, beside the retreat, the lap, the supply
   * errand and the journey `stopGoingAnywhere` already drops. Same argument:
   * the room this was walking to is nowhere near the temple, and a death is
   * the player's cue to decide what happens next, not the client's.
   *
   * The level is *kept* as attempted, deliberately. It is still owed, and the
   * character will be back at the same level with the same experience; asking
   * again the moment it stands up in the temple would be the errand walking a
   * freshly dead character across the realm.
   */
  abandon(): void {
    if (this.phase.kind === 'idle') return;
    this.phase = { kind: 'idle' };
    this.planner.release();
    this.events.notice?.(t('automation.train.abandonedDied'));
  }

  /** Every state change: is a level waiting, and is this the moment to go? */
  onCharacter(state: CharacterState): void {
    if (!this.enabled || !this.config.levels) return;
    if (state.phase !== 'in-game') return;
    if (this.phase.kind === 'training') {
      this.settle(state);
      return;
    }
    if (this.phase.kind === 'walking' && this.phase.fetching !== null) {
      this.watchFetch(this.phase, this.phase.fetching, state);
      return;
    }
    if (this.phase.kind !== 'idle') return;

    const level = state.progress.level;
    const owed = state.progress.expNeeded;
    /*
     * **Both figures, and both stated.** `expNeeded` is the whole trigger and
     * it is null until an `exp` or a sheet has been read — and `null <= 0` is
     * false in JavaScript only because the comparison is written this way
     * round, which is exactly the mistake this client keeps a rule about.
     * Unknown is never the answer that sends a character across the realm, so
     * an unread figure is asked for, once a level: `st` states the experience
     * and not what is needed, and a character logged in with a level waiting
     * otherwise waits for ever.
     */
    if (level !== null && owed === null) {
      this.askOwed(level);
      return;
    }
    if (level === null || owed === null || owed > 0) return;
    if (this.expStaleSince !== null) {
      if (this.now() - this.expStaleSince < tuning().train.confirmMs) return;
      this.expStaleSince = null;
    }
    if (level === this.attempted) {
      if (this.retry === null || this.retry.level !== level || this.now() < this.retry.at) return;
      this.attempted = null;
      this.retry = null;
    }
    if (this.poor !== null && this.poor.level === level) {
      const purse = state.inventory.wealth;
      if (purse !== null && purse < this.poor.cost) return;
      this.poor = null;
    }
    // Never over a fight, a move, a walk or an escape — the errand yields to
    // everything, which is `Supplies`' rule and the reason a lap may hold it.
    if (state.inCombat || state.combat.attackers.length > 0) return;
    if (this.planner.moveInFlight() || this.planner.walking() || this.planner.busy()) return;

    const taking = this.planner.trainers();
    if (this.config.trainer > 0) {
      const chosen = taking.find((entry) => entry.shop === this.config.trainer) ?? null;
      if (chosen === null) {
        /*
         * The reviewer's own rule: the room the player *chose* no longer takes
         * this character, and picking another would send the character
         * somewhere it was never told about. Said once per level, not once
         * per status line.
         */
        if (this.saidNowhere !== level) {
          this.saidNowhere = level;
          this.refuse(t('automation.train.refusalTrainerStale', { level }));
        }
        return;
      }
      this.saidNowhere = null;
      this.go(state, level, chosen, this.routeFor(chosen));
      return;
    }
    if (taking.length === 0) {
      if (this.saidNowhere !== level) {
        this.saidNowhere = level;
        this.refuse(t('automation.train.refusalNowhere', { level }));
      }
      return;
    }
    this.saidNowhere = null;

    /*
     * **Reach is the filter; the walk and the price choose** (`bestTrainer`). A
     * trainer no route reaches is not a cheaper trainer; it is not a trainer. The
     * realm on the test server files two Sysop rooms (1/289, 4/1) that take
     * every level at no markup and that nothing a player walks can enter, so
     * the cheapest-first order alone chose them, said *0 steps* for a route
     * with none, and gave the level up (todo 102). Each unreachable row is
     * skipped and named, and the first the route planner can reach is walked.
     *
     * Asked once per room: a route is planned from where the character
     * stands, so the answer from another room may differ — and a status line
     * arrives every few seconds, so without the memory this would plan every
     * trainer's route on each one.
     */
    const here = this.planner.here();
    if (
      this.refusedFrom !== null &&
      this.refusedFrom.level === level &&
      (this.refusedFrom.room === here || this.now() - this.refusedFrom.at < tuning().train.reaskMs)
    )
      return;
    const { reached, skipped } = this.reach(taking);
    const best = bestTrainer(reached, tuning().train.costSlack);
    if (best !== null) {
      if (skipped.length > 0) {
        this.events.notice?.(t('automation.train.skipping', { skipped: skipped.join('; ') }));
      }
      this.go(state, level, best.trainer, best.way);
      return;
    }
    this.refusedFrom = { level, room: here, at: this.now() };
    /*
     * Said once per outcome, not once per room: the sentence names every
     * trainer and why it is out of reach, and a lap that hears it in every
     * room it enters hears a paragraph every three seconds. A trainer becoming
     * reachable is a walk, not a sentence; a changed reason is worth saying.
     */
    const sentence = t('automation.train.refusalUnreachable', {
      level,
      skipped: skipped.join('; ')
    });
    if (this.saidUnreachable === sentence) return;
    this.saidUnreachable = sentence;
    this.refuse(sentence);
  }

  /**
   * Which of these trainers a route reaches, and why each other one is out of
   * reach. Standing in a trainer's room is a walk of nothing, weighed with the
   * rest: a large markup still loses. `ways` holds each room's answer, so a
   * room several levels share is planned once. A trainer `bestTrainer` could
   * no longer choose (`pricedOut`) is neither planned nor named.
   */
  private reach(
    taking: readonly TrainerChoice[],
    ways: Map<RoomId, Way> = new Map()
  ): { reached: Reached[]; skipped: string[] } {
    const reached: Reached[] = [];
    const skipped: string[] = [];
    let safe: Reached | null = null;
    // Cheapest first, so once a reached trainer's walk survives the dearer past the slack are not planned.
    for (const candidate of taking) {
      if (safe !== null && pricedOut(safe, candidate.cost, tuning().train.costSlack)) break;
      const room = roomId(candidate.map, candidate.room);
      const way = ways.get(room) ?? this.routeFor(candidate);
      ways.set(room, way);
      if (way.kind === 'here' || way.kind === 'route' || way.kind === 'keyed') {
        const each: Reached = {
          trainer: candidate,
          way,
          route: way.kind === 'here' ? { cost: 0, steps: [] } : way.route
        };
        reached.push(each);
        if (safe === null && walkSurvived(each)) safe = each;
        continue;
      }
      skipped.push(
        t('automation.train.skippedOne', {
          trainer: candidate.name,
          room: candidate.roomName,
          why: way.why
        })
      );
    }
    return { reached, skipped };
  }

  /**
   * The trainer each of these levels would be taken to, and what it charges,
   * walked to from where the character stands now: the one the player chose,
   * else the one the trip would choose (`bestTrainer`), else the cheapest no
   * route reaches, said as such. Null for a level nothing takes, or the
   * chosen trainer does not. Asks nothing of the server and walks nowhere:
   * a plan reads the price the trip would pay, not the cheapest row the realm
   * lists (2026-10-01: 450 copper planned, 45,445 asked at the Hydra Trainer).
   *
   * At most `tuning.train.aheadPlans` trainer rooms are planned in one call,
   * the first level always: a level past that is `reachable: null`, not yet
   * known, and is planned on a later call.
   */
  trainersAhead(
    levels: readonly number[],
    /** What decides where a route can go (`Errands.reachKey`): a change plans them again. */
    reachKey: string
  ): Array<TrainerAhead | null> {
    const ways = this.waysKept(reachKey);
    let budget = tuning().train.aheadPlans;
    return levels.map((level, index) => {
      const taking = this.planner.trainers(level);
      // The chosen trainer, where it no longer takes the level, is a refusal on the trip too.
      const pool =
        this.config.trainer > 0
          ? taking.filter((entry) => entry.shop === this.config.trainer)
          : taking;
      const unplanned = new Set(
        pool.map((entry) => roomId(entry.map, entry.room)).filter((room) => !ways.has(room))
      );
      // The level in hand is always planned; another only where its rooms fit what is left.
      if (unplanned.size > 0 && index > 0 && unplanned.size > budget) {
        const cheapest = pool[0];
        return cheapest === undefined ? null : { level, trainer: cheapest, reachable: null };
      }
      budget -= unplanned.size;
      const best = bestTrainer(this.reach(pool, ways).reached, tuning().train.costSlack);
      if (best !== null) return { level, trainer: best.trainer, reachable: true };
      const cheapest = pool[0];
      return cheapest === undefined ? null : { level, trainer: cheapest, reachable: false };
    });
  }

  /**
   * The routes `trainersAhead` keeps (`ahead`), started again once stale or
   * when what decides where a route can go moved.
   */
  private waysKept(key: string): Map<RoomId, Way> {
    const at = this.now();
    if (
      this.ahead === null ||
      this.ahead.key !== key ||
      at - this.ahead.at >= tuning().train.aheadMs
    ) {
      this.ahead = { key, at, ways: new Map() };
    }
    return this.ahead.ways;
  }

  /**
   * A route to the trainer's room, `'here'` when already standing in it, or
   * the reason there is none. A blocked route is a reason, not a route: the
   * planner hands one back with no steps and `blocked` set, and reading its
   * step count says *0 steps* about a walk that does not exist.
   */
  private routeFor(trainer: TrainerChoice): Way {
    const to = roomId(trainer.map, trainer.room);
    if (this.planner.here() === to) return { kind: 'here' };
    const route = this.planner.routeTo(to);
    if (typeof route === 'string') return { kind: 'none', why: route };
    if (!route.blocked) return { kind: 'route', route };
    /*
     * A door whose key a monster on the way drops is walked through once the
     * item errand has fetched the key (2026-10-01: the Super Mystic Trainer in 1/2240 is behind a
     * Large Chamber door whose guardian drops the key, and the trip fell back
     * to a trainer at 45,445 copper). The item errand kills the guardian,
     * takes the key and walks on.
     */
    const keyed = route.unlocks;
    if (keyed !== undefined && !keyed.blocked && (keyed.needs ?? []).length > 0) {
      return { kind: 'keyed', route: keyed, needs: keyed.needs ?? [] };
    }
    return { kind: 'none', why: route.reason ?? t('automation.walk.refusalNoRoute') };
  }

  /** The purse, then the walk or the verb. One level is one attempt from here on. */
  private go(state: CharacterState, level: number, chosen: TrainerChoice, way: Way): void {
    this.said = null;
    /*
     * **The purse, before the walk.** The cost is computable from data already
     * loaded and the markups are enormous — 88,450 copper at level 30 at a
     * 6,000% trainer, against 1,450 at one with no markup — so a walk across
     * two maps to be told *You can not afford to train!* is an hour spent for
     * nothing. Refused rather than attempted, and the figures are named
     * because only the player can do anything about it.
     *
     * An unread purse does not refuse: `wealth` is null until a listing has
     * been read, and unknown is not *poor*. The counter is the authority
     * either way, exactly as it is for a shop.
     */
    const purse = state.inventory.wealth;
    if (purse !== null && purse < chosen.cost) {
      // Not the level's attempt: the purse moving asks again (todo 112).
      this.poor = { level, cost: chosen.cost };
      this.refuse(
        t('automation.train.refusalPoor', {
          cost: chosen.cost.toLocaleString(),
          purse: purse.toLocaleString(),
          trainer: chosen.name
        })
      );
      return;
    }

    this.attempted = level;
    if (way.kind === 'here') {
      this.arrive(chosen, state);
      return;
    }
    if (way.kind === 'none') {
      // Only a trainer the player chose reaches here unrouted: it is never
      // silently replaced, so the refusal names it and the route's reason.
      this.refuse(t('automation.train.refusalNoRoute', { room: chosen.roomName, why: way.why }));
      return;
    }
    const { route } = way;
    const to = roomId(chosen.map, chosen.room);
    // A light the trainer's dark rooms want is fetched as a door's key is (todo 11).
    const light = this.planner.lightFor(route);
    if (way.kind === 'keyed' || light !== null) {
      const needs = [...(way.kind === 'keyed' ? way.needs : []), ...(light?.items ?? [])];
      const where = {
        room: chosen.roomName,
        items: needs.map((item) => item.name).join(', '),
        cost: chosen.cost.toLocaleString()
      };
      const refused = this.planner.fetch(needs, route);
      // A refused keyed trip is said as the trip's refusal: nothing walks on.
      if (light !== null && (refused === null || way.kind !== 'keyed')) {
        this.planner.lightSettled(light, refused);
      }
      if (refused === null) {
        this.events.notice?.(
          light !== null
            ? t('automation.train.goingFetching', where)
            : t('automation.train.goingKeyed', where)
        );
        this.phase = { kind: 'walking', to, trainer: chosen, fetching: needs };
        return;
      }
      if (way.kind === 'keyed') {
        this.refuse(t('automation.train.refusalNoRoute', { room: chosen.roomName, why: refused }));
        return;
      }
      // Only a light was wanted: said by `lightSettled`, and walked to without one.
    }
    this.events.notice?.(
      t('automation.train.going', {
        room: chosen.roomName,
        steps: route.steps.length,
        cost: chosen.cost.toLocaleString()
      })
    );
    const refused = this.planner.walk(route);
    if (refused !== null) {
      this.refuse(t('automation.train.refusalNoRoute', { room: chosen.roomName, why: refused }));
      return;
    }
    if (this.planner.looping()) this.planner.hold();
    this.phase = { kind: 'walking', to, trainer: chosen, fetching: null };
  }

  /**
   * The key fetch has ended without the walk to the trainer arriving: the
   * item errand said why, so the trip ends with it, saying which half failed:
   * a key not in the pack, or the walk on after it stopping short.
   */
  private watchFetch(
    phase: Extract<Phase, { kind: 'walking' }>,
    keys: ReadonlyArray<{ name: string }>,
    state: CharacterState
  ): void {
    if (this.planner.fetching() || this.planner.walking()) return;
    if (this.planner.here() === phase.to) return;
    const fetched = keys.every((key) => carriedCount(state, key.name) > 0);
    this.phase = { kind: 'idle' };
    this.planner.release();
    this.refuse(
      t('automation.train.refusalNotReached', {
        room: phase.trainer.roomName,
        why: fetched ? t('automation.train.whyStopped') : t('automation.train.whyFetch')
      })
    );
  }

  /** Asks `exp` once per level, for the figure the trip is decided on. */
  private askOwed(level: number): void {
    if (this.askedOwed === level) return;
    // A refused enqueue is *not now*: marked only once the queue takes it.
    const taken = this.queue.enqueue({
      ...REFRESH.experience,
      priority: 'probe',
      reason: t('automation.train.reasonAskOwed')
    });
    if (taken) this.askedOwed = level;
  }

  /** The experience figure said again: the next banked level may be asked about. */
  onBlock(block: Block): void {
    if (block.type === 'user-experience') this.expStaleSince = null;
  }

  /** The walker's report: the errand's own leg ended, or somebody else's walk did. */
  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    if (this.phase.kind !== 'walking') return;
    const { to, trainer, fetching } = this.phase;
    // The fetch's own walks (the lap round the guardian's lair) end on the way.
    if (fetching !== null && this.planner.here() !== to) return;
    if (!arrived || this.planner.here() !== to) {
      this.phase = { kind: 'idle' };
      this.planner.release();
      this.refuse(
        t('automation.train.refusalNotReached', {
          room: trainer.roomName,
          why: reason ?? t('automation.train.whyStopped')
        })
      );
      return;
    }
    this.arrive(trainer, state);
  }

  /**
   * In the trainer's room: the reward it puts out for this class first, where
   * the floor shows it, then the `train`. Every class's Super trainer tomb
   * places one, and the user asked for it to be collected on the trip
   * (2026-10-01).
   */
  private arrive(trainer: TrainerChoice, state: CharacterState): void {
    const here = this.planner.here();
    const prize = here === null ? null : this.planner.prize(here);
    if (prize !== null) {
      if (state.room.items.some((item) => nameAnswersTo(item.name, prize.name))) {
        this.events.notice?.(t('automation.train.takingPrize', { item: prize.name }));
        this.queue.enqueue({
          command: `get ${prize.name}`,
          priority: 'probe',
          coalesceKey: 'train:prize',
          reason: t('automation.train.reasonPrize', { item: prize.name })
        });
      } else {
        this.events.notice?.(t('automation.train.prizeGone', { item: prize.name }));
      }
    }
    this.send(trainer);
  }

  private send(trainer: TrainerChoice): void {
    const phase: Phase = { kind: 'training', trainer, queuedAt: this.now(), sentAt: null };
    this.phase = phase;
    // `joined` is the one still waiting from before: its `onSent` is now this one, for this phase.
    const offered = this.queue.offer({
      command: 'train',
      priority: 'probe',
      coalesceKey: 'train:level',
      reason: t('automation.train.reasonLevel'),
      // The clock starts when it goes: queued behind the stat screen it can be dropped (todo 69).
      onSent: () => {
        if (this.phase === phase) phase.sentAt = this.now();
      }
    });
    /*
     * *Not now* is not *never* (todo 113): the arbiter refuses while the stat
     * screen has the keyboard, and the attempt was marked before the queue
     * agreed to carry it — so the errand waited out `confirmMs`, reported
     * *the level did not move*, and never asked again at this level. The
     * mark goes back and the next status line after the hold lifts asks.
     */
    if (offered !== 'queued' && offered !== 'joined') {
      this.phase = { kind: 'idle' };
      this.attempted = null;
      this.planner.release();
    }
  }

  /**
   * Waiting on the level, with a deadline.
   *
   * **The level moving is the confirmation**, not the sentence: the server
   * answers a paid `train` with `Welcome to level N!` and a refused one with a
   * band or a price, and the figure the client already tracks says which
   * happened without reading any of them. A declared postcondition, as
   * `Walker` arms `expecting` and `Recovery` arms `askedUntil`.
   */
  private settle(state: CharacterState): void {
    if (this.phase.kind !== 'training') return;
    const { trainer, queuedAt, sentAt } = this.phase;
    const level = state.progress.level;
    if (level !== null && this.attempted !== null && level > this.attempted) {
      this.phase = { kind: 'idle' };
      /*
       * **The level moved, so the attempt is spent, not the next level**
       * (todo 107). This used to write the *new* level here, and the guard
       * above then refused every status line at that level until the
       * character gained another — which it could not, since collecting
       * levels is what it was refusing to do. A character with two banked
       * levels collected one and stood under the other for ever.
       */
      this.attempted = null;
      this.expStaleSince = this.now();
      this.planner.release();
      this.events.notice?.(t('automation.train.levelled', { level }));
      this.events.decided?.({
        at: this.now(),
        action: ACTION,
        because: t('automation.train.becauseOwed'),
        acted: true
      });
      return;
    }
    if (sentAt === null) {
      /*
       * A train the stat screen's hold dropped never went (todo 69): after a
       * level the screen opens and its hold drops what is queued, the next
       * level's train with it. The attempt goes back, and the next status line
       * asks again. One still waiting behind a half-typed line is offered again
       * and joins it.
       */
      if (this.now() - queuedAt < tuning().train.confirmMs) return;
      this.phase = { kind: 'idle' };
      this.attempted = null;
      this.planner.release();
      return;
    }
    if (this.now() - sentAt < tuning().train.confirmMs) return;
    this.phase = { kind: 'idle' };
    if (this.attempted !== null) {
      this.retry = { level: this.attempted, at: this.now() + tuning().train.retryMs };
    }
    this.planner.release();
    // Said once a level: each retry after `retryMs` is recorded, not announced again.
    const again = this.unansweredAt !== null && this.unansweredAt === this.attempted;
    this.unansweredAt = this.attempted;
    this.refuse(t('automation.train.refusalUnanswered', { trainer: trainer.name }), again);
  }

  private refuse(why: string, quietly = false): void {
    this.said = { why, at: this.now() };
    if (!quietly) this.events.notice?.(why);
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.train.becauseOwed'),
      acted: false,
      refused: why
    });
  }
}
