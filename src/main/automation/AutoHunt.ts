/**
 * Hunting on its own: pick the best lair the survey knows, walk there, and run
 * it (todo 05, 2026-09-13).
 *
 * The Hunting card already ranks every lair the exits reach, sizes a loop to
 * the realm's own respawn clock and fills it from the lairs beside it. What
 * was missing was the press: an unattended client stood wherever it was left,
 * however good the answer on the card was.
 *
 * It yields to everything, as every errand here does — a fight, a move in
 * flight, a walk, an escape, a lap already running — and **every refusal is
 * said out loud and traced** (`SafetyDecision`, action `hunt`). Off by
 * default.
 *
 * Todo 06 is the other half: a lap that is running is kept honest. What the
 * lair actually pays is measured and compared with what the survey predicted
 * for it and with the best lair elsewhere, past a margin and a grace; a
 * stranger working the lair halves what it is worth on the way in. See
 * `mudengine-automation` § *Hunting is a switch, and the loop it runs is
 * never filed*.
 */
import { companyIn } from '../../shared/company';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SafetyDecision } from '../../shared/automation';
import type { CharacterState } from '../../shared/character';
import type { HealthConfig, HuntingAutomationConfig, WalkConfig } from '../../shared/config';
import {
  cashTier,
  floorFor,
  huntLoop,
  shortOfCash,
  type HuntingAdvice,
  type HuntingRoom,
  type HuntingSpot,
  type HuntOrder,
  type HuntWait,
  type MeasuredRate
} from '../../shared/hunting';
import type { Loop } from '../../shared/loops';
import type { RoomId, Route } from '../../shared/world';
import type { SessionModule } from './Module';

export interface HuntPlanner {
  /** Where the character stands, or null while unplaced. */
  here(): RoomId | null;
  /** The survey, ranked — `SessionManager.huntingGrounds`. */
  survey(radius: number | null): HuntingAdvice;
  /** A route to a room, or the reason there is none. */
  routeTo(room: RoomId): Route | string;
  /**
   * The walk to the spot, as **a route the player can see** rather than a
   * quiet leg: a lair three maps away is a journey, and a journey drawn as
   * nothing at all is a character walking across the realm with the
   * Navigation card saying *stopped*.
   */
  walk(route: Route): string | null;
  /** Runs a loop that is filed nowhere. Returns a refusal, or null. */
  runLoop(loop: Loop): string | null;
  /**
   * The name of the lap running, or null.
   *
   * The **name**, not a boolean, because this module has two different
   * questions and one of them is *is the lap running mine* — a lap the player
   * started from the palette while a hunt ran would otherwise be measured
   * against the hunt's own prediction and the character relocated off it.
   */
  runningLoop(): string | null;
  /** Stops the lap this started, and the leg it is walking. */
  stopLoop(reason: string): void;
  /** The lap running takes this loop's stops, their clocks and lingers, where it walks the same rooms (`LoopRunner.retime`); false otherwise. */
  retimeLoop(loop: Loop): boolean;
  moveInFlight(): boolean;
  walking(): boolean;
  /** An escape in flight, an armed retreat, an errand: not now. */
  busy(): boolean;
  /** What hunting a spot paid, kept for the survey and the next session (todo 70). */
  noteRate(key: string, rate: MeasuredRate): void;
  /** The spot's monsters, fought while it is hunted (`AutoCombat.huntFor`); empty when the hunt ends. */
  fightFor(names: readonly string[]): void;
}

export interface HuntEvents {
  notice?(message: string): void;
  decided?(decision: SafetyDecision): void;
}

/** The hunting phase: a lap running on a lair. */
type Hunting = Extract<Phase, { kind: 'hunting' }>;

/**
 * What a hunt sets off on: the survey's spot with its own loop, or an order
 * an extension planned (`HuntOrder`), which is run as given and never moved
 * off for a better spot, since the plan is the extension's.
 */
interface Target {
  key: string;
  spot: HuntingSpot;
  loop: Loop;
  start: HuntingRoom;
  expected: number | null;
  copper: number | null;
}

/** What the spot to hunt is: a survey key, an order, nowhere, or this module's own choice. */
type Steer = string | HuntOrder | null | undefined;

type Phase =
  | { kind: 'idle' }
  | { kind: 'walking'; to: RoomId; target: Target }
  | {
      kind: 'hunting';
      key: string;
      /** The spot as the survey priced it, for what reads the fight being hunted. */
      spot: HuntingSpot;
      name: string;
      /** What the survey said this lair would pay, to measure the gap against. */
      expected: number | null;
      /** The copper an hour it said, against the cash floor (todo 64). */
      copper: number | null;
      /**
       * Where the measurement runs from: the moment the lap started, or the
       * moment a stranger walked in.
       *
       * Re-anchored on company, deliberately. An hour-old anchor barely moves
       * when somebody arrives ten minutes in, so a rate measured from the
       * start would go on reporting the empty lair long after it stopped
       * being one — and the whole point of the measurement is that it
       * outranks the model.
       */
      from: { at: number; exp: number } | null;
      /** Whether the company sentence has been said for this stay. */
      saidCompany: boolean;
      /** The filler lairs the lap was started with (todo 72). */
      filler: number;
    };

