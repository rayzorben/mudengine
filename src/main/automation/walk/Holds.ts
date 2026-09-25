/**
 * The walk's holds: standing still without stopping, and taking the journey
 * up again (todo 740, out of `Walker`).
 *
 * Owns the one-deep `WalkProgress.hold` slot — a fight takes it and hands it
 * back — the fight hold and the exemption for the fight a walk was asked to
 * leave, and the holds for a rest in flight, health, a stated affliction, a
 * trap and a dark room. `Walker` asks them in its order (`holdBeforeSending`,
 * `onCharacter`); `Barriers` takes the slot for a door and a search. The why
 * is `mudengine-automation` › `parts/walking.md`.
 */
import {
  afflictionHolding,
  isAfflictionHold,
  type AfflictionHold,
  type WalkHold
} from '../../../shared/walk';
import { roomAddress, trapOn, type RoomId, type RouteStep } from '../../../shared/world';
import type { Block } from '../../../shared/blocks';
import type { CharacterState } from '../../../shared/character';
import { resumeAtHealth, type AutomationConfig } from '../../../shared/config';
import { splitSpells } from '../../../shared/spell-messages';
import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import type { WalkClock } from './clock';
import type { WalkerEvents, WalkInFlight } from './ports';

/** What the holds ask of the walk they stand still, answered by `Walker`. */
export interface HoldsWalk extends Pick<
  WalkInFlight,
  'walking' | 'quiet' | 'step' | 'publish' | 'stop'
> {
  /** In `ms`, the holds asked again against the state then (or `state`), and the step. */
  retryAfter(ms: number, state: CharacterState): void;
  /** The whole of `Walker.onCharacter` against `state`: a fight's re-ask, a look landing. */
  recheck(state: CharacterState): void;
  /** The held step taken up where it stands: nothing moved during the fight. */
  carryOn(state: CharacterState): void;
  /** The journey planned again from `here`: carried on, arrived, or stopped. */
  onward(state: CharacterState, here: RoomId): void;
  /** Every movement command not yet on the wire, taken back. */
  cancelQueued(): void;
}

export type HoldsEvents = Pick<
  WalkerEvents,
  | 'notice'
  | 'escaping'
  | 'willFight'
  | 'restInFlight'
  | 'floorInFlight'
  | 'lightComing'
  | 'stateNow'
  | 'pendingMoves'
  | 'spellsHold'
  | 'onTheGround'
>;

export class Holds {
  /**
   * Why the walk is standing still without having stopped, or null.
   *
   * Kept as state rather than re-derived because for `health` it is the
   * hysteresis — what counts as "recovered" depends on whether the walk is
   * already waiting, exactly as it does for a lap — and for `fight` it is what
   * says the route still has somewhere to be when the fight ends.
   */
  private hold: WalkHold = null;
  /**
   * When the walk began waiting for a light, or null while it is not.
   *
   * **A moment, not a flag**, for `Walker.askedWhereAt`'s reason: the pack answers
   * *there is a light to ready* before the torch is lit and *there is not* the
   * instant after, and a hold re-derived from that would let go one line
   * before the look it is waiting for comes back. Cleared by the room becoming
   * readable, by the window running out, and by anything that ends or moves
   * the walk.
   */
  private darkSince: number | null = null;
  /**
   * The health the step ahead wants before its trap is walked into, while
   * the walk stands still for it — `holdForTrap`. Null otherwise. Read by
   * `Recovery` through the session, which is what makes the hold end: a
   * trap floor is above `restBelow` by construction, so nothing else would
   * sit the character down to it.
   */
  private trapFloor: number | null = null;
  /** Whether the step stands still for the floor read after a kill, so its close wakes it. */
  private floorHeld = false;
  /**
   * Whether this walk is one the walker itself decides fitness for.
   *
   * False for a retreat (the escape must not wait to be better) and for a
   * loop's leg, which `LoopRunner` holds off the same two thresholds. See
   * `Walker.start`, which has both reasons in full.
   */
  private holdWhenHurt = true;
  /**
   * Whether a fight holds this walk rather than ending it.
   *
   * True for a route the **player** asked for, which is the only walk with
   * nobody else deciding what to do when the fight is over. False for a loop's
   * leg and for a retreat; `Walker.start` has both reasons in full.
   */
  private resumeAfterFight = true;
  /**
   * This walk was asked for mid-fight, and has not left it yet.
   *
   * Set by `Walker.start` and cleared the first moment no fight is running.
   * See the note there: it exempts *that* fight from the hold and nothing else.
   */
  private leavingAFight = false;
  /**
   * When the fight this walk was holding for stopped being a fight, or null.
   *
   * The patience clock for `resumeFromFight`, and separate from the hold
   * itself because a fight lasting five minutes is ordinary while *five
   * minutes of not being able to say where the character is standing* is the
   * client having lost it. Re-armed from null on every fight, so a journey
   * through six of them gets the whole allowance each time.
   */
  private fightClearedAt: number | null = null;
  /**
   * When the fight this walk is holding for started being held, or null.
   *
   * The bound `tuning.walk.fightHoldMs` is measured from. Separate from
   * `fightClearedAt`, which times the *aftermath*: one asks how long the fight
   * has run, the other how long the client has failed to place the character
   * once it ended.
   */
  private fightHeldSince: number | null = null;
  /**
   * When the hold this walk is taking for a *condition* began, or null.
   *
   * `tuning.walk.heldFallbackMs` is measured from it, and unlike the health
   * and fight holds that bound is not about giving up — it is about **asking
   * again**. Every hold ends in the realm's own words and the client reads
   * twenty-two of those sentences, but a realm is free to ship a
   * twenty-third: a wear-off nothing here can read would otherwise stand a
   * route still for the evening. One step is what settles it — the server
   * either moves the character or prints the hold's own sentence again, and
   * the refusal re-arms this with a fresh window. See `holdForAffliction`.
   */
  private heldSince: number | null = null;
  /**
   * A spell onset that landed while this step was outstanding, epoch ms, or
   * null.
   *
   * **The refusal the client could not name.** `ActionFigure
   * .CheckForHoldPerson` answers a held character's move by printing the
   * holding spell's own onset sentence and returning — no room, no refusal
   * this parser knows, nothing. Where the realm's ability row says that spell
   * holds, `CharacterTracker` has already set the flag and this is not needed;
   * where it does not — a spell a newer realm ships, one whose row this
   * conversion lacks — the *sequence* is all that is left to read, and it is
   * enough: a step, an onset, and then silence is a step the server refused.
   *
   * **Silence is the third word of that, and the room is its opposite.** The
   * client's own `c prev` landed its onset seven milliseconds behind a step
   * (2026-09-12), the step's room arrived and was read through
   * `Walker.holdBeforeSending`, and this field — armed by the onset, never cleared
   * by the answer — held the *next* step for the whole of `heldFallbackMs`
   * as *Held fast*. So it is cleared on every send, so it describes this
   * attempt and no earlier one, **and** when the step lands, because a room
   * is the answer the sequence said was not coming. And where the realm has
   * a verdict on the sentence (`WalkerEvents.spellsHold`) it is not armed at
   * all: a `true` is the tracker's flag already, a `false` is a benign buff,
   * and only `null` is the case this exists for.
   */
  private onsetAnsweredStep: number | null = null;
  /**
   * The character ran away and the journey has not been taken up again.
   *
   * Its own flag rather than the health hold, because the two clear on
   * different facts — `LoopRunner.escaped`'s reason, in the other walker
   * caller: an escape at full health is under no threshold at all, so the hold
   * would let go on the very next status line and walk the route straight back
   * into the room it just ran out of.
   */
  private escaped = false;
  private escapedAt = 0;
  /** The walk-through notice has been said on this walk. See `answerFight`. */
  private saidWalkingThrough = false;

