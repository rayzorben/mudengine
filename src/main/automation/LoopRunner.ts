/**
 * Walking a loop, round and round, which is how a character gains levels.
 *
 * Built *on* `Walker` rather than beside it: every step is still planned by
 * `WorldGraph.route`, sent one at a time and confirmed against the room that
 * arrives, and every reason a walk stops — a shut door, a wrong room, combat,
 * a command the player typed — stops it here too. What this adds is the part
 * a walk does not have: when the walk *ends*, decide where to go next.
 *
 * The rules it follows, and why each one:
 *
 * - **A fight is not an interruption; it is the point.** `Walker` stops when
 *   combat starts, so the loop waits for the fight to end (auto-combat is what
 *   fights it) and then plans the next leg from wherever the character is
 *   actually standing. A loop that abandoned itself at the first monster would
 *   never gain anything.
 * - **It replans; it never resumes.** The route it was walking was planned
 *   from a room it may have left. Planning again from here is the same rule
 *   `Walker` follows after any failure.
 * - **A stop that is not a fight is counted.** A door nobody can open does not
 *   become better on the tenth attempt, so after `tuning.loop.maxFailures` consecutive
 *   non-combat failures the loop stops and says which stop it could not reach.
 * - **The player outranks it.** Anything typed stops the loop, as it stops a
 *   walk, and it says so once.
 * - **Running away is a hold, not an ending.** A loop runs until the player
 *   stops it, the character dies, or its stops fail wholesale; an escape is none
 *   of those. It stands still until the fight is over and the health is back
 *   (`noteEscaped`) and then walks on, which is also what lets the character rest
 *   where it landed.
 * - **And so is losing the connection.** The character does not leave the
 *   realm because a router rebooted — it stands where the socket went, with
 *   whatever was in the room — and the lap it was walking is none of the three
 *   things that end one either. It holds (`noteOffline`) until the character
 *   is back in the realm and placed, and then plans on from wherever that is
 *   (`noteOnline`), the same recovery a fight gets.
 */
import {
  NO_LOOP,
  nextStop,
  splitStop,
  type Loop,
  type LoopProgress,
  type LoopStatus
} from '../../shared/loops';

export { NO_LOOP, type LoopProgress, type LoopStatus };
import { t } from '../app/i18n';
import { fightIsRunning } from './Walker';
import type { CharacterState } from '../../shared/character';
import { DEFAULT_CONFIG, resumeAtHealth, type HealthConfig } from '../../shared/config';
import type { RoomId, Route } from '../../shared/world';
import { tuning } from '../app/tuning';

/**
 * The walk failures that are really location-trust failures — the character
 * is somewhere, the belief about where is what broke — and one `rm` answers
 * all three. A refused exit or a shut door is *not* here: those are facts
 * about the route, and skipping the stop is the answer.
 */
const LOST = /no longer tell|somewhere the route did not expect|nothing came back/i;

export interface LoopEvents {
  notice?(message: string): void;
  /** Progress changed, so the renderer can redraw. */
  progress?(progress: LoopProgress): void;
  /**
   * The loop cannot plan because nobody knows where the character is. The
   * realm answers `rm` with exact coordinates, so whoever owns the queue asks
   * — and the loop retries when the answer lands, instead of dying of a fact
   * one command away.
   */
  locate?(): void;
}

export interface LoopPlanner {
  /** A route from where the character is to this stop, or a reason there is none. */
  routeTo(stop: { name: string; at: { map: number; room: number } | null }): Route | string;
  /** Hand a route to the walker. Returns the walker's refusal, or null. */
  walk(route: Route): string | null;
  /**
   * Whether a move this client sent is still waiting for the room it reaches.
   *
   * While one is, the room every other method here reads is the one the
   * character is *leaving*, so nothing may be planned from it. Asked of the
   * tracker rather than of the walker because it counts every move, not only
   * a route's — the leg the last walk had already sent when combat stopped it
   * is exactly the one that matters.
   */
  moveInFlight(): boolean;
  /** Whether the character is standing in the stop already. */
  here(stop: { name: string; at: { map: number; room: number } | null }): boolean;
  /**
   * Which room a stop names, or null when the realm cannot settle it.
   *
   * For drawing only — `routeTo` resolves the same stop again when the lap
   * reaches it and is the one that reports a refusal. Asked once per run
   * rather than per publish: an unqualified stop name is a search of the
   * realm's room index, and progress is republished several times a minute.
   */
  roomOf(stop: { name: string; at: { map: number; room: number } | null }): RoomId | null;
  /**
   * Whether some other walk is running this character right now.
   *
   * Only the `retreated` hold reads it, and only to decide when to let go: a
   * `safe-haven` escape walks the character home *while the loop is held*, and a
   * hold released mid-route would hand the walker a second route and abandon
   * the first one silently. `moveInFlight` does not answer this — it is false
   * in the beat between two steps of that walk.
   */
  walking(): boolean;
}

