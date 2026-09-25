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
import { roomId, type RoomId, type Route, type TrainerChoice } from '../../shared/world';
import type { SessionModule } from './Module';

export interface TrainPlanner {
  /** Where the character stands, or null while unplaced. */
  here(): RoomId | null;
  /** The trainers the realm says will take this character, cheapest first. */
  trainers(): TrainerChoice[];
  /** A route to a room, or the reason there is none. */
  routeTo(room: RoomId): Route | string;
  /** Hands the route to the walker as a leg. Returns its refusal, or null. */
  walk(route: Route): string | null;
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

/** How to reach a trainer: standing in its room, a route, or the reason there is none. */
type Way = { kind: 'here' } | { kind: 'route'; route: Route } | { kind: 'none'; why: string };

type Phase =
  | { kind: 'idle' }
  | { kind: 'walking'; to: RoomId; trainer: TrainerChoice }
  | { kind: 'training'; trainer: TrainerChoice; sentAt: number };

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
  /** Whether the *nowhere to go* refusal has been said for this level. */
  private saidNowhere: number | null = null;
  /**
   * The level and room from which no trainer could be reached, and when, so
   * the routes are not planned again on every status line: asked again once
   * the room has changed **and** `tuning.train.reaskMs` has passed (todo 103 —
   * a lap changes room every three seconds).
   */
  private refusedFrom: { level: number; room: RoomId | null; at: number } | null = null;
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
  }

  reset(): void {
    this.phase = { kind: 'idle' };
    this.attempted = null;
    this.saidNowhere = null;
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
    if (this.phase.kind !== 'idle') return;

    const level = state.progress.level;
    const owed = state.progress.expNeeded;
    /*
     * **Both figures, and both stated.** `expNeeded` is the whole trigger and
     * it is null until an `exp` or a sheet has been read — and `null <= 0` is
     * false in JavaScript only because the comparison is written this way
     * round, which is exactly the mistake this client keeps a rule about.
     * Unknown is never the answer that sends a character across the realm.
     */
    if (level === null || owed === null || owed > 0) return;
    if (this.expStaleSince !== null) {
      if (this.now() - this.expStaleSince < tuning().train.confirmMs) return;
      this.expStaleSince = null;
    }
    if (level === this.attempted) return;
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
     * **Cheapest first, and reach is the filter, not the tiebreak.** A trainer
     * no route reaches is not a cheaper trainer; it is not a trainer. The
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
    const skipped: string[] = [];
    for (const candidate of taking) {
      const way = this.routeFor(candidate);
      if (way.kind !== 'none') {
        if (skipped.length > 0) {
          this.events.notice?.(t('automation.train.skipping', { skipped: skipped.join('; ') }));
        }
        this.go(state, level, candidate, way);
        return;
      }
      skipped.push(
        t('automation.train.skippedOne', {
          trainer: candidate.name,
          room: candidate.roomName,
          why: way.why
        })
      );
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
    if (route.blocked) {
      return { kind: 'none', why: route.reason ?? t('automation.walk.refusalNoRoute') };
    }
    return { kind: 'route', route };
  }

  /** The purse, then the walk or the verb. One level is one attempt from here on. */
  private go(state: CharacterState, level: number, chosen: TrainerChoice, way: Way): void {
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
      this.send(chosen);
      return;
    }
    if (way.kind === 'none') {
      // Only a trainer the player chose reaches here unrouted: it is never
      // silently replaced, so the refusal names it and the route's reason.
      this.refuse(t('automation.train.refusalNoRoute', { room: chosen.roomName, why: way.why }));
      return;
    }
    const { route } = way;
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
    this.phase = { kind: 'walking', to: roomId(chosen.map, chosen.room), trainer: chosen };
  }

  /** The experience figure said again: the next banked level may be asked about. */
  onBlock(block: Block): void {
    if (block.type === 'user-experience') this.expStaleSince = null;
  }

  /** The walker's report: the errand's own leg ended, or somebody else's walk did. */
  onWalkEnded(arrived: boolean, reason: string | null, _state: CharacterState): void {
    if (this.phase.kind !== 'walking') return;
    const { to, trainer } = this.phase;
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
    this.send(trainer);
  }

  private send(trainer: TrainerChoice): void {
    this.phase = { kind: 'training', trainer, sentAt: this.now() };
    const accepted = this.queue.enqueue({
      command: 'train',
      priority: 'probe',
      coalesceKey: 'train:level',
      reason: t('automation.train.reasonLevel')
    });
    /*
     * *Not now* is not *never* (todo 113): the arbiter refuses while the stat
     * screen has the keyboard, and the attempt was marked before the queue
     * agreed to carry it — so the errand waited out `confirmMs`, reported
     * *the level did not move*, and never asked again at this level. The
     * mark goes back and the next status line after the hold lifts asks.
     */
    if (!accepted) {
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
    const { trainer, sentAt } = this.phase;
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
    if (this.now() - sentAt < tuning().train.confirmMs) return;
    this.phase = { kind: 'idle' };
    this.planner.release();
    this.refuse(t('automation.train.refusalUnanswered', { trainer: trainer.name }));
  }

  private refuse(why: string): void {
    this.events.notice?.(why);
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.train.becauseOwed'),
      acted: false,
      refused: why
    });
  }
}