const ACTION = 'hunt';

/** The monsters a spot is hunted for, as the realm names them. */
function monstersOf(spot: HuntingSpot): string[] {
  return spot.mobs.map((mob) => mob.name);
}

export class AutoHunt implements SessionModule {
  /** A lap that was running, not this module's, when the hunt was steered: the steerer's to end. */
  private inherited: string | null = null;
  /** What held the hunt on the last line, or null. See `waiting`. */
  private waitingOn: HuntWait | null = null;
  private phase: Phase = { kind: 'idle' };
  /** When the survey was last asked for, so a status line is not a sweep. */
  private surveyedAt = 0;
  /**
   * The steered spot is not on the list while lairs wait on the simulator:
   * a settings change runs every fight again, so the spot a plan chose under
   * the old settings is missing until its own is run. Surveyed again every
   * `tuning.hunting.simulatingMs` until it is there or the book is done.
   */
  private simulating = false;
  /** The refusal last said, so one situation is said once. */
  private said: string | null = null;
  /**
   * What the estimate was made *for*, so a changed character asks again.
   *
   * The level and the kit are the two things that move every figure in the
   * model — the sheet the verdicts are weighed against, and what the character
   * swings with — so they are what re-opens a settled answer. A lap that
   * stopped for earning too little re-opens it too (`noteLapStopped`), which
   * is what turns `LoopEvents.betterSpot` from a sentence into a move.
   */
  private judgedFor: string | null = null;
  /** See `steer`. */
  private steered: Steer = undefined;
  /**
   * Lairs somebody else was seen working, and when.
   *
   * A price on a *candidate*, never on the lair being walked: experience
   * divides among everybody who hit the kill (`Mob.cs:2270`), so a lair with a
   * stranger in it is worth `tuning.hunting.contestedShare` of its estimate
   * when it is being considered — and once a rate has been measured there, the
   * measurement is the figure and no guess at the sharing is wanted.
   *
   * The moment is kept because the price expires: see `pricedRate` and
   * `tuning.hunting.contestedForgetMs`.
   */
  private readonly contested = new Map<string, number>();
  /**
   * What each lair actually paid against what the survey said it would —
   * `measured / expected`, kept per lair for this session.
   *
   * The calibration the model has never had: the survey predicts a rate from
   * the realm's own rows, the lap measures one, and the gap is the correction
   * for *this* character at *that* lair. Applied to a candidate's estimate
   * when a hunt is choosing, so the second visit is priced on what happened
   * the first time. Bounded, because one unlucky cycle is not a correction.
   */
  private readonly correction = new Map<string, number>();
  /**
   * The level the corrections were measured at. A new level clears them: the
   * survey then carries each spot's own measured ratio itself
   * (`withMeasured`), and a correction kept on top would count it twice.
   */
  private correctedAt: number | null = null;