export class LoopRunner {
  private loop: Loop | null = null;
  /**
   * Where each of this run's stops is, by stop index — resolved once at
   * `start`, so a stop the realm cannot place stays null for the run and is
   * simply not drawn. Parallel to `loop.stops`, so `skip` and `reverse` move
   * the index over it without invalidating anything.
   */
  private stopRooms: Array<RoomId | null> = [];
  private index = 0;
  private forward = true;
  private laps = 0;
  private failures = 0;
  private status: LoopStatus = 'idle';
  private reason: string | null = null;
  private lingerUntil = 0;
  private waiting = false;
  /** Staying put on purpose, rather than waiting out a fight. */
  private lingering = false;
  private fighting = false;
  /** Consecutive locate requests without a plan; bounded by MAX_LOCATES. */
  private locates = 0;
  /** Holding for health; see `health.restBelow`. */
  private hurt = false;
  /**
   * Holding because the character ran away; see `noteEscaped`.
   *
   * Its own flag rather than `hurt`, because the two clear on different facts:
   * an escape at full health is under no threshold at all, so the health hold
   * would let go on the very next status line and walk the lap back into the
   * room it just ran out of.
   */
  private escaped = false;
  private escapedAt = 0;
  /**
   * Holding because the pack ran short and `Supplies` is walking the
   * character to a shop; see `noteErrand`. Its own flag for the reason
   * `escaped` is: it clears on a different fact — the errand ending — and
   * on none of the ones the other holds watch.
   */
  private errand = false;
  /**
   * Holding because the connection went; see `noteOffline`.
   *
   * Its own flag for the reason the two above are: it clears on one fact —
   * the character back in the realm and placed — and on none of the ones the
   * other holds watch. Set for a paused loop too, so a `resume` pressed while
   * the socket is down plans nothing into it; only a running loop *reports*
   * the hold, because a paused loop is not waiting for anything.
   */
  private offline = false;
  private timer: NodeJS.Timeout | null = null;
  /** When this run started, and what the character's experience read then. */
  private startedAt: number | null = null;
  private expAtStart: number | null = null;
  /**
   * Where a loop holds still for health, and where it walks on again.
   *
   * Auto-combat's `minHealth` stops fights being *opened* low; nothing stopped
   * the loop marching a 6% character through lairs that attack on sight —
   * measured live. Holding still is what lets `automation.health` rest where
   * the character stands. A hysteresis pair, so a heal that nudges past the
   * floor does not resume a march that dips straight back under it; constants
   * (35% / 70%) until 2026-08-29, and `automation.health` now, because a
   * squishy caster and a tank want different floors. Unknown maxima hold
   * nothing: unknown is not low, the rule every threshold here follows.
   */
  private health: HealthConfig = DEFAULT_CONFIG.automation.health;