  constructor(
    private config: AutomationConfig,
    private readonly events: HoldsEvents,
    private readonly walk: HoldsWalk,
    private readonly clock: Pick<WalkClock, 'afterHold' | 'clear' | 'beating'>
  ) {}

  configure(config: AutomationConfig): void {
    this.config = config;
  }

  /** The slot, as it stands: `Walker` publishes it only while walking. */
  get current(): WalkHold {
    return this.hold;
  }

  /** The hit points the trap hold is resting towards, or null. See `Walker.restingFor`. */
  get restingFor(): number | null {
    return this.hold === 'trap' ? this.trapFloor : null;
  }

  /** Whether this walk is still leaving the fight it was asked for in. */
  get leaving(): boolean {
    return this.leavingAFight;
  }

  /**
   * The slot taken for the two reasons `Barriers` owns — standing at a door,
   * searching for a hidden exit — or let go with `null`. Every other hold is
   * this unit's to take. Not published here; the taker publishes when it has
   * said why.
   */
  take(hold: Extract<WalkHold, 'barrier' | 'searching'> | null): void {
    this.hold = hold;
  }

  /**
   * A new walk. Every hold belongs to the walk that was waiting, and the two
   * options are this one's. `fighting` is whether a fight is running as it
   * starts: `Walker.start` has why that is exempted, and when.
   */
  begin(
    { holdWhenHurt, resumeAfterFight }: { holdWhenHurt: boolean; resumeAfterFight: boolean },
    fighting: boolean
  ): void {
    // A health hold belongs to the walk that was waiting, not to the next one:
    // left set, a fresh route would be measured against the *resume* ceiling
    // before it had held for anything, and would announce recovering from a
    // hold it never took.
    this.hold = null;
    this.fightClearedAt = null;
    this.fightHeldSince = null;
    this.heldSince = null;
    // And the window a dark room was waiting out, for the same reason.
    this.darkSince = null;
    this.onsetAnsweredStep = null;
    this.floorHeld = false;
    // An escape belongs to the walk that ran away. A fresh route is the player
    // asking again, from here, with that already taken into account.
    this.escaped = false;
    this.saidWalkingThrough = false;
    this.holdWhenHurt = holdWhenHurt;
    this.resumeAfterFight = resumeAfterFight;
    this.leavingAFight = fighting && (!this.resumeAfterFight || !this.canEndAFight());
  }

  /** A new connection: forget everything. */
  reset(): void {
    this.hold = null;
    this.trapFloor = null;
    this.fightClearedAt = null;
    this.fightHeldSince = null;
    this.heldSince = null;
    this.darkSince = null;
    this.onsetAnsweredStep = null;
    this.floorHeld = false;
    this.escaped = false;
    this.saidWalkingThrough = false;
    this.holdWhenHurt = true;
    this.resumeAfterFight = true;
    // One more of the same group: `begin` writes it unconditionally, but
    // this is the deterministic-cleanup path for a new session and one start
    // option surviving it is exactly the kind of thing that comes back.
    this.leavingAFight = false;
  }