  constructor(
    private config: HuntingAutomationConfig,
    private walkConfig: WalkConfig,
    private health: HealthConfig,
    private enabled: boolean,
    private readonly planner: HuntPlanner,
    private readonly events: HuntEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(
    config: HuntingAutomationConfig,
    walk: WalkConfig,
    health: HealthConfig,
    enabled: boolean
  ): void {
    /*
     * **Turning the switch on re-opens a settled answer.** Without this the
     * judgement survives the reload and a hunt stood down by a stop stays down
     * however many times the player flips the switch — which is what
     * `noteStopped` tells them to do.
     */
    const wasOn = this.enabled && this.config.enabled;
    this.config = config;
    this.walkConfig = walk;
    this.health = health;
    this.enabled = enabled;
    if (!wasOn && enabled && config.enabled) this.judgedFor = null;
    // Switched off mid-lap: what is left running is the player's, fought by the engage policy alone.
    if (this.phase.kind === 'hunting')
      this.planner.fightFor(enabled && config.enabled ? monstersOf(this.phase.spot) : []);
  }

  reset(): void {
    /*
     * A lap carried over a reconnect is still this module's: `LoopRunner` keeps
     * it running through the loss, and dropping the phase here left it running
     * with nothing keeping it honest. `mine()` settles it on the next line, so a
     * lap a different realm stopped is let go there. The measurement starts over
     * from the first line back, as the lap's own rate does.
     */
    this.phase =
      this.phase.kind === 'hunting'
        ? { ...this.phase, from: null, saidCompany: false }
        : { kind: 'idle' };
    this.said = null;
    this.simulating = false;
    this.judgedFor = null;
    this.surveyedAt = 0;
    this.contested.clear();
    /*
     * The corrections go too. They are about *this character at this lair*,
     * and a reset is a new session — which on this client is also how a
     * different realm arrives, where the keys mean other rooms entirely.
     */
    this.correction.clear();
  }

  /**
   * The spot an extension names (todo 84): only that key, an order it
   * planned itself (`HuntOrder`, run as given), nowhere (null), or this
   * module's own choice (undefined). Every guard below still holds; what
   * changes is which spots are candidates. A lap or a walk this module
   * started for another spot, or for nowhere, is ended, since the plan has
   * moved on; an order for the spot already in hand goes through `reorder`.
   */
  steer(key: Steer): void {
    if (keyOf(key) === keyOf(this.steered)) {
      this.steered = key;
      if (typeof key === 'object' && key !== null) this.reorder(key);
      // The same spot planned again: whatever was refused before is asked again now.
      if (named(key) && this.phase.kind === 'idle') this.rejudge();
      return;
    }
    this.steered = key;
    // A lap running now, and not this module's, is left over from before the steer.
    const running = this.planner.runningLoop();
    this.inherited = named(key) && running !== null && !this.mine() ? running : null;
    this.rejudge();
    if (key === undefined || this.phase.kind === 'idle') return;
    const inHand = this.phase.kind === 'walking' ? this.phase.target.key : this.phase.key;
    if (inHand === keyOf(key)) {
      if (typeof key === 'object' && key !== null) this.reorder(key);
      return;
    }
    // A walk to the spot left behind is stopped too, or its arrival would start that spot's loop.
    if (this.phase.kind === 'walking' || this.mine())
      this.stopOwn(t('automation.hunt.steeredAway'));
    else this.idle();
  }

  /**
   * The same spot ordered again, perhaps with another loop (2026-10-06, run
   * 13: priced again at the realm's speed, the order was a five-room loop on
   * 71-second clocks, and the hunt went on with the one-room loop on
   * 356-second clocks it was first given). A walk to the same start starts the
   * new loop on arrival; a lap on the same rooms takes the new stops in place;
   * a lap or a walk on other rooms, or an order with no stops, is stopped, and
   * the next line sets off on the order as given or says why it cannot.
   */
  private reorder(order: HuntOrder): void {
    const target = orderTarget(order);
    const phase = this.phase;
    switch (phase.kind) {
      case 'idle':
        return;
      case 'walking':
        if (target !== null && phase.target.start.id === target.start.id) {
          this.phase = { ...phase, target };
          return;
        }
        break;
      case 'hunting':
        // A lap that is not this module's is left to whoever started it.
        if (!this.mine()) return;
        if (target !== null && this.planner.retimeLoop(order.loop)) {
          this.phase = {
            ...phase,
            spot: target.spot,
            expected: target.expected,
            copper: target.copper,
            filler: target.spot.filler.length
          };
          this.planner.fightFor(monstersOf(target.spot));
          return;
        }
        break;
      default: {
        const never: never = phase;
        return never;
      }
    }
    this.stopOwn(t('automation.hunt.reordered'));
  }

  /**
   * Goes idle, then stops the lap or walk this module started. Idle first:
   * `Walker.stop` reports `ended` at once, and a hunt still walking would read
   * its own stop as the start not reached.
   */
  private stopOwn(reason: string): void {
    this.idle();
    this.planner.stopLoop(reason);
  }

  private rejudge(): void {
    this.said = null;
    this.simulating = false;
    this.judgedFor = null;
    this.surveyedAt = 0;
  }

  /** What this module last said it would not do, until it next sets off. */
  get refusal(): string | null {
    return this.said;
  }

  /**
   * What is holding the hunt this line, where something is (`HuntWait`). Said on an
   * extension's card, so a hunt that does not set off says why.
   */
  get waiting(): HuntWait | null {
    return named(this.steered) ? this.waitingOn : null;
  }

  private wait(why: HuntWait | null): void {
    this.waitingOn = why;
  }

  /** Whether a hunt this module started is what the character is doing. */
  get hunting(): boolean {
    return this.phase.kind !== 'idle';
  }

  /** The spot this module is walking to or hunting, as the survey priced it; null idle. */
  get quarry(): HuntingSpot | null {
    switch (this.phase.kind) {
      case 'idle':
        return null;
      case 'walking':
        return this.phase.target.spot;
      case 'hunting':
        return this.phase.spot;
      default: {
        const never: never = this.phase;
        return never;
      }
    }
  }

  /** Where the hunt is walking to, or the lap it is hunting on, for an extension's card. */
  get heading(): { walking: boolean; place: string } | null {
    switch (this.phase.kind) {
      case 'idle':
        return null;
      case 'walking':
        return { walking: true, place: this.phase.target.start.name };
      case 'hunting':
        return { walking: false, place: this.phase.name };
      default: {
        const never: never = this.phase;
        return never;
      }
    }
  }

  /**
   * The player stopped the lap.
   *
   * **A stop the player pressed stands the hunt down** until something changes
   * the answer: starting it again on the next status line would make the stop
   * button do nothing, which is the one thing a stop button may not do. The
   * hunt is picked back up by the same three things that re-survey — a level,
   * the kit, or the lap's own low-experience stop — or by the switch being
   * turned off and on again (`configure`). A death is not a stop somebody
   * pressed: `noteLapStopped` is its door.
   */
  noteStopped(): void {
    if (this.phase.kind === 'idle') return;
    const was = this.phase;
    this.idle();
    // Judged for this character as it stands: nothing about it has changed, so
    // nothing here will choose differently until something does.
    this.events.notice?.(
      t('automation.hunt.stoodDown', {
        loopName: was.kind === 'hunting' ? was.name : was.target.loop.name
      })
    );
  }

  /**
   * The lap stopped for earning too little, and the runner has already named
   * the better lair. *Go there* is this (todo 05's own last bullet).
   */
  noteLapStopped(): void {
    this.idle();
    this.judgedFor = null;
  }

  /** Every state change: is this the moment to go hunting? */
  onCharacter(state: CharacterState): void {
    const level = state.progress.level;
    if (level !== null && level !== this.correctedAt) {
      this.correction.clear();
      this.correctedAt = level;
    }
    if (!this.enabled || !this.config.enabled) return;
    if (state.phase !== 'in-game') return;
    if (this.phase.kind === 'walking') return;

    if (this.phase.kind === 'hunting') {
      if (this.mine()) {
        /*
         * Watched whatever else is happening, because a stranger walking into
         * the lair is most visible *during* the fight the guards below stand
         * this module down for. It says something and prices a lair; it moves
         * nobody.
         */
        this.noteCompany(state);
      } else {
        // The lap ended some other way, or the player started one of their
        // own: either way what is running is not this module's to reason about.
        this.idle();
      }
    }

    /*
     * **Every guard, before either decision.** Moving a hunt on is a journey
     * exactly as starting one is — through whatever lives on the way — so the
     * fight, the move in flight, the other walk, the escape and the health
     * floor gate both. They were below the hunting branch's own return, which
     * meant a lair that started paying badly could pull a character out of a
     * running fight at 15% health.
     *
     * Too hurt is `automation.health.restBelow`, the floor a route already
     * stands still at, read here so a journey is never *started* at 12%. Said
     * nothing: `Recovery` is already resting, and the hunt goes as soon as it
     * is up.
     */
    if (state.inCombat || state.combat.attackers.length > 0) return this.wait('fight');
    if (this.planner.moveInFlight() || this.planner.walking()) return this.wait('walking');
    if (this.planner.busy()) return this.wait('busy');
    if (this.tooHurt(state)) return this.wait('hurt');

    if (this.phase.kind === 'hunting') {
      this.waitingOn = null;
      this.keepHonest(state);
      return;
    }
    // A lap that is not this module's: the character is busy. One left running
    // from before the hunt was steered is the steerer's to end; one the
    // player started since is the player's, and the hunt waits for it.
    const running = this.planner.runningLoop();
    if (running !== null) {
      if (named(this.steered) && running === this.inherited) {
        this.inherited = null;
        this.planner.stopLoop(t('automation.hunt.takingOver', { loopName: running }));
      }
      return this.wait('lap');
    }
    // Steered to hunt nowhere for now: it is somewhere else's turn.
    if (this.steered === null) return this.wait(null);
    this.waitingOn = null;
    // An order is run as given: no survey, asked again only for a changed character or a re-steer.
    if (typeof this.steered === 'object') {
      const judged = this.judgement(state);
      if (judged === this.judgedFor) return;
      this.judgedFor = judged;
      const target = orderTarget(this.steered);
      if (target === null) this.refuse(t('automation.hunt.refusalNoRooms'));
      else this.go(state, target);
      return;
    }
    this.waitingOn = this.heldBySimulator();

    const judged = this.judgement(state);
    if (judged === this.judgedFor && !this.simulating) return;
    const floor = this.simulating ? tuning().hunting.simulatingMs : tuning().hunting.resurveyMs;
    if (this.now() - this.surveyedAt < floor) return;
    this.surveyedAt = this.now();
    this.judgedFor = judged;
    this.go(state);
    this.waitingOn = this.heldBySimulator();
  }

  /** `simulating`, as the wait the card says. */
  private heldBySimulator(): HuntWait | null {
    return this.simulating ? 'simulating' : null;
  }

  /** Whether the lap running is the one this module started. */
  private mine(): boolean {
    return this.phase.kind === 'hunting' && this.planner.runningLoop() === this.phase.name;
  }

  /**
   * A lap is running: keep it honest (todo 06).
   *
   * Three things can make the answer wrong after it was right, and each is
   * checked here in the order it can be known:
   *
   * 1. **Somebody else is working the lair.** Experience divides among
   *    everybody who hit the kill, so a stranger halves what the lair pays —
   *    and the fights the client will not open are theirs. Said once, and the
   *    measurement is re-anchored so the rate reported from here is the rate
   *    *with them in it*.
   * 2. **The character changed.** A level or the kit moves every figure in
   *    the model, so a settled answer is re-opened.
   * 3. **What it actually pays.** Measured against what the survey predicted
   *    for this lair and against the best lair elsewhere, past a margin and a
   *    grace — the low-experience stop's shape, because a character that
   *    moved on every estimate would chase them round the realm.
   */
  private keepHonest(state: CharacterState): void {
    if (this.phase.kind !== 'hunting') return;
    this.noteCompany(state);
    const measured = this.measure(state);
    const level = state.progress.level;
    // Kept from a stay long enough to say, so a short visit never replaces an hour's figure.
    // Kept under a survey spot's key only: a lap an order started and handed back is the order's.
    const surveyed = this.phase.key === this.phase.spot.key;
    if (
      surveyed &&
      measured !== null &&
      level !== null &&
      measured.minutes >= tuning().hunting.measuredMinutesLeast
    ) {
      this.planner.noteRate(this.phase.key, {
        perHour: measured.perHour,
        minutes: measured.minutes,
        level,
        at: this.now(),
        estimated: this.phase.spot.estimate.modelPerHour ?? null
      });
    }

    /*
     * An order is the extension's plan and is never moved off here. What it
     * paid is kept above where its key is a survey spot's (a joined loop's key
     * is one the survey cannot read), and nothing else: the correction below
     * is the survey's own estimate against the lap, and an order is priced by
     * the extension. Read from the steer, not the lap, so an order handed back
     * (`steer(undefined)`) is kept honest from the next line.
     */
    if (typeof this.steered === 'object' && this.steered !== null) return;

    const judged = this.judgement(state);
    const changed = judged !== this.judgedFor;
    if (!changed && measured === null) return;
    if (this.now() - this.surveyedAt < tuning().hunting.resurveyMs) return;
    this.surveyedAt = this.now();
    this.judgedFor = judged;

    /*
     * The calibration (todo 06). The survey predicted a rate from the realm's
     * own rows; the lap measured one. The gap is the correction for this
     * character at this lair, kept for the session and applied the next time
     * this lair is priced — bounded, because one unlucky cycle is not a
     * correction.
     */
    const expected = this.phase.expected;
    if (surveyed && measured !== null && expected !== null && expected > 0) {
      this.correction.set(this.phase.key, clampCorrection(measured.perHour / expected));
    }

    const advice = this.planner.survey(this.config.radius > 0 ? this.config.radius : null);
    if (advice.refusal !== null) return;
    const walking = this.phase;
    const here = measured?.perHour ?? this.pricedRate(walking.key, expected);
    if (this.moveOn(state, advice, walking, here)) return;
    this.fill(state, advice, walking);
  }

  /**
   * Off to a better lair, where one pays enough more; true where it went.
   *
   * **What is being walked is judged on what it paid, never on what it was
   * predicted to pay.** The model is what the alternatives have; reality is
   * what this one has, and where the two disagree the measurement wins.
   * Before a rate can be measured the estimate stands in, priced as a
   * candidate would be, which is where a contested lair is halved.
   */
  private moveOn(
    state: CharacterState,
    advice: HuntingAdvice,
    walking: Hunting,
    here: number | null
  ): boolean {
    const best = this.pick(advice.spots.filter((spot) => spot.key !== walking.key));
    if (best === null) return false;
    const worth = this.priced(best);
    if (worth === null) return false;
    // A cash floor outranks exp: never off a lair paying it for one that does not, and off one
    // short of it for one that pays it (todo 64), unless it earns under `cashExpShare` of the exp
    // here (todo 71).
    const cash = this.config.cashPerHour;
    const hereShort = shortOfCash(walking.copper, cash);
    const thereShort = shortOfCash(best.estimate.copperPerHour, cash);
    if (!hereShort && thereShort) return false;
    // Both short: the one paying more copper, as the survey ranks them; the same copper, by exp.
    const copper = (best.estimate.copperPerHour ?? 0) - (walking.copper ?? 0);
    if (hereShort && thereShort && copper < 0) return false;
    const against = floorFor(cash, here ?? 0, tuning().hunting.cashExpShare);
    const affords = cashTier(worth, best.estimate.copperPerHour, against) !== 2;
    const forCash = hereShort && (!thereShort || copper > 0) && affords;
    if (!forCash && here !== null && worth <= here * (1 + tuning().hunting.moveMargin))
      return false;

    const figures = {
      here: here === null ? '?' : Math.round(here).toLocaleString(),
      rate: Math.round(worth).toLocaleString()
    };
    const mob = best.mobs[0]?.name ?? '';
    this.events.notice?.(
      t('automation.hunt.movingOn', { loopName: walking.name, mob, ...figures })
    );
    this.relocate(
      state,
      best,
      t('automation.hunt.becauseBetter', figures),
      t('automation.hunt.stoppedForBetter', { mob })
    );
    return true;
  }

  /**
   * The same lair, planned with lairs nearby to fill a wait the survey did not
   * price when the lap started (todo 72): a lair with no clock in the
   * database is priced on the realm's usual regen until its own is timed, and
   * Slum Street stood a level-5 character still for 70 seconds a kill. Never
   * onto a plan that falls short of a cash floor the lap was paying.
   */
  private fill(state: CharacterState, advice: HuntingAdvice, walking: Hunting): void {
    const same = advice.spots.find((spot) => spot.key === walking.key);
    if (same === undefined || same.filler.length <= walking.filler) return;
    const cash = this.config.cashPerHour;
    if (!shortOfCash(walking.copper, cash) && shortOfCash(same.estimate.copperPerHour, cash))
      return;
    this.events.notice?.(
      same.filler.length === 1
        ? t('automation.hunt.filled.one', { loopName: walking.name })
        : t('automation.hunt.filled.many', { loopName: walking.name, count: same.filler.length })
    );
    this.relocate(
      state,
      same,
      t('automation.hunt.becauseFilled'),
      t('automation.hunt.stoppedForFiller')
    );
  }

  /**
   * Stops the lap and sets off on another plan, traced.
   *
   * **The lap is stopped before anything walks.** One movement at a time at
   * every door: `Walker.start` supersedes a leg silently and raises no
   * `ended`, so a lap left running would wait for a leg that never comes and
   * then read this journey's arrival as its own. It goes idle and stops the lap
   * first (`stopOwn`). The reason is said in the runner's own words.
   */
  private relocate(state: CharacterState, spot: HuntingSpot, because: string, stop: string): void {
    this.events.decided?.({ at: this.now(), action: ACTION, because, acted: true });
    this.stopOwn(stop);
    // The spot the comparison was made on, not a second sweep of the realm.
    const target = spotTarget(spot);
    if (target === null) this.refuse(t('automation.hunt.refusalNoRooms'));
    else this.go(state, target);
  }

  /**
   * A stranger in the lair: price it as shared from now on, and re-anchor.
   *
   * A person the roster does not put in this character's party, standing in
   * the room, or one the server said has claimed a monster here
   * (`combat.claimed`). Never this character, and never a party member — a
   * pair hunting together is the arrangement, not the problem.
   */
  private noteCompany(state: CharacterState): void {
    if (this.phase.kind !== 'hunting') return;
    const stranger = companyIn(state);
    if (stranger === null) return;
    this.contested.set(this.phase.key, this.now());
    if (this.phase.saidCompany) return;
    this.phase = { ...this.phase, saidCompany: true, from: anchor(state, this.now()) };
    this.events.notice?.(
      t('automation.hunt.company', { who: stranger, loopName: this.phase.name })
    );
  }

  /**
   * What this lair has actually paid, an hour, since the measurement's anchor
   * — or null until the grace has passed and the figures are known.
   */
  private measure(state: CharacterState): { perHour: number; minutes: number } | null {
    if (this.phase.kind !== 'hunting') return null;
    const from = this.phase.from;
    const exp = state.progress.exp;
    if (exp === null) return null;
    if (from === null) {
      this.phase = { ...this.phase, from: { at: this.now(), exp } };
      return null;
    }
    const elapsed = this.now() - from.at;
    // The low-experience stop's own grace: the first minutes of any lap are
    // the walk to the first lair.
    if (elapsed < tuning().loop.expRateGraceMs) return null;
    return { perHour: ((exp - from.exp) * 3_600_000) / elapsed, minutes: elapsed / 60_000 };
  }

  /** What the estimate was made for: change either and it is asked again. */
  private judgement(state: CharacterState): string {
    return [state.progress.level ?? '?', wornSignature(state)].join('|');
  }

  private tooHurt(state: CharacterState): boolean {
    const floor = this.health.restBelow;
    if (floor <= 0) return false;
    const { hp, hpMax } = state.vitals;
    // Unknown is never *hurt*: the rule every threshold in this client follows.
    if (hp === null || hpMax === null || hpMax <= 0) return false;
    return hp / hpMax < floor;
  }

  /**
   * What a lair is worth to *this* client now: the survey's estimate, less
   * what the last visit says the model is out by here, less the sharing where
   * somebody else is working it. Null where the survey could not finish it.
   */
  private priced(spot: HuntingSpot): number | null {
    // A spot hunted at this level is priced on what it paid: no correction, and the sharing only
    // where somebody was seen after it was measured, since the measurement holds any before.
    const measured = spot.estimate.measured;
    if (measured) return this.shared(spot.key, measured.perHour, measured.at);
    return this.pricedRate(spot.key, spot.estimate.expPerHour);
  }

  /** A rate at the contested share while somebody else was seen working the lair lately. */
  private shared(key: string, rate: number, after = 0): number {
    const seen = this.contested.get(key);
    const contested =
      seen !== undefined && seen > after && this.now() - seen < tuning().hunting.contestedForgetMs;
    return contested ? rate * tuning().hunting.contestedShare : rate;
  }

  private pricedRate(key: string, rate: number | null): number | null {
    if (rate === null) return null;
    // A sighting has a shelf life: people leave, and a lair priced at half for
    // ever on the strength of a passer-by is one this client never goes back
    // to. See `tuning.hunting.contestedForgetMs`.
    return this.shared(key, rate * (this.correction.get(key) ?? 1));
  }

  /**
   * The highest priced lair over the floor, or undefined. Under a cash floor
   * a lair paying it comes first, then those short of it by copper, as the
   * survey ranks them (todos 64, 71); copper counts only within
   * `cashExpShare` of the best priced rate.
   */
  private pick(spots: readonly HuntingSpot[]): HuntingSpot | null {
    const floor = this.walkConfig.minExpPerHour;
    const priced: Array<{ spot: HuntingSpot; worth: number }> = [];
    for (const spot of spots) {
      if (this.steered !== undefined && spot.key !== this.steered) continue;
      const worth = this.priced(spot);
      /*
       * A spot an extension chose is walked to without a rate: a realm
       * whose lairs state no respawn clock prices every spot at unknown, so a
       * steered hunt could never start there (2026-09-30). A known rate still
       * answers to the floor.
       */
      if (worth === null && typeof this.steered === 'string') return spot;
      if (worth === null || (floor > 0 && worth < floor)) continue;
      priced.push({ spot, worth });
    }
    const most = priced.reduce((top, each) => Math.max(top, each.worth), 0);
    const cash = floorFor(this.config.cashPerHour, most, tuning().hunting.cashExpShare);
    let best: { spot: HuntingSpot; worth: number; tier: number; copper: number } | null = null;
    for (const { spot, worth } of priced) {
      const copper = spot.estimate.copperPerHour ?? 0;
      const tier = cashTier(worth, spot.estimate.copperPerHour, cash);
      const better =
        best === null ||
        tier < best.tier ||
        (tier === best.tier &&
          (tier === 1 && copper !== best.copper ? copper > best.copper : worth > best.worth));
      if (better) best = { spot, worth, tier, copper };
    }
    return best?.spot ?? null;
  }

  /** The best spot with a rate worth walking to, set off on with its loop; or null with the reason said. */
  private best(state: CharacterState): Target | null {
    const advice = this.planner.survey(this.config.radius > 0 ? this.config.radius : null);
    if (advice.refusal !== null) {
      this.simulating = false;
      this.refuse(advice.refusal);
      return null;
    }
    const floor = this.walkConfig.minExpPerHour;
    /*
     * **The best *priced* rate**, which is the survey's own order until a
     * correction or a stranger moves one — an unfinished estimate is never a
     * high one (`compareSpots` already ranks it below every known rate), and a
     * rate under the floor the player set for a lap is not worth a walk.
     */
    const best = this.pick(advice.spots) ?? undefined;
    const steered = this.steered;
    const gone = typeof steered === 'string' && !advice.spots.some((spot) => spot.key === steered);
    this.simulating = gone && advice.excluded.unsimulated > 0;
    if (this.simulating) {
      // Waiting is not a refusal: one said before it no longer stands.
      this.said = null;
      return null;
    }
    if (best === undefined) {
      this.refuse(
        gone
          ? t('automation.hunt.refusalSteeredGone')
          : advice.spots.length === 0
            ? t('automation.hunt.refusalNothingReachable')
            : t('automation.hunt.refusalNoRate', { floor: Math.round(floor).toLocaleString() })
      );
      return null;
    }
    const target = spotTarget(best);
    if (target === null) {
      this.refuse(t('automation.hunt.refusalNoRooms'));
      return null;
    }
    this.said = null;
    return target;
  }

  /**
   * Survey, choose, and set off — or set off for a spot already chosen.
   *
   * `chosen` is what the move-on comparison settled on: surveying again in the
   * same tick would price the whole realm twice to reach the answer already in
   * hand.
   */
  private go(state: CharacterState, chosen: Target | null = null): void {
    const target = chosen ?? this.best(state);
    if (target === null) return;
    const first = target.start;
    if (this.planner.here() === first.id) {
      this.start(target, state);
      return;
    }
    const route = this.planner.routeTo(first.id);
    if (typeof route === 'string' || route.blocked) {
      this.refuse(
        t('automation.hunt.refusalNoRoute', {
          room: first.name,
          why:
            typeof route === 'string'
              ? route
              : (route.reason ?? t('automation.walk.refusalNoRoute'))
        })
      );
      return;
    }
    /*
     * **A journey is said as one.** The Navigation card asks the player past
     * `tuning.walk.resumeAskSteps` before walking a stopped movement back
     * across the realm; automation cannot hold a dialog open, and the switch
     * being on is the consent — so what is owed is the same figure, said,
     * before the character sets off. See `decisions.md`.
     */
    const refused = this.planner.walk(route);
    if (refused !== null) {
      this.refuse(t('automation.hunt.refusalNoRoute', { room: first.name, why: refused }));
      return;
    }
    this.phase = { kind: 'walking', to: first.id, target };
    // Said once the walk is actually going: a refusal used to arrive under
    // *Walking 40 steps to …*, which is the client narrating what it did not do.
    const far = route.steps.length > tuning().walk.resumeAskSteps;
    this.events.notice?.(
      far
        ? t('automation.hunt.goingFar', {
            room: first.name,
            steps: route.steps.length,
            rate: rateOf(target.expected)
          })
        : t('automation.hunt.going', {
            room: first.name,
            steps: route.steps.length,
            rate: rateOf(target.expected)
          })
    );
  }

  /** The walker's report: this module's own journey ended, or somebody else's. */
  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    if (this.phase.kind !== 'walking') return;
    const { to, target } = this.phase;
    this.idle();
    if (!arrived || this.planner.here() !== to) {
      this.refuse(
        t('automation.hunt.refusalNotReached', {
          room: target.start.name,
          why: reason ?? t('automation.hunt.whyStopped')
        })
      );
      return;
    }
    this.start(target, state);
  }