  constructor(
    private readonly planner: LoopPlanner,
    private readonly events: LoopEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Applies a config load or reload. Takes effect on the next status line. */
  configure(health: HealthConfig): void {
    this.health = health;
  }

  get progress(): LoopProgress {
    const stop = this.loop?.stops[this.index];
    const running = this.status === 'running';
    return {
      status: this.status,
      name: this.loop?.name ?? null,
      stop: this.loop ? this.index + 1 : 0,
      stops: this.loop?.stops.length ?? 0,
      stopName: stop ? splitStop(stop).name : null,
      remainingStops: this.remainingStops(),
      laps: this.laps,
      reason: this.reason,
      // Only a running loop is *held*; a paused or stopped one is not waiting
      // for anything, whatever the last status line said. Offline first: the
      // character is not in the realm, so nothing the others say is current.
      hold: running
        ? this.offline
          ? 'offline'
          : this.fighting
            ? 'fight'
            : this.hurt
              ? 'health'
              : this.escaped
                ? 'retreated'
                : this.errand
                  ? 'errand'
                  : null
        : null,
      startedAt: this.startedAt,
      expAtStart: this.expAtStart,
      forward: this.forward,
      bounce: this.loop?.bounce ?? false
    };
  }

  /** Start looping. Returns a refusal, or null once it is running. */
  start(loop: Loop, state: CharacterState): string | null {
    if (state.phase !== 'in-game') return t('automation.loops.refusalNotInRealm');
    this.loop = loop;
    this.stopRooms = loop.stops.map((stop) => this.planner.roomOf(splitStop(stop)));
    this.laps = 0;
    this.failures = 0;
    this.locates = 0;
    this.hurt = false;
    this.escaped = false;
    this.offline = false;
    this.forward = true;
    this.reason = null;
    this.status = 'running';
    this.lingerUntil = 0;
    this.lingering = false;
    /*
     * Read from the state handed in, never carried over: this used to be
     * whatever the last run left behind, and — worse — a loop *started* in
     * the middle of a fight never read it at all, planned its first leg
     * immediately, and the walker stepped out of the fight (captured live,
     * 2026-09-01). The room is cleared first: `advance` holds while this is
     * true, auto-combat is what does the clearing, and `onCharacter` walks on
     * when the server says `*Combat Off*` — the same wait a fight that stops
     * a walk mid-loop has always been given.
     */
    this.fighting = fightIsRunning(state);
    this.startedAt = this.now();
    // Null stays null: experience made is only ever a difference between two
    // numbers the client had, never a difference from zero.
    this.expAtStart = state.progress.exp;
    // From the stop nearest to hand: starting at the top of the list would
    // walk the character back past everything it is standing next to.
    this.index = this.nearestStop();
    this.events.notice?.(
      t('automation.loops.started', { loopName: loop.name, stopCount: loop.stops.length })
    );
    this.publish();
    return this.advance(true);
  }

  stop(reason: string): void {
    if (this.status !== 'running' && this.status !== 'paused') return;
    this.clearTimer();
    this.status = 'stopped';
    this.reason = reason;
    this.errand = false;
    this.offline = false;
    this.events.notice?.(t('automation.loops.stopped', { reason }));
    this.publish();
  }

  /**
   * Holds the loop where it is until `resume`.
   *
   * Unlike `stop`, the loop and its place round it are kept. The leg being
   * walked is the caller's to end — the runner never touches the walker
   * directly, and a leg left walking under a paused loop would arrive and
   * dwell as though nothing had happened. Nothing is decided while paused:
   * `onCharacter` and `onWalkEnded` both return on anything but `running`.
   */
  pause(): void {
    if (this.status !== 'running') return;
    this.clearTimer();
    this.status = 'paused';
    this.lingering = false;
    this.waiting = false;
    this.events.notice?.(t('automation.loops.paused'));
    this.publish();
  }

  /**
   * Walks on from wherever the character actually is.
   *
   * Planned afresh rather than from where the pause left it — the same
   * recovery a fight gets — because a paused character may have been walked,
   * run or teleported in the meantime, and a route from a room it is not in
   * is the desynchronisation the walker exists to refuse.
   */
  resume(state: CharacterState): string | null {
    if (this.status !== 'paused' || !this.loop) return t('automation.loops.refusalNotPaused');
    if (state.phase !== 'in-game') return t('automation.loops.refusalNotInRealm');
    this.status = 'running';
    this.reason = null;
    this.fighting = fightIsRunning(state);
    // The player asked for the lap back, which outranks the beat an escape takes.
    this.escaped = false;
    // And outranks an errand: whoever owns it hears the walk superseded.
    this.errand = false;
    this.events.notice?.(t('automation.loops.resumed'));
    this.publish();
    return this.advance(false);
  }

  /**
   * Gives up on the current stop and heads for the next one.
   *
   * For a stop the game will not let the character reach — a door somebody
   * shut, a lair that is somebody else's tonight. Counts towards the lap like
   * any step, because a lap is the list run through once however it is
   * walked. While paused it only moves the pointer; the walk waits for
   * `resume`. The leg being walked is the caller's to end, as with `pause`.
   */
  skip(): string | null {
    if (!this.loop || (this.status !== 'running' && this.status !== 'paused')) {
      return t('automation.loops.refusalNotLooping');
    }
    this.clearTimer();
    this.lingering = false;
    this.waiting = false;
    this.failures = 0;
    this.events.notice?.(
      t('automation.loops.skipped', {
        stopName: this.loop.stops[this.index]?.room ?? t('automation.loops.fallbackStop')
      })
    );
    if (this.status === 'paused') {
      const next = nextStop(this.loop, this.index, this.forward);
      this.index = next.index;
      this.forward = next.forward;
      this.publish();
      return null;
    }
    this.step();
    return null;
  }

  /**
   * Turns a bounce loop round.
   *
   * Only a bounce loop has a direction: a plain loop runs its list one way
   * and `nextStop` ignores `forward` for it, so reversing one would be a
   * control that does nothing. Takes effect at the next step, so a leg in
   * flight finishes where it was going.
   */
  reverse(): string | null {
    if (!this.loop || (this.status !== 'running' && this.status !== 'paused')) {
      return t('automation.loops.refusalNotLooping');
    }
    if (!this.loop.bounce) return t('automation.loops.refusalNotBounce');
    this.forward = !this.forward;
    this.events.notice?.(t('automation.loops.reversed'));
    this.publish();
    return null;
  }

  reset(): void {
    this.clearTimer();
    this.loop = null;
    this.stopRooms = [];
    this.status = 'idle';
    this.reason = null;
    this.index = 0;
    this.laps = 0;
    this.failures = 0;
    this.waiting = false;
    this.lingering = false;
    this.hurt = false;
    this.escaped = false;
    this.errand = false;
    this.offline = false;
    this.startedAt = null;
    this.expAtStart = null;
    this.publish();
  }

  /**
   * Whether this loop is to be carried into the next connection.
   *
   * True only for a loop the connection went out from under — running or
   * paused. `SessionManager.connect` resets everything else a session holds
   * and reads this to leave the loop alone; a loop stopped, or one running on
   * a socket that has not closed yet, is put down as before.
   */
  get carried(): boolean {
    return this.offline;
  }

  /**
   * The connection went, and this client did not ask it to.
   *
   * The lap is held, not ended, for `noteEscaped`'s reason: a loop runs until
   * the player stops it, the character dies, or its stops fail wholesale, and
   * a link dropping is none of those. The character is still standing
   * wherever the socket went — on this server family a disconnect is not a
   * pause, and whatever was in the room is still there — so the lap picks up
   * from there when the character is back (`noteOnline`).
   *
   * Called **before** the walker is stopped, so the leg ending is read as the
   * socket rather than as a failed stop; and the timer is put down here
   * because every path it could wake — the dwell lapsing, a locate retry —
   * would plan a leg into a closed socket. The dwell itself stays armed
   * (`lingering` and a lapsed `lingerUntil`), so a loss at a stop the lap had
   * reached goes on to the *next* stop afterwards, exactly as the other holds
   * do. The errand is over by construction — `Supplies` starts afresh from
   * the next pack listing — so its hold goes with the socket rather than
   * outliving it.
   */
  noteOffline(): void {
    if (this.offline) return;
    if (this.status !== 'running' && this.status !== 'paused') return;
    this.offline = true;
    this.clearTimer();
    this.errand = false;
    /*
     * The beat after an escape ends with the socket too. Its clock is a
     * pre-outage timestamp, so it would let go on the first line back anyway
     * — announcing *recovered from the retreat* for a retreat that ended when
     * the link did — and the two facts it was really waiting for are read
     * afresh from that line: the health by the `hurt` hold, and the room by
     * `SessionManager`, which forgets what was run from on every connection.
     */
    this.escaped = false;
    if (this.status !== 'running') return;
    this.waiting = true;
    this.events.notice?.(t('automation.loops.heldOffline'));
    this.publish();
  }

  /**
   * The character is back in the realm and the client knows where it is.
   *
   * Lets the hold go and leaves the deciding to the next `onCharacter`, which
   * `noteErrandOver` already does: it re-reads the fight, the health and the
   * dwell from the state actually on the books before planning anything, and a
   * second copy of that here would be the two halves of one gate. The locate
   * budget starts over because the fact it bounds — where the character is —
   * has just been re-established. A paused loop stays paused; `resume` plans
   * afresh from wherever the character is, as it always has.
   */
  noteOnline(): void {
    if (!this.offline) return;
    this.offline = false;
    if (this.status !== 'running') return;
    this.locates = 0;
    /*
     * A dwell the loss interrupted gets its timer back for whatever is left
     * of it. `noteOffline` put the timer down, and `onCharacter` only ends a
     * lapsed dwell when a line arrives — an empty lair at night changes
     * nothing for minutes, which is the reason the dwell owns a timer at all.
     */
    if (this.lingering) this.armDwell(Math.max(0, this.lingerUntil - this.now()));
    /*
     * Another walk has the character — the route the player was walking,
     * handed back to the walker a moment before this — so the lap stays
     * exactly where it was before the loss: dormant under that route, woken
     * by `onWalkEnded` when it ends. `Walker.start` supersedes a walk silently,
     * so waking the lap here would have it plan a leg over the route the
     * console has just said it picked back up. The `retreated` hold waits out
     * a walk home for the same reason.
     */
    if (this.planner.walking()) {
      // Asleep, not waiting: `noteOffline` armed `waiting` for the ordinary
      // case, and left set it would plan on the very next line.
      this.waiting = false;
      this.publish();
      return;
    }
    this.waiting = true;
    // Said only when the lap will in fact walk on. Under the health floor it
    // goes on holding, and `mended` says so on the line it does.
    if (!this.hurt) this.events.notice?.(t('automation.loops.walkingOnAfterReconnect'));
    this.publish();
  }

  /**
   * The pack ran short and the character is going shopping. The lap is held,
   * not ended, for `noteEscaped`'s reason: an errand is automation working.
   *
   * The leg being walked is the caller's to end — `Supplies` starts its own
   * walk through the same walker, which supersedes the leg — and what ends
   * here is booked as neither an arrival nor a failure. When the errand is
   * over the lap plans its next leg from the shop, exactly as it does from
   * wherever a fight left it.
   */
  noteErrand(): void {
    if (this.status !== 'running' || this.errand) return;
    this.errand = true;
    this.waiting = true;
    this.events.notice?.(t('automation.loops.heldForErrand'));
    this.publish();
  }

  /** The errand is over, however it ended; the next status line walks on. */
  noteErrandOver(): void {
    if (!this.errand) return;
    this.errand = false;
    if (this.status !== 'running') return;
    this.waiting = true;
    this.events.notice?.(t('automation.loops.walkingOnAfterErrand'));
    this.publish();
  }

  /**
   * The character ran away. The lap is held, not ended.
   *
   * A loop runs until the player stops it, the character dies, or it gives up
   * on its own stops — running away is none of those, and a lap that ended at
   * the first escape is a lap that ends the first time automation works.
   *
   * But it is not walked on from either. An escape leaves the character one room
   * from what it ran from and the next leg is planned from where it landed:
   * measured (`logs/2026-09-02_09-58-25_festus.mudcap.jsonl`) a `reverse-step`
   * escape sent `e` and the loop sent `w` two seconds after `*Combat Off*`,
   * straight back to the cave worm, three round trips, 51 HP to 15, ended by
   * the player typing a direction by hand. So the lap stands still until the
   * fight is over, the health is back (`restTo`, the hold `health`
   * already uses) and `tuning.loop.escapeSettleMs` has passed — the floor under
   * it, for an escape at full health where no threshold has anything to say.
   *
   * **And standing still is what lets the character mend**: `mayRest` refuses
   * while a loop is marching and allows it while one is held, so those two
   * seconds used to be the whole window the character had to sit down in.
   */
  noteEscaped(): void {
    if (this.status !== 'running' || this.escaped) return;
    this.escaped = true;
    this.escapedAt = this.now();
    this.waiting = true;
    /*
     * The dwell is left exactly as it was, which is what `hurt` does too: a
     * escape out of a stop the lap had already reached still counts as having
     * reached it, so when the hold lets go the lap goes on to the *next*
     * stop rather than walking back into the one it just ran out of.
     */
    this.events.notice?.(t('automation.loops.heldAfterEscape'));
    this.publish();
  }

  /**
   * The player moved the character themselves; a loop yields exactly as a walk
   * does — and for the same narrowed reason. See `Walker.notePlayerMoved`:
   * typing is not taking the wheel, and a lap that ended because somebody
   * checked their experience was a lap ended by nothing.
   */
  notePlayerMoved(): void {
    this.stop(t('automation.walk.reasonPlayerTookOver'));
  }

  /**
   * The walk this loop was running has ended. `ok` is true when it arrived.
   *
   * Called by whoever owns the walker, because the walker itself knows nothing
   * about loops — which is what keeps a plain walk a plain walk.
   */
  onWalkEnded(ok: boolean, why: string | null, state: CharacterState): void {
    if (this.status !== 'running' || !this.loop) return;
    /*
     * Held after an escape, so this walk is not the loop's: `Walker` stopped the
     * loop's leg when the fight started, and what ends here is either that
     * stopped leg or the `safe-haven` retreat, which walks the character
     * somewhere the lap never chose. Neither is an arrival at a stop and
     * neither is the stop failing — the lap picks up where it left off when
     * the hold lets go.
     */
    if (this.escaped || this.errand || this.offline) {
      this.waiting = true;
      return;
    }
    if (ok) {
      this.failures = 0;
      this.arrive();
      return;
    }
    /*
     * Combat is the one failure that is not one. `Walker` stops the moment a
     * fight starts; the loop waits for it to finish and plans again from
     * wherever the character ended up, which is what a person does.
     *
     * **Compared against the copy itself, never against a word in it**
     * (2026-09-02). This read `/combat/i`, and the walker's reason was
     * reworded to `a fight started` — which is the right wording, because the
     * old one was a present-tense claim that went false the moment
     * `*Combat Off*` arrived — and the substring stopped matching. Nothing
     * broke, because `state.inCombat` is still true on the state that stopped
     * the walk and carries the branch on its own; that is exactly how a half
     * of a pair rots unnoticed. `LOST` below has the same shape and one of its
     * three arms is already dead for the same reason.
     */
    if (fightIsRunning(state) || why === t('automation.walk.reasonCombat')) {
      this.waiting = true;
      return;
    }
    /*
     * The walk died of a lost location, not of the route: the same missing
     * fact the planner's lost path recovers with one `rm`. Not counted as a
     * failure — the stop was never reached to fail at — and not skipped,
     * because the stop is fine; the character is what needs finding.
     */
    if (why !== null && LOST.test(why) && this.locates < tuning().loop.maxLocates) {
      this.retryAfterLocate();
      return;
    }
    this.failures += 1;
    if (this.failures >= tuning().loop.maxFailures) {
      this.stop(
        t('automation.loops.giveUpReason', {
          stopName: this.loop.stops[this.index]?.room ?? t('automation.loops.fallbackNextStop'),
          why: why ?? t('automation.loops.fallbackWhy')
        })
      );
      return;
    }
    /*
     * The *next* stop, not the same one. The route that just failed was
     * planned from where the character is standing, and nothing has changed —
     * the same plan fails the same way, measured live: a stop behind an exit
     * the server refuses ate every restart the driver had. A loop minus
     * one unreachable stop is still a loop; the failure counter still ends
     * a loop whose stops are failing wholesale.
     */
    this.events.notice?.(
      t('automation.loops.skippingStop', {
        stopName: this.loop.stops[this.index]?.room ?? t('automation.loops.fallbackStop'),
        why: why ?? t('automation.loops.fallbackWhy')
      })
    );
    this.step();
  }

  /** Character state changed: the moment a fight ends, or a linger lapses. */
  onCharacter(state: CharacterState): void {
    if (this.status !== 'running' || !this.loop) return;
    /*
     * Before the phase check, not after: a lost socket leaves the phase
     * `unknown` and the next connection walks it through the login screens,
     * and every one of those would otherwise read as the character leaving.
     * Nothing is decided until `noteOnline` says the character is back.
     */
    if (this.offline) return;
    if (state.phase !== 'in-game') {
      this.stop(t('automation.loops.reasonLeftRealm'));
      return;
    }
    // A hold is a fact the card draws, so its edges are published; the value
    // itself changes once per fight, not once per status line.
    /*
     * "Fighting" is the walker's own definition — the server's flag, or
     * anything recorded as swinging — and not the flag alone (2026-09-04).
     * Read off the flag, the loop cleared this the moment `*Combat Off*`
     * arrived for a kill in a room that still held the other monster,
     * planned a leg, was refused by the walker for exactly that reason, set
     * this again, and did the whole round again on the next status line: a
     * route planned and two pushes per line, the card's chip alternating,
     * for as long as the survivor went on biting. Two halves of one gate in
     * two files agree until one is edited, so both read the one predicate.
     */
    if (this.fighting !== fightIsRunning(state)) {
      this.fighting = fightIsRunning(state);
      this.publish();
    }
    if (fightIsRunning(state)) {
      // Fighting is the point; nothing to decide until it is over.
      this.waiting = true;
      return;
    }
    const fraction =
      state.vitals.hp !== null && state.vitals.hpMax ? state.vitals.hp / state.vitals.hpMax : null;
    if (fraction !== null) {
      if (this.hurt) {
        if (fraction < this.resumeAt()) return;
        this.hurt = false;
        this.events.notice?.(t('automation.loops.mended'));
        this.publish();
      } else if (fraction < this.health.restBelow && this.status === 'running') {
        this.hurt = true;
        this.waiting = true;
        this.events.notice?.(t('automation.loops.tooHurt'));
        this.publish();
        return;
      }
    }
    if (this.escaped) {
      /*
       * Three facts, and every one of them is *the reason for running away is
       * over*: the settle, the health the `health` hold would have asked for
       * anyway, and no other walk running — a `safe-haven` retreat is walking
       * this character home, and handing the walker a second route would
       * abandon that one silently. An unknown health fraction lets go, the
       * rule every threshold here follows: unknown is not low, and a lap that
       * waited for a number nobody sent would never walk again.
       */
      if (this.now() - this.escapedAt < tuning().loop.escapeSettleMs) return;
      if (fraction !== null && fraction < this.resumeAt()) return;
      if (this.planner.walking()) return;
      this.escaped = false;
      this.events.notice?.(t('automation.loops.walkingOnAfterEscape'));
      this.publish();
    }
    // Nothing is decided while the errand has the character; `noteErrandOver`
    // sets `waiting` so the line after it plans the next leg.
    if (this.errand) return;
    if (this.lingerUntil > this.now()) return;
    if (this.lingering) {
      // The stay is up: on to the next stop, not back to this one.
      this.lingering = false;
      this.waiting = false;
      this.step();
      return;
    }
    if (!this.waiting) return;
    this.waiting = false;
    this.advance(false);
  }

  /** Walk to the current stop, or move on to the next when already there. */
  private advance(first: boolean): string | null {
    const loop = this.loop;
    if (!loop) return 'No loop.';
    const stop = loop.stops[this.index];
    if (!stop) return this.fail(t('automation.loops.reasonStopMissing'));

    /*
     * The errand has the character, so this loop plans nothing — the same hold
     * `onCharacter` states, made here because this is the funnel every caller
     * reaches and that one was not. The dwell timer walked straight past it:
     * measured (`logs/2026-09-03_22-46-50_festus.mudcap.jsonl`), a lap dwelling
     * at a stop when `Supplies` took the character shopping had its dwell lapse
     * mid-errand, `step` consumed a stop the lap never visited, and `advance`
     * then planned across the *errand's* moves — five `rm`s, exactly
     * `maxLocates`, one every two `locateWaitMs` for the length of a 31-step
     * walk, into a realm where an unknown command is said out loud in the room.
     * `waiting` is what `noteErrandOver` hands back to `onCharacter`.
     */
    if (this.errand || this.offline) {
      this.waiting = true;
      return null;
    }

    /*
     * A fight in progress is waited out before anything is planned. `start`,
     * `resume` and `skip` all reach here directly, and each used to plan
     * mid-fight — the room a leg is planned from is the room the fight is
     * *in*, so its first step walked out of it. Fighting is the point of a
     * loop; clearing the room comes first, and `onCharacter` advances the
     * moment the fight ends. Not a failure: nothing about the stop is wrong.
     */
    if (this.fighting) {
      this.waiting = true;
      return null;
    }

    /*
     * Nothing is planned across an unanswered move. `*Combat Off*` arrives
     * before the room the last step reached, so this is the ordinary case at
     * the exact moment a loop wants to plan — and a leg planned from the room
     * being left starts with the direction already on the wire. Not a failure
     * either: the fact is arriving, so it is waited for rather than counted
     * against the stop.
     */
    if (this.planner.moveInFlight()) return this.waitToBePlaced();

    const target = splitStop(stop);
    if (this.planner.here(target)) {
      if (!first) this.arrive();
      else this.step();
      return null;
    }
    const route = this.planner.routeTo(target);
    if (typeof route === 'string') {
      /*
       * Lost, not blocked: the plan failed for want of a location, which is a
       * fact one `rm` away. Ask, wait for the answer to resolve the room, and
       * try the same stop again — measured live, this exact recovery is what
       * kept the overnight driver grinding, and it belongs in the client.
       */
      if (/cannot tell/i.test(route) && this.locates < tuning().loop.maxLocates) {
        this.retryAfterLocate();
        return route;
      }
      return this.fail(route);
    }
    const refused = this.planner.walk(route);
    if (refused !== null) {
      /*
       * The walker refusing over combat is the fighting guard above losing a
       * race with the wire, not a stop that cannot be reached — the same
       * distinction `onWalkEnded` draws with the same test. Waited out rather
       * than counted: skipping a lair because a fight was running in it would
       * give up on the stop for doing exactly what the loop came for.
       */
      if (refused === t('automation.walk.refusalInCombat')) {
        this.fighting = true;
        this.waiting = true;
        this.publish();
        return null;
      }
      return this.fail(refused);
    }
    this.locates = 0;
    return null;
  }

  /**
   * Holds until the move on the wire has landed, then plans from where it
   * left the character.
   *
   * The retry is ordinarily the arriving room itself: it changes character
   * state, `onCharacter` sees the loop still waiting, and the leg is planned
   * with the room correct. The timer is only the backstop for a move the
   * server swallowed, and it falls through to the same bounded `rm` a lost
   * plan asks for — the same missing fact, so the same budget.
   */
  private waitToBePlaced(): null {
    this.waiting = true;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      // `waiting` false means the room landed and the loop has already moved
      // on; this timer is then a leftover with nothing to say.
      if (this.status !== 'running' || this.fighting || this.offline || !this.waiting) return;
      if (this.planner.moveInFlight() && this.locates < tuning().loop.maxLocates) {
        this.retryAfterLocate();
        return;
      }
      this.waiting = false;
      this.advance(false);
    }, tuning().loop.locateWaitMs);
    this.timer.unref?.();
    return null;
  }

  /**
   * Ask where the character is and try the same stop again once the answer
   * has had time to land. One place, because the walk-ended path and the
   * plan-failed path recover from the same missing fact the same way.
   */
  private retryAfterLocate(): void {
    /*
     * Never across an errand. `moveInFlight` answers *the wire*, not *this
     * loop*, so while `Supplies` walks the character to a shop it is true on
     * every step of a route the loop did not send — and reading that as a move
     * the server swallowed spends the whole `maxLocates` budget asking where a
     * character that was never lost is standing.
     */
    if (this.errand || this.offline) {
      this.waiting = true;
      return;
    }
    this.locates += 1;
    this.events.locate?.();
    this.waiting = true;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.status !== 'running' || this.fighting || this.offline) return;
      this.waiting = false;
      this.advance(false);
    }, tuning().loop.locateWaitMs);
    this.timer.unref?.();
  }

  /** Arrived at a stop: dwell — the configured linger, or long enough to fight. */
  private arrive(): void {
    const loop = this.loop;
    if (!loop) return;
    const stop = loop.stops[this.index];
    const dwell = stop?.linger ? stop.linger * 1000 : tuning().loop.dwellMs;
    this.lingerUntil = this.now() + dwell;
    this.lingering = true;
    this.waiting = true;
    /*
     * The stop moved, which the card draws. The dwell's *end* is deliberately
     * not published: it was a countdown ("Leaving in 2s") beside a status chip
     * already saying `running`, `fighting` or `resting`, and the two said the
     * same thing — the second of them in the words that explain it. A figure
     * nothing reads is a figure the client does not have, so it stays private
     * to the runner, which is the only thing that acts on it.
     */
    this.publish();
    this.armDwell(dwell);
  }

  /**
   * An owned timer for the dwell, because the stream may say nothing.
   * `onCharacter` also ends a lapsed dwell, but character state is
   * republished only when it changes — and an empty lair at night changes
   * nothing for minutes.
   */
  private armDwell(remaining: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onDwellElapsed();
    }, remaining + 50);
    this.timer.unref?.();
  }

  /** The dwell timer fired. A fight in progress keeps holding the loop. */
  private onDwellElapsed(): void {
    if (this.status !== 'running' || !this.lingering) return;
    // A fight, a hurt hold, the beat after an escape or an errand outlives the
    // dwell: the linger stays armed and `onCharacter` releases it when the
    // fight ends, the health returns, the retreat has settled or the shopping
    // is done. The errand was missing, and it is the one of the four that is
    // *started* by the character standing still — `Supplies.consider` refuses
    // while anything else has it — so a dwell is where it always begins.
    if (this.fighting || this.hurt || this.escaped || this.errand || this.offline) return;
    this.lingering = false;
    this.waiting = false;
    this.step();
  }

  /**
   * The fraction a lap held for health walks on again at.
   *
   * `restTo` is the ceiling a stretch of resting is carried on to, and it is
   * the same hysteresis the retired `loopResumeAt` stated: a heal that nudges
   * past the floor must not resume a march that dips straight back under it.
   *
   * **A 0 ceiling is not "resume at the floor".** `restTo: 0` means *the single
   * sit-down* to `Recovery`, and it is a value the settings screen offers, the
   * template documents, and `statedTheRestCeiling` has written into every
   * existing file that stated a health block. Reading it as the resume figure
   * would give the lap a zero-width band — it resumes marching at exactly the
   * health it paused at, the next hit puts it back, and that is pause-and-
   * resume at status-line cadence, which is the whole thing this pair exists to
   * prevent. Clamping `loopResumeAt` up to `loopPauseBelow` had the same worst
   * case and nobody ever met it, because the shipped pair was never equal; here
   * equal is the *common* case, so it has to be answered rather than tolerated.
   *
   * So an uncapped rest resumes a margin above the floor. An absolute fraction
   * of maximum rather than a multiplier: a proportional margin vanishes under a
   * low floor, which is the character that most needs the gap. Never above 1 —
   * a floor at 95% must still let the lap go again.
   *
   * The arithmetic itself is `resumeAtHealth` in `src/shared/config.ts`, and
   * moved there when a plain **route** started stopping for the same pair
   * (2026-09-02): two things travel now, and two copies of one rule agree only
   * until one of them is edited.
   */
  private resumeAt(): number {
    return resumeAtHealth(this.health, tuning().loop.resumeMarginWhenUncapped);
  }

  private publish(): void {
    this.events.progress?.(this.progress);
  }

  private step(): void {
    const loop = this.loop;
    if (!loop) return;
    const was = this.index;
    const next = nextStop(loop, this.index, this.forward);
    this.index = next.index;
    this.forward = next.forward;
    // A lap is the list run through once, however it is walked.
    if ((loop.bounce && was === loop.stops.length - 1) || (!loop.bounce && next.index === 0)) {
      this.laps += 1;
    }
    this.publish();
    this.advance(false);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private fail(why: string): string {
    this.failures += 1;
    if (this.failures >= tuning().loop.maxFailures) {
      this.stop(why);
      return why;
    }
    // Try the stop after this one: a loop with one unreachable room is still
    // a loop round the others.
    this.step();
    return why;
  }

  /**
   * The stops left in this lap, from the one being walked to, as rooms.
   *
   * A lap is the list run through once, however it is walked — the same
   * sentence `step` counts laps by — so a plain loop's remainder is the tail
   * of the list and a bounce loop's is whichever end it is heading for. It
   * stops at the end of the lap rather than running on round the next one: a
   * stop marked twice on one map would say nothing about which visit is
   * owed, and the lap boundary is the honest place to stop counting.
   *
   * Stops the realm could not place drop out, because a room that is not
   * known is not a room the map can mark.
   */
  private remainingStops(): RoomId[] {
    const loop = this.loop;
    if (!loop || this.status === 'idle' || this.status === 'stopped') return [];
    const ahead =
      loop.bounce && !this.forward
        ? // Walking back down the list: this stop, then the ones before it.
          this.stopRooms.slice(0, this.index + 1).reverse()
        : this.stopRooms.slice(this.index);
    return ahead.filter((room): room is RoomId => room !== null);
  }

  /** The stop the character is standing in, else the first. */
  private nearestStop(): number {
    const loop = this.loop;
    if (!loop) return 0;
    const at = loop.stops.findIndex((stop) => this.planner.here(splitStop(stop)));
    return at === -1 ? 0 : at;
  }
}