  /**
   * The character ran away, and the walk (one that resumes after a fight)
   * holds rather than stepping on. `Walker.noteEscaped` has why.
   */
  noteEscaped(): void {
    if (!this.resumeAfterFight) return;
    /*
     * The escape is the move now. A walk-through step still queued behind it,
     * or the next one the exemption would send, is a second move from a room
     * being left, so the exemption goes and the fight hold takes the walk,
     * cancelling what is queued; `answerFight` keeps it while the escape is in
     * flight (2026-09-23, on review).
     */
    this.leavingAFight = false;
    this.holdForFight();
    if (this.escaped) return;
    this.escaped = true;
    this.escapedAt = Date.now();
  }

  /**
   * A spell onset landed while the walk's own step is on the wire with
   * nothing back, which is the only moment `Walker.onBlock` hands one over:
   * see `onsetAnsweredStep`.
   */
  noteOnset(block: Block): void {
    // Only where the realm cannot say what the sentence does: a `false` off
    // the named spells' rows is a blessing landing, not a refusal.
    if (this.events.spellsHold?.(splitSpells(block.groups['spells'])) === false) return;
    this.onsetAnsweredStep = block.at;
  }

  /** The step is on the wire: this attempt's own evidence, never the last one's. */
  sent(): void {
    this.onsetAnsweredStep = null;
    // Nor the floor read's: a step out means nothing stands still for it (todo 765).
    this.floorHeld = false;
  }

  /**
   * The step's room arrived. Returns whether the walk was still leaving the
   * fight it was asked for in, which the landing ends.
   */
  landed(): boolean {
    /*
     * The room is the step's answer, so nothing that arrived between the send
     * and it was answering the step — least of all an onset, which would
     * otherwise hold the *next* step as a refusal of this one (see
     * `onsetAnsweredStep`).
     */
    this.onsetAnsweredStep = null;
    /*
     * And the step is the other half of `leavingAFight`'s bound.
     *
     * Clearing it only when nothing is fighting was not the claim its comment
     * made — *the fight that was running when it was asked for and no other* —
     * because a 100%-follower monster, or a corridor of back-to-back
     * engagements, never lets `fightIsRunning` read false at all, and a
     * *different* fight several steps on would inherit the exemption. A
     * confirmed step is the fact that says the character left the room the
     * fight was in, which is exactly what the exemption was for, so whichever
     * of the two happens first ends it.
     */
    const wasLeaving = this.leavingAFight;
    this.leavingAFight = false;
    return wasLeaving;
  }

  /** A fight is running: its aftermath's patience starts when it stops. */
  fightGoesOn(): void {
    this.fightClearedAt = null;
  }

  /**
   * Nothing is fighting. Anything that starts from here is a fight nobody
   * asked about, and holds for it as usual.
   */
  nothingFighting(): void {
    this.leavingAFight = false;
  }

  /** The hold is let go and the next step starts its own windows. See `Walker.carryOn`. */
  letGo(): void {
    this.hold = null;
    this.fightClearedAt = null;
    this.fightHeldSince = null;
    // The step landed, so whatever was holding it is over and the next one
    // starts its own window — see `heldSince`.
    this.heldSince = null;
    this.darkSince = null;
    this.floorHeld = false;
  }

  /**
   * What a running walk does about a fight around it: hold, or end.
   *
   * One function because it is asked from two places and they must not drift —
   * `Walker.onCharacter`'s own branch, and again the moment a step lands, where the
   * exemption for the fight a walk was asked to leave has just expired. It
   * answers **true when the caller should stop processing**, which is either
   * way: a hold has been taken, or the walk has been stopped.
   */
  answerFight(): boolean {
    /*
     * **A route waits out a fight only while something is fighting it.** On
     * this realm walking out of the room is the only way to break combat
     * (there is no `flee`), so where auto-combat will not fight — switched
     * off, the journey declined, a Run it — carrying on is not abandoning the
     * character in a fight, it is ending it, and the route is kept. Holding
     * there used to be the stock configuration's rule, bounded by
     * `fightHoldMs`, and it was two minutes of standing in the blows and then
     * the route stopped anyway (2026-09-23, Festus among the thugs). Asked
     * whenever the hold is: at the fight's start, and every `holdMs` through
     * `reaskAfter`, so the switch going off mid-fight walks on within a beat.
     */
    // Never past the escape's own move: while it is in flight the walk holds.
    if (this.resumeAfterFight && this.events.escaping?.() === true && this.holdForFight()) {
      return true;
    }
    if (this.resumeAfterFight && !this.canEndAFight()) {
      /*
       * **`leavingAFight`, and it has to be**: returning false alone left
       * `hold` set to `fight`, so the caller took the resume path, cleared it,
       * asked again with the hold gone — which skips this branch — and
       * re-took the hold with its two-minute clock reset. The client said out
       * loud that it was walking on and then waited *longer* than if the
       * branch had not existed. Reported by the reviewer with a transcript;
       * the test could not see it because a held walk's `status` is
       * `walking` too, which is what it asserted.
       *
       * This is the mechanism that already means *walk through this fight and
       * no other*, and its bound is the right one here as well: the exemption
       * expires on a confirmed step, so a monster that follows into the next
       * room is a fight nobody asked about and holds as usual.
       */
      this.leavingAFight = true;
      // `resumeAfterFight` is false for a loop's leg, so this branch is a
      // player's route by construction; `quiet` is still read, because it is
      // the player's own answer for their own walk.
      // Once a walk: a follower swinging in every room of a corridor is one
      // decision, not a line per step.
      if (!this.walk.quiet() && !this.saidWalkingThrough) {
        this.events.notice?.(t('automation.walk.reasonWalkingThroughFight'));
      }
      this.saidWalkingThrough = true;
      return false;
    }
    if (this.holdForFight()) return true;
    this.walk.stop(
      this.resumeAfterFight
        ? t('automation.walk.reasonFightUnending')
        : t('automation.walk.reasonCombat')
    );
    return true;
  }