  private start(target: Target, state: CharacterState): void {
    const { spot, loop } = target;
    const refused = this.planner.runLoop(loop);
    if (refused !== null) {
      this.refuse(t('automation.hunt.refusalLoop', { loopName: loop.name, why: refused }));
      return;
    }
    this.planner.fightFor(monstersOf(spot));
    this.phase = {
      kind: 'hunting',
      key: target.key,
      spot,
      name: loop.name,
      // What the survey said, so the gap can be measured against it (todo 06).
      expected: target.expected,
      copper: target.copper,
      from: anchor(state, this.now()),
      saidCompany: false,
      filler: spot.filler.length
    };
    const rate = rateOf(target.expected);
    this.events.notice?.(t('automation.hunt.started', { loopName: loop.name, rate }));
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.hunt.becauseRate', { rate }),
      acted: true
    });
  }

  /** Nothing hunted: the lap's monsters, if one was, go back to the engage policy. */
  private idle(): void {
    if (this.phase.kind === 'hunting') this.planner.fightFor([]);
    this.phase = { kind: 'idle' };
  }

  private refuse(why: string): void {
    if (this.said === why) return;
    this.said = why;
    this.events.notice?.(why);
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.hunt.becauseSwitch'),
      acted: false,
      refused: why
    });
  }
}

