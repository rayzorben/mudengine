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
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SafetyDecision } from '../../shared/automation';
import type { CharacterState } from '../../shared/character';
import type { HealthConfig, HuntingAutomationConfig, WalkConfig } from '../../shared/config';
import { huntLoop, type HuntingAdvice, type HuntingSpot } from '../../shared/hunting';
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
  moveInFlight(): boolean;
  walking(): boolean;
  /** An escape in flight, an armed retreat, an errand: not now. */
  busy(): boolean;
}

export interface HuntEvents {
  notice?(message: string): void;
  decided?(decision: SafetyDecision): void;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'walking'; to: RoomId; spot: HuntingSpot; loop: Loop }
  | {
      kind: 'hunting';
      key: string;
      name: string;
      /** What the survey said this lair would pay, to measure the gap against. */
      expected: number | null;
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
    };

const ACTION = 'hunt';

export class AutoHunt implements SessionModule {
  private phase: Phase = { kind: 'idle' };
  /** When the survey was last asked for, so a status line is not a sweep. */
  private surveyedAt = 0;
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
  }

  reset(): void {
    this.phase = { kind: 'idle' };
    this.said = null;
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

  /** Whether a hunt this module started is what the character is doing. */
  get hunting(): boolean {
    return this.phase.kind !== 'idle';
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
    this.phase = { kind: 'idle' };
    // Judged for this character as it stands: nothing about it has changed, so
    // nothing here will choose differently until something does.
    this.events.notice?.(
      t('automation.hunt.stoodDown', {
        loopName: was.kind === 'hunting' ? was.name : was.loop.name
      })
    );
  }

  /**
   * The lap stopped for earning too little, and the runner has already named
   * the better lair. *Go there* is this (todo 05's own last bullet).
   */
  noteLapStopped(): void {
    this.phase = { kind: 'idle' };
    this.judgedFor = null;
  }

  /** Every state change: is this the moment to go hunting? */
  onCharacter(state: CharacterState): void {
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
        this.phase = { kind: 'idle' };
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
    if (state.inCombat || state.combat.attackers.length > 0) return;
    if (this.planner.moveInFlight() || this.planner.walking() || this.planner.busy()) return;
    if (this.tooHurt(state)) return;

    if (this.phase.kind === 'hunting') {
      this.keepHonest(state);
      return;
    }
    // A lap that is not this module's: the character is busy, and whose lap it
    // is has already been settled above.
    if (this.planner.runningLoop() !== null) return;

    const judged = this.judgement(state);
    if (judged === this.judgedFor) return;
    if (this.now() - this.surveyedAt < tuning().hunting.resurveyMs) return;
    this.surveyedAt = this.now();
    this.judgedFor = judged;
    this.go(state);
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
    if (measured !== null && expected !== null && expected > 0) {
      this.correction.set(this.phase.key, clampCorrection(measured / expected));
    }

    const best = this.bestOther(this.phase.key);
    if (best === null) return;
    const worth = this.priced(best);
    if (worth === null) return;
    /*
     * **What is being walked is judged on what it paid, never on what it was
     * predicted to pay.** The model is what the alternatives have; reality is
     * what this one has, and where the two disagree the measurement wins.
     * Before a rate can be measured the estimate stands in, priced as a
     * candidate would be — which is where a contested lair is halved.
     */
    const here = measured ?? this.pricedRate(this.phase.key, expected);
    if (here !== null && worth <= here * (1 + tuning().hunting.moveMargin)) return;

    this.events.notice?.(
      t('automation.hunt.movingOn', {
        loopName: this.phase.name,
        here: here === null ? '?' : Math.round(here).toLocaleString(),
        rate: Math.round(worth).toLocaleString(),
        mob: best.mobs[0]?.name ?? ''
      })
    );
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.hunt.becauseBetter', {
        here: here === null ? '?' : Math.round(here).toLocaleString(),
        rate: Math.round(worth).toLocaleString()
      }),
      acted: true
    });
    /*
     * **The lap is stopped before anything walks.** One movement at a time at
     * every door: `Walker.start` supersedes a leg silently and raises no
     * `ended`, so a lap left running would wait for a leg that never comes and
     * then read this journey's arrival as its own. The reason is said in the
     * runner's own words, as every other stop is.
     */
    this.phase = { kind: 'idle' };
    this.planner.stopLoop(t('automation.hunt.stoppedForBetter', { mob: best.mobs[0]?.name ?? '' }));
    // The spot the comparison was made on, not a second sweep of the realm.
    this.go(state, best);
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
    const mine = new Set(state.party.members.map((member) => member.name.toLowerCase()));
    const own = state.name?.toLowerCase() ?? '';
    const stranger =
      state.room.occupants.find(
        (occupant) =>
          occupant.kind === 'player' &&
          occupant.name.toLowerCase() !== own &&
          !mine.has(occupant.name.toLowerCase())
      )?.name ??
      Object.values(state.combat.claimed).find((claim) => !mine.has(claim.by.toLowerCase()))?.by ??
      null;
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
  private measure(state: CharacterState): number | null {
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
    return ((exp - from.exp) * 3_600_000) / elapsed;
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
    return this.pricedRate(spot.key, spot.estimate.expPerHour);
  }

  private pricedRate(key: string, rate: number | null): number | null {
    if (rate === null) return null;
    const corrected = rate * (this.correction.get(key) ?? 1);
    // A sighting has a shelf life: people leave, and a lair priced at half for
    // ever on the strength of a passer-by is one this client never goes back
    // to. See `tuning.hunting.contestedForgetMs`.
    const seen = this.contested.get(key);
    const shared = seen !== undefined && this.now() - seen < tuning().hunting.contestedForgetMs;
    return shared ? corrected * tuning().hunting.contestedShare : corrected;
  }

  /** The best lair that is not the one being walked, priced. */
  private bestOther(not: string): HuntingSpot | null {
    const advice = this.planner.survey(this.config.radius > 0 ? this.config.radius : null);
    if (advice.refusal !== null) return null;
    return this.pick(advice.spots.filter((spot) => spot.key !== not));
  }

  /** The highest priced lair over the floor, or undefined. */
  private pick(spots: readonly HuntingSpot[]): HuntingSpot | null {
    const floor = this.walkConfig.minExpPerHour;
    let best: HuntingSpot | null = null;
    let value = -1;
    for (const spot of spots) {
      const worth = this.priced(spot);
      if (worth === null || (floor > 0 && worth < floor)) continue;
      if (worth > value) {
        best = spot;
        value = worth;
      }
    }
    return best;
  }

  /** The best spot with a rate worth walking to, or null with the reason said. */
  private best(state: CharacterState): HuntingSpot | null {
    const advice = this.planner.survey(this.config.radius > 0 ? this.config.radius : null);
    if (advice.refusal !== null) {
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
    if (best === undefined) {
      this.refuse(
        advice.spots.length === 0
          ? t('automation.hunt.refusalNothingReachable')
          : t('automation.hunt.refusalNoRate', { floor: Math.round(floor).toLocaleString() })
      );
      return null;
    }
    this.said = null;
    return best;
  }

  /**
   * Survey, choose, and set off — or set off for a spot already chosen.
   *
   * `chosen` is what the move-on comparison settled on: surveying again in the
   * same tick would price the whole realm twice to reach the answer already in
   * hand.
   */
  private go(state: CharacterState, chosen: HuntingSpot | null = null): void {
    const best = chosen ?? this.best(state);
    if (best === null) return;
    const loop = huntLoop(best, t);
    const first = best.walk[0];
    if (first === undefined) {
      this.refuse(t('automation.hunt.refusalNoRooms'));
      return;
    }
    if (this.planner.here() === first.id) {
      this.start(best, loop, state);
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
    this.phase = { kind: 'walking', to: first.id, spot: best, loop };
    // Said once the walk is actually going: a refusal used to arrive under
    // *Walking 40 steps to …*, which is the client narrating what it did not do.
    const far = route.steps.length > tuning().walk.resumeAskSteps;
    this.events.notice?.(
      far
        ? t('automation.hunt.goingFar', {
            room: first.name,
            steps: route.steps.length,
            rate: rateOf(best)
          })
        : t('automation.hunt.going', {
            room: first.name,
            steps: route.steps.length,
            rate: rateOf(best)
          })
    );
  }

  /** The walker's report: this module's own journey ended, or somebody else's. */
  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    if (this.phase.kind !== 'walking') return;
    const { to, spot, loop } = this.phase;
    this.phase = { kind: 'idle' };
    if (!arrived || this.planner.here() !== to) {
      this.refuse(
        t('automation.hunt.refusalNotReached', {
          room: spot.walk[0]?.name ?? '',
          why: reason ?? t('automation.hunt.whyStopped')
        })
      );
      return;
    }
    this.start(spot, loop, state);
  }

  private start(spot: HuntingSpot, loop: Loop, state: CharacterState): void {
    const refused = this.planner.runLoop(loop);
    if (refused !== null) {
      this.refuse(t('automation.hunt.refusalLoop', { loopName: loop.name, why: refused }));
      return;
    }
    this.phase = {
      kind: 'hunting',
      key: spot.key,
      name: loop.name,
      // What the survey said, so the gap can be measured against it (todo 06).
      expected: spot.estimate.expPerHour,
      from: anchor(state, this.now()),
      saidCompany: false
    };
    this.events.notice?.(t('automation.hunt.started', { loopName: loop.name, rate: rateOf(spot) }));
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.hunt.becauseRate', { rate: rateOf(spot) }),
      acted: true
    });
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
function rateOf(spot: HuntingSpot): string {
  const rate = spot.estimate.expPerHour;
  return rate === null ? '?' : Math.round(rate).toLocaleString();
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
