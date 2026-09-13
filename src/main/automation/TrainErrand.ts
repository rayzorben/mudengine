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
import type { CharacterState } from '../../shared/character';
import type { TrainConfig } from '../../shared/config';
import { roomId, type RoomId, type Route, type TrainerChoice } from '../../shared/world';

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

type Phase =
  | { kind: 'idle' }
  | { kind: 'walking'; to: RoomId; trainer: TrainerChoice }
  | { kind: 'training'; trainer: TrainerChoice; sentAt: number };

const ACTION = 'train level';

export class TrainErrand {
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
    if (level === this.attempted) return;
    // Never over a fight, a move, a walk or an escape — the errand yields to
    // everything, which is `Supplies`' rule and the reason a lap may hold it.
    if (state.inCombat || state.combat.attackers.length > 0) return;
    if (this.planner.moveInFlight() || this.planner.walking() || this.planner.busy()) return;

    const taking = this.planner.trainers();
    const chosen = this.chosen(taking);
    if (chosen === null) {
      /*
       * Said once per level, not once per status line. Two ways to get here
       * and the sentence names which: the realm offers nothing at all for
       * this character, or the room the player *chose* no longer takes it —
       * which is the reviewer's own rule, and the reason the choice is never
       * silently replaced with another room.
       */
      if (this.saidNowhere !== level) {
        this.saidNowhere = level;
        this.refuse(
          this.config.trainer > 0 && taking.length > 0
            ? t('automation.train.refusalTrainerStale', { level })
            : t('automation.train.refusalNowhere', { level })
        );
      }
      return;
    }
    this.saidNowhere = null;

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
      this.attempted = level;
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
    const to = roomId(chosen.map, chosen.room);
    if (this.planner.here() === to) {
      this.send(chosen);
      return;
    }
    const route = this.planner.routeTo(to);
    if (typeof route === 'string') {
      this.refuse(t('automation.train.refusalNoRoute', { room: chosen.roomName, why: route }));
      return;
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
    this.phase = { kind: 'walking', to, trainer: chosen };
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

  /**
   * The trainer the player chose, or the cheapest that will take this
   * character.
   *
   * **A stated row that no longer takes this character is not replaced.** The
   * list is already only the eligible ones, so a chosen row missing from it is
   * a room that has stopped serving — every class room does at level 10, every
   * band at its ceiling — and picking another would send the character
   * somewhere it was never told about. The refusal names it and the player
   * changes the setting, which is the reviewer's rule.
   */
  private chosen(taking: readonly TrainerChoice[]): TrainerChoice | null {
    if (this.config.trainer > 0) {
      return taking.find((entry) => entry.shop === this.config.trainer) ?? null;
    }
    return taking[0] ?? null;
  }

  private send(trainer: TrainerChoice): void {
    this.phase = { kind: 'training', trainer, sentAt: this.now() };
    this.queue.enqueue({
      command: 'train',
      priority: 'probe',
      coalesceKey: 'train:level',
      reason: t('automation.train.reasonLevel')
    });
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
      this.attempted = level;
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