  /**
   * Whether auto-combat will end a fight around this walk, which is the one
   * reason worth standing still for (see `answerFight`).
   *
   * The session answers live (`WalkerEvents.willFight`): the switches say only
   * what could fight, and a journey the player declined reads on and fights
   * nothing. Without it, the switches: `combat` on, and either `retaliate` or
   * any `engage`, since hitting back ends a fight the character is in. The
   * retreat is not counted: it ends a fight by walking out too, only later and
   * hurt, which is no reason to stand in the blows first.
   */
  private canEndAFight(): boolean {
    if (!this.config.enabled) return false;
    const fights = this.events.willFight?.();
    if (fights !== undefined) return fights;
    const combat = this.config.combat;
    return combat.enabled && (combat.retaliate || combat.engage !== 'none');
  }

  /**
   * Stand still while a fight is running here, and keep the journey.
   *
   * A fight used to **end** a route, and on a realm whose corridors are full
   * of wandering monsters that meant every journey ended at the first one.
   * Measured on the walk this was reported from
   * (`logs/2026-09-02_16-54-23_festus.mudcap.jsonl`): `Walking 21 steps to
   * Bank of Godfrey`, `n`, `n`, a nasty giant rat wandered in, the client
   * killed it in four rounds — and then sent **nothing at all for 140
   * seconds**, until the player typed an Enter by hand. The route was
   * abandoned two steps into twenty-one, in a sewer, for the ordinary reason
   * a sewer exists.
   *
   * So it holds, exactly as it already holds for health, and for the reasons
   * that hold is written up under:
   *
   * - **A hold is not an ending.** The route, the destination and the step
   *   count all survive; `WalkProgress.hold` says why it is standing still and
   *   the Route card draws it as the same chip a looping lap wears when it
   *   stops to fight. A walk that *ended* has to be asked for again by hand,
   *   which is the whole complaint.
   * - **It is not bounded by `walk.maxHolds`.** That bound stops a quarry
   *   nothing will engage pinning a walk for ever. What bounds this is the
   *   fight ending — and a fight ends, one way or the other: the monster dies,
   *   the character runs (`inCombat` drops within a measured median of
   *   3,493ms of arriving in the next room), or the character dies, which
   *   `Walker.onBlock` already stops the walk for. **On a stock configuration none of
   *   those three is this client's to deliver**, which is what
   *   `tuning.walk.fightHoldMs` is the floor under — see below.
   *
   * **Silent, unlike the health hold**, and that is the difference between the
   * two rather than an oversight. A health hold lasts minutes and nothing else
   * on screen explains a stationary character; a fight hold lasts one fight,
   * happens once per wandering monster, and the server has already said
   * `*Combat Engaged*` in the room in its own words. A line per monster on a
   * twenty-one step journey is the chrome talking over the game — which is the
   * complaint the `Walk stopped: a fight started` line was reported under.
   *
   * Returns false when this walk is one that ends on a fight instead; the
   * caller then stops it.
   */
  private holdForFight(): boolean {
    if (!this.resumeAfterFight) return false;
    /*
     * The one bound, and it exists because the three above are not the
     * client's to deliver on a stock configuration: `automation.combat` and
     * `automation.safety.retreat` are both off by default, so nothing here kills
     * the monster and nothing runs. Without this a route planned from the
     * palette on a fresh install would hold in silence while an unattended
     * character was beaten where it stood — which is the failure this hold
     * exists to avoid, wearing the other face. Two minutes only ever expires
     * on a fight this client is not fighting.
     */
    if (
      this.fightHeldSince !== null &&
      Date.now() - this.fightHeldSince >= tuning().walk.fightHoldMs
    ) {
      return false;
    }
    if (this.hold !== 'fight') {
      this.fightHeldSince = Date.now();
      /*
       * The step's own deadlines are the wire's, not the fight's: a step sent
       * into a round that is now being fought is not a step the server failed
       * to answer, and leaving `Walker.waitForPrompt` armed would stop the walk in
       * the middle of the fight it is waiting out. What replaces them is the
       * hold's own re-ask below, and `fightClearedAt`'s patience after it.
       */
      this.clock.clear();
      /*
       * Anything still queued goes with it, for `Walker.stop`'s reason: a movement
       * intent that reaches the wire mid-round walks the character out of a
       * fight it is in. What has already gone cannot be recalled, which is
       * what `resumeFromFight` waits for.
       */
      this.walk.cancelQueued();
      this.hold = 'fight';
      this.walk.publish();
    }
    this.reaskAfter();
    return true;
  }