/** Where a measurement runs from, when the experience figure is known. */
function anchor(state: CharacterState, at: number): { at: number; exp: number } | null {
  return state.progress.exp === null ? null : { at, exp: state.progress.exp };
}

/**
 * One lap's gap between measured and predicted, bounded.
 *
 * A cycle that went badly is not evidence the model is out by a factor of
 * twenty, and a correction that can reach zero is a lair the client would
 * never go back to on the strength of one unlucky night.
 */
function clampCorrection(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.min(4, Math.max(0.25, ratio));
}

/** The estimate's own figure, as the card prints it. `?` for an unknown one. */
function rateOf(rate: number | null): string {
  return rate === null ? '?' : Math.round(rate).toLocaleString();
}

/** The key a steer names, or null and undefined as they are. */
function keyOf(steer: Steer): string | null | undefined {
  return typeof steer === 'object' && steer !== null ? steer.key : steer;
}

/** Whether a steer names a hunt: a survey key or an order. */
function named(steer: Steer): steer is string | HuntOrder {
  return steer !== null && steer !== undefined;
}

/** The survey's spot, set off on with its own loop; null for a spot with no rooms. */
function spotTarget(spot: HuntingSpot): Target | null {
  const start = spot.walk[0];
  if (start === undefined) return null;
  return {
    key: spot.key,
    spot,
    loop: huntLoop(spot, t),
    start,
    expected: spot.estimate.expPerHour,
    copper: spot.estimate.copperPerHour
  };
}

/** An extension's order, set off on as given; null for a loop with no stops. */
function orderTarget(order: HuntOrder): Target | null {
  if (order.loop.stops.length === 0) return null;
  return {
    key: order.key,
    spot: order.spot,
    loop: order.loop,
    start: order.start,
    expected: order.expPerHour,
    copper: order.copperPerHour
  };
}

/**
 * What the character is wearing and wielding, as one word.
 *
 * The *kit* half of the re-survey trigger: a weapon changed is a different
 * number of rounds per kill, which is a different answer. Built from the
 * loadout rather than the pack, because what is *on* is what swings.
 */
function wornSignature(state: CharacterState): string {
  return Object.entries(state.loadout)
    .map(([slot, item]) => `${slot}:${item ?? ''}`)
    .sort()
    .join(',');
}