  /**
   * The fight is over: take the journey up again from where it actually is.
   *
   * **It replans; it never resumes** — `LoopRunner`'s rule, and `Walker`'s own
   * after any failure. The steps ahead were planned from a room the character
   * may have been chased out of, killed something in the doorway of, or run from;
   * sending them from here is sending directions from somewhere it is not.
   * The one case that needs no plan is the common one — nothing moved, and the
   * held step still starts where the character stands.
   *
   * Two things are waited for rather than worked around, and both are the
   * duplicate-move bug in `Walker.start` wearing a different hat:
   *
   * - **A move still in flight.** The room on the books is the one being left,
   *   so a route planned from it would begin with the move already on the
   *   wire, sent a second time — and from then on every answer is read one
   *   command early (measured 2026-08-30; it cost a loop two real corridors
   *   and then its life).
   * - **A room the client cannot place.** Planning from a guess is what
   *   `refusalUnknownStart` refuses at the front door.
   *
   * Both are bounded by `walk.stepTimeoutMs` from the moment the fight
   * cleared, because a route reporting `3/21` that will never move again is
   * the lie stopping exists to avoid. An **ambiguous** room is not waited for
   * at all: more time does not make 293 rooms called Sewer Tunnel into one.
   */
  resumeFromFight(state: CharacterState): void {
    this.fightHeldSince = null;
    if (this.fightClearedAt === null) this.fightClearedAt = Date.now();
    const spent = Date.now() - this.fightClearedAt;
    const patience = this.config.walk.stepTimeoutMs;

    const step = this.walk.step();
    if (!step) {
      // Out of range with the walk still running is a bug rather than a state;
      // the re-ask keeps the hold on a clock instead of leaving it a dead end.
      this.reaskAfter();
      return;
    }

    if ((this.events.pendingMoves?.() ?? 0) > 0) {
      /*
       * Named as what it is. Reading this as *"the client could not place the
       * character"* sends whoever meets it an hour later to look at room
       * resolution, when the client knows exactly where it is and is waiting
       * on a command the server never answered.
       */
      if (spent >= patience) {
        this.walk.stop(t('automation.walk.reasonMoveUnanswered', { command: step.command }));
      } else this.reaskAfter();
      return;
    }
    const here = roomAddress(state.room);
    if (here === null) {
      if (state.room.ambiguous > 1) {
        this.walk.stop(t('automation.walk.reasonAmbiguous'));
        return;
      }
      if (spent >= patience) this.walk.stop(t('automation.walk.reasonLostAfterFight'));
      else this.reaskAfter();
      return;
    }

    /*
     * And the beat after running away, which is `LoopRunner.noteEscaped`'s in
     * the other walker caller and exists for the same measured reason: an escape
     * leaves the character one room from what it ran from, and the shortest
     * path back to a destination beyond it very often begins with the reverse
     * of the move that just escaped. Measured on a lap
     * (`logs/2026-09-02_09-58-25_festus.mudcap.jsonl`): `e` to get out, `w`
     * two seconds after `*Combat Off*`, three round trips, 51 HP down to 15,
     * ended by the player typing a direction by hand.
     *
     * The health hold underneath catches an escape the *health* threshold
     * fired, which is the common one. It cannot catch `whenOutnumbered` or the
     * PvP reaction, both of which fire at any health — and the second is the
     * one that would walk the character back to the person who just opened the
     * five-minute window. `tuning.loop.escapeSettleMs` is the floor under those,
     * the same figure and the same argument as the lap's.
     */
    if (this.escaped) {
      if (Date.now() - this.escapedAt < tuning().loop.escapeSettleMs) {
        this.reaskAfter();
        return;
      }
      this.escaped = false;
    }

    if (here === step.from) {
      // Nothing moved: the route it was walking is still the route from here.
      this.walk.carryOn(state);
      return;
    }

    // Moved: the journey is planned again from here, arrived, or stopped for
    // the router's reason — `Walker.onward`, which a scatter landing shares.
    this.walk.onward(state, here);
  }

  /**
   * Ask again in a beat, against the state as it will be then.
   *
   * The re-ask the fight hold shares with `resumeFromFight`. A held walk has
   * no wire event left to wake it — `*Combat Off*` is a state change and
   * arrives, but the move that is still in flight, the room that has not been
   * placed and the health that has not come back are all things that change
   * without one — so the hold owns a clock, checks rather than trusts it, and
   * reads `stateNow()` because the state the hold began with is a second and
   * a half stale by the time this runs. Only while no beat is pending: the
   * slot is one deep (`WalkClock`).
   */
  private reaskAfter(): void {
    if (this.clock.beating) return;
    this.clock.afterHold(tuning().walk.holdMs, () => {
      if (!this.walk.walking()) return;
      const now = this.events.stateNow?.();
      if (now) this.walk.recheck(now);
    });
  }

  /**
   * Stand still while the character is too hurt to be travelling.
   *
   * *"I was low on health and decided to walk to bank, and it just skipped the
   * rest stuff"* — reported with a transcript in which the character was
   * **already sitting** (`[HP=33/KAI=0]: (Resting)`) when `Walking 29 steps to
   * Bank of Godfrey` stood it up and marched it, at 33 HP, through five dark
   * rooms it had no light for. A loop already refuses to do that; a route the
   * player asked for did not, and there is no reason for the two to differ.
   * `restBelow`/`restTo` say *the character does not travel below this*, and
   * this is the other half of the sentence the loop was already reading.
   *
   * Three properties it does not share with the quarry beat (`Walker.holdBeforeSending`):
   *
   * - **It is not bounded by `walk.maxHolds`.** That bound exists so a quarry
   *   nothing will engage cannot pin a walk for ever — three beats and the
   *   walk goes on. Recovering takes minutes, and a walk that gave up waiting
   *   and marched off at 33 HP would be the reported bug with extra steps.
   *   What bounds *this* is the character healing, which `Recovery` is doing
   *   precisely because the walk is standing still.
   * - **It is hysteresis, not a threshold.** Below `restBelow` to stop; back to
   *   `resumeAtHealth` to go on. One figure would resume the march at the
   *   health it stopped at and the next blow would stop it again — the pair's
   *   whole reason for being a pair, stated once in `src/shared/config.ts` so
   *   a route and a lap cannot disagree about it.
   * - **Unknown never holds.** A null maximum is absence, not a low number,
   *   and a walk pinned for want of a stat sheet is a character that never
   *   arrives.
   *
   * Published and not printed: `mudengine-automation` › *A route stands still
   * while too hurt to travel*.
   */
  holdForHealth(state: CharacterState): boolean {
    if (!this.wantsHealthHold(state)) {
      // Only its own hold: a walk standing still blind is not one whose health
      // has come back.
      if (this.hold === 'health') {
        this.hold = null;
        this.walk.publish();
      }
      return false;
    }

    if (this.hold === null) {
      this.hold = 'health';
      this.walk.publish();
    }

    /*
     * Re-asked on the beat's own timer rather than waiting on a state push:
     * `WalkerEvents.holdAt` already established that a walk decides on a clock here, and
     * health arrives on every status line anyway, so the answer is never more
     * than one tick stale.
     */
    this.walk.retryAfter(tuning().walk.holdMs, state);
    return true;
  }

  /**
   * A step held for a beat because a `rest` is still waiting for its answer.
   *
   * **The guard is not on the decision to rest; it is on everything else that
   * moves the character afterwards** (todo 14). `SessionManager.mayRest` asks
   * *should I rest*, honestly, at an instant whose answer is right — the
   * monster is not dead yet, so the lap is holding for the fight and nothing
   * is walking. Then `rest` goes out, the monster dies, the hold lifts, and the
   * lap steps into the rest it just authorised. No condition added to that
   * question can help, because at the moment it runs there is nothing to
   * report.
   *
   * So this is a claim made *after*: between `rest` going out and the server
   * answering, a walk may not start. Asked first of all the holds
   * (`Walker.holdBeforeSending`), because what this has to stop is a step
   * going out and everything that could send one comes after it; the word it
   * publishes defers to a hold already standing (below). It is bounded by the
   * window itself — `(Resting)` arriving or `tuning.rest.askedMs` expiring —
   * so the beat is taken at most once or twice and never depends on the walk
   * to end.
   *
   * It does not stand down an escape: `Walker` is not what runs away, and
   * `SessionManager.mayRest` already refuses to propose a rest while one is in
   * flight.
   */
  holdForRest(state: CharacterState): boolean {
    if (this.events.restInFlight?.() !== true) {
      // Only its own hold, like every other: a walk standing still for health
      // is not one whose rest has landed.
      if (this.hold === 'resting') {
        this.hold = null;
        this.walk.publish();
      }
      return false;
    }

    /*
     * Only where nothing better has the word.
     *
     * Asked first, this can find the walk already standing still for the
     * figure that produced the rest — the health hold an earlier beat took —
     * and that one keeps saying so: the more useful of the two sentences, and
     * the one whose release is already written. This one has a word at all
     * for the case with no other reason: a rest asked for at a trap's floor,
     * or a `restTo` stretch above `restBelow`.
     */
    if (this.hold === null) {
      this.hold = 'resting';
      // Said, because a lap that pauses for a second should say why — the rule
      // every other hold here follows. Once per hold, not once per beat.
      if (!this.walk.quiet()) this.events.notice?.(t('automation.walk.restHolding'));
      this.walk.publish();
    }

    this.walk.retryAfter(tuning().walk.holdMs, state);
    return true;
  }

  /**
   * Stand still while the room read after a kill is unanswered (todo 814).
   *
   * `holdForRest`'s shape, and for its reason: a claim about something this
   * client asked a moment ago, bounded by that ask's own window. **No hold
   * word and nothing said**: it is a beat per kill, the reprint it waits on
   * is on the screen saying what the pause is for, and a sentence per kill
   * would be the terminal again.
   */
  holdForFloor(state: CharacterState): boolean {
    this.floorHeld = this.events.floorInFlight?.() === true;
    if (!this.floorHeld) return false;
    this.walk.retryAfter(tuning().walk.holdMs, state);
    return true;
  }

  /**
   * A block went by: where the walk stands still for the floor read and the
   * read has closed, the beat is brought forward to now (todo 765). Asked
   * after every block rather than on the read's own, because `Walker.onBlock`
   * runs before the loot has read the exits that close it; the next block is
   * the prompt behind them. Re-asked as the beat would be, so every hold has
   * its say again; a take the read produced still queued keeps the read in
   * flight (`AutoLoot`), or the step would overtake it.
   */
  afterBlock(): void {
    if (!this.floorHeld || this.events.floorInFlight?.() === true) return;
    this.floorHeld = false;
    const state = this.events.stateNow?.();
    if (state === undefined) return;
    this.clock.clear();
    this.walk.retryAfter(0, state);
  }

  /**
   * Stand still in a room too dark to read while the light that fixes it is on
   * its way.
   *
   * A blinding room prints **no room block at all** — no name, no exits — so
   * the client cannot place the character and the walk stopped with
   * `reasonDarkUnresolved`. `AutoLight` handles exactly this case, and it is
   * asked one statement *after* the walker on the same state
   * (`SessionManager.onCharacter`), so the stop was decided before the torch
   * was even proposed. Measured live 2026-09-15
   * (`logs/2026-09-15_16-43-16_festus.mudcap.jsonl`, t=328996): the walk
   * ended, `light torch` went out 1ms later, the `l` behind `You lit the
   * torch.` 77ms after that, and the room — *Caves of Chaos*, uniquely placed
   * by its own exits — came back 145ms after the journey was already over.
   *
   * So the question is asked of the module that will answer it (`lightComing`)
   * and the walk waits. Bounded by `tuning.walk.lightWaitMs` from the moment
   * it started waiting, and the bound is this hold's **own** timer rather than
   * the step's: the step *was* answered, and `Walker.waitForPrompt`'s sentence would
   * blame the server for a silence that never happened — which is the same
   * argument that put the stop here in the first place.
   *
   * Nothing to ready, auto-light off, or an escape in flight, and this returns
   * false with nothing said: the caller stops exactly as it did.
   */
  holdForLight(state: CharacterState): boolean {
    const spent =
      this.darkSince !== null && Date.now() - this.darkSince >= tuning().walk.lightWaitMs;
    if (spent) {
      // Silently: the caller's stop is what says why, and *walking on* about a
      // light that never came would be the opposite of what happened.
      this.forgetDarkHold();
      return false;
    }
    if (this.darkSince === null) {
      if (this.events.lightComing?.(state) !== true) return false;
      this.darkSince = Date.now();
      if (!this.walk.quiet()) this.events.notice?.(t('automation.walk.holdingDark'));
    }
    if (this.hold !== 'dark') {
      this.hold = 'dark';
      this.walk.publish();
    }
    /*
     * The step is answered, so its deadline is not the bound here — and
     * leaving it armed would end the journey with `nothing came back after go
     * portal` about a server that answered in four milliseconds.
     */
    this.clock.clear();
    this.clock.afterHold(tuning().walk.lightWaitMs, () => {
      if (!this.walk.walking()) return;
      const now = this.events.stateNow?.() ?? state;
      // The look landed after all: pick the arrival up from where it now is.
      if (roomAddress(now.room) !== null) {
        this.walk.recheck(now);
        return;
      }
      this.forgetDarkHold();
      this.walk.stop(
        t('automation.walk.reasonDarkUnresolved', { lightLevel: now.room.light ?? '?' })
      );
    });
    return true;
  }

  /** The light arrived: lets the dark hold go, out loud, and only that one. */
  releaseDarkHold(): void {
    if (this.darkSince === null) return;
    this.darkSince = null;
    if (this.hold !== 'dark') return;
    this.hold = null;
    if (!this.walk.quiet()) this.events.notice?.(t('automation.walk.lightResumed'));
    this.walk.publish();
  }

  /** The same, silently, where the caller is about to say something better. */
  private forgetDarkHold(): void {
    this.darkSince = null;
    if (this.hold !== 'dark') return;
    this.hold = null;
    this.walk.publish();
  }

  /** Whether this character is below the figure it may travel at. */
  private wantsHealthHold(state: CharacterState): boolean {
    if (!this.holdWhenHurt) return false;
    const { restBelow } = this.config.health;
    if (restBelow <= 0) return false;
    const { hp, hpMax } = state.vitals;
    if (hp === null || hpMax === null || hpMax <= 0) return false;
    const floor =
      this.hold === 'health'
        ? resumeAtHealth(this.config.health, tuning().loop.resumeMarginWhenUncapped)
        : restBelow;
    return hp / hpMax < floor;
  }

  /**
   * Whether the character is known to be standing, and so may be asked to
   * make the server say something (`Walker.nudge`). Only the port's `false`
   * is standing: down is refused nothing a bare Enter would fix, and an
   * unasked port is not the reassuring answer (todo 764).
   */
  standing(): boolean {
    return this.events.onTheGround?.() === false;
  }

  /**
   * The step's deadline, with nothing come back: a step the server refused
   * rather than lost. Down, it was refused (`MoveCommand`) and nothing
   * automated follows, so the walk stops saying so rather than *nothing came
   * back* (todo 764); held, it waits (`holdForAffliction`). True when either
   * answered the deadline.
   */
  refusedAtDeadline(command: string): boolean {
    if (this.events.onTheGround?.() === true) {
      this.walk.stop(t('automation.walk.reasonGrounded', { command }));
      return true;
    }
    const now = this.events.stateNow?.();
    return now !== undefined && this.holdForAffliction(now);
  }

  /**
   * Stand still while the server says the character is blind, held, poisoned
   * or confused — MegaMUD's `IgnoreBlind` / `IgnorePoison` / `IgnoreConfusion`
   * defaults, which wait (2026-09-05, MegaMUD §3.6; confusion 2026-09-24).
   * On the health hold's own terms: a hold, not an ending; not bounded by
   * `walk.maxHolds`, because what bounds it is the condition passing (or a
   * cure under `spells.cures` ending it sooner); and re-asked on the beat's
   * timer against `stateNow`, because the flag moves only when the server
   * says so and that sentence may land between beats.
   *
   * For a loop's leg as much as for a route: the leg is a walk, and a blind
   * character walking into the next lair is the same character whichever
   * asked. The predicate is shared with `LoopRunner` (`afflictionHolding`),
   * which holds the lap *between* legs and reports it; this holds the step
   * *within* one.
   *
   * Said out loud on the way in and out for a route, because a route reading
   * *29 steps to …* that does not move is indistinguishable from a broken
   * client; silent for a loop's leg, which reports its own holds.
   */
  holdForAffliction(state: CharacterState): boolean {
    /*
     * The stated condition first, and then the one the server refused a move
     * with and this client could not name — see `onsetAnsweredStep`. Second,
     * because a flag the wire set is worth more than a sequence inferred from
     * one, and the two answer the same hold either way.
     */
    const reason =
      afflictionHolding(state.afflictions, this.config.movement) ??
      (this.onsetAnsweredStep !== null ? 'held' : null);
    /*
     * The bound on a hold for a condition — see `heldSince`. It **asks again**
     * rather than giving up, which is what makes it safe to have at all: the
     * step that goes out next is either walked or answered with the hold's own
     * sentence, and the refusal re-arms the hold with a fresh window.
     *
     * Silent, unlike the release below it. The condition has not passed — the
     * client has run out of ways to find out whether it has — and saying it
     * had would be a claim nothing on the wire has made.
     */
    /*
     * **Every condition, not just `held`** (todo 23, 2026-09-12). The bound was
     * written for `held` and the argument never turned on which condition it
     * was: a stated affliction whose *ending* the client cannot read holds the
     * step for ever. The step this spends to find out is the same probe in
     * every case — the server either walks the character or prints the hold's
     * own sentence again and re-arms the window.
     */
    const spent =
      this.heldSince !== null && Date.now() - this.heldSince >= tuning().walk.heldFallbackMs;
    if (reason === null || spent) {
      if (isAfflictionHold(this.hold)) {
        this.hold = null;
        if (!this.walk.quiet() && !spent)
          this.events.notice?.(t('automation.walk.afflictionResumed'));
        this.walk.publish();
      }
      this.heldSince = null;
      this.onsetAnsweredStep = null;
      return false;
    }
    this.heldSince ??= Date.now();
    if (this.hold !== reason) {
      this.hold = reason;
      if (!this.walk.quiet()) this.events.notice?.(holdingSentence(reason));
      this.walk.publish();
    }
    this.walk.retryAfter(tuning().walk.holdMs, state);
    return true;
  }

  /**
   * Stand still before a trap the character is not yet fit to take.
   *
   * *"Rest for traps if health is too low"* (todo 01, 2026-09-10). A trap is
   * the one gate on a route that is walked into and taken, and the walk was
   * taking it at whatever health it happened to have: `restBelow` stops a
   * walk at 35% of the bar, and a 36-damage trap does not care what the bar
   * is. The floor here slides with the trap — its damage, plus the share of
   * maximum `automation.health.restBeforeTraps` says should be left after
   * it, or what the router expects the lair beyond to take, whichever is more
   * (a trap into a lair is a fight fought on what the trap left) — and is
   * capped at the maximum, which is the most a rest can do about a trap that
   * takes more than the bar holds.
   *
   * On the health hold's terms: a hold, not an ending; not bounded by
   * `walk.maxHolds`; re-asked on the beat's timer against `stateNow`. Only
   * its own hold is released here. Unknown never holds. And it is **every**
   * walk's, a loop's leg and the way home included — the loop holds between
   * legs and cannot see a trap inside one, and a trap does not care why the
   * character is walking. `Recovery` reads the figure through `restingFor`
   * and sits the character down to it.
   */
  holdForTrap(state: CharacterState): boolean {
    const step = this.walk.step();
    const floor = step === undefined ? null : this.trapFloorFor(step, state);
    const { hp } = state.vitals;
    if (floor === null || hp === null || hp >= floor) {
      if (this.hold === 'trap') {
        this.hold = null;
        this.trapFloor = null;
        if (!this.walk.quiet() && step !== undefined) {
          this.events.notice?.(t('automation.walk.trapResumed', { stepName: step.name }));
        }
        this.walk.publish();
      }
      return false;
    }
    if (this.hold !== 'trap' || this.trapFloor !== floor) {
      const fresh = this.hold !== 'trap';
      this.hold = 'trap';
      this.trapFloor = floor;
      if (fresh && !this.walk.quiet() && step !== undefined) {
        this.events.notice?.(
          t('automation.walk.trapHolding', {
            stepName: step.name,
            damage: trapOn(step)?.damage ?? 0,
            needed: floor,
            hp
          })
        );
      }
      this.walk.publish();
    }
    this.walk.retryAfter(tuning().walk.holdMs, state);
    return true;
  }

  /**
   * The health a step's trap wants first, in hit points, or null: no trap, a
   * trap whose damage the realm does not state (a hold on a figure nobody
   * gave would stand for ever), the setting off, or a maximum nobody has read.
   */
  private trapFloorFor(step: RouteStep, state: CharacterState): number | null {
    const share = this.config.health.restBeforeTraps;
    if (share <= 0) return null;
    const trap = trapOn(step);
    if (trap === null || trap.damage === null) return null;
    const { hpMax } = state.vitals;
    if (hpMax === null || hpMax <= 0) return null;
    // In points, both halves: the lair's figure is the pass in hit points
    // (`RouteStep.lairDamage`), never `danger`, which is a share of the bar
    // as it stood when the route was planned.
    const reserve = Math.max(share * hpMax, step.lairDamage ?? 0);
    return Math.min(hpMax, Math.ceil(trap.damage + reserve));
  }
}

/** What a route says on standing still for a condition, one sentence each. */
function holdingSentence(reason: AfflictionHold): string {
  switch (reason) {
    case 'blind':
      return t('automation.walk.holdingBlind');
    case 'held':
      return t('automation.walk.holdingHeld');
    case 'poisoned':
      return t('automation.walk.holdingPoisoned');
    case 'confused':
      return t('automation.walk.holdingConfused');
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}
