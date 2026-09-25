/**
 * Walking a planned route, one verified step at a time.
 *
 * Phase 4 planned routes and deliberately stopped there: executing a plan is an
 * *outbound* action, and outbound belongs to the arbiter
 * (docs/legacy-assessment.md §6). This is the piece that was missing, and it
 * proposes to the queue like everything else — nothing here touches a socket.
 *
 * ## One step outstanding, always
 *
 * The obvious implementation enqueues every step at once and lets the queue
 * pace them. That throws away the only property that makes a client-side queue
 * worth having: a sent command cannot be recalled, so forty movement commands
 * on the wire are forty decisions that can no longer be revised. Worse, they
 * are *unconditional* — the third step is sent whether or not the second one
 * worked, and one closed door desynchronises the entire route while the client
 * keeps confidently sending directions from a room it is not standing in.
 *
 * So: send one, confirm where it landed, then send the next.
 *
 * ## Confirmation, not optimism
 *
 * The realm data already says where each exit leads, and room resolution by
 * movement is the strongest signal the client has (`resolve.ts`, 0.98). A step
 * is complete when the room the client resolves to is the room the route
 * predicted. Anything else stops the walk:
 *
 * - **The wrong room.** Something moved us that we did not do.
 * - **No idea which room.** "Never guess a location" — a walk that continues
 *   from a guess is a pathfinder sending commands into the dark.
 * - **`direction-failed`.** The game said so outright: no exit that way, or a
 *   door that is shut.
 * - **The player typed.** They took the wheel.
 *
 * Every one of these ends the walk with a reason rather than retrying. A route
 * that has gone wrong is not repaired by sending the same direction again; it
 * is repaired by planning a new one from where the character actually is.
 *
 * ## Combat is a hold, not one of those
 *
 * Walking *through* a fight is how a character dies at a keyboard nobody is
 * sitting at, so the step still waits. But a fight is not the route going
 * wrong — on a realm whose corridors are full of wandering monsters it is what
 * an ordinary journey is made of, and ending the route at the first one left
 * the character standing in a sewer until a person noticed and asked again
 * (`Holds.holdForFight`, with the capture). So the route stands still, keeps its
 * destination, and when the fight is over plans again from wherever it left
 * the character — which is the same repair as above, applied without needing a
 * human to ask for it.
 *
 * A walk that somebody *else* decides about — a loop's leg, a retreat — says
 * `resumeAfterFight: false` and still ends, because those two already answer
 * the question and two answers to one question disagree the moment one is
 * edited.
 */
import type { WalkHold, WalkProgress, WalkStatus } from '../../shared/walk';
import { portalLeftUnseen } from '../../shared/walk';
import {
  roomAddress,
  type RoomId,
  type Route,
  type RouteStep,
  asRoomReference
} from '../../shared/world';
import type { Block } from '../../shared/blocks';
import { REREAD_ROOM } from '../../shared/commands';
import { isBlinding, type CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import { t } from '../app/i18n';
import type { CommandQueue } from './CommandQueue';
import { countMobs } from './RuleEngine';
import { tuning } from '../app/tuning';
import type { SessionModule } from './Module';
import { WalkClock } from './walk/clock';
import type { WalkerEvents, WalkInFlight } from './walk/ports';
import { Holds } from './walk/Holds';
import { Levers } from './walk/Levers';
import { Barriers } from './walk/Barriers';

/**
 * The nudge's coalesce key — by intent, so a walk cannot queue two of them.
 *
 * Never by command text: the nudge *is* an empty command, and the queue's own
 * rule is that text-matching de-duplication is what made `megamind-client`
 * exempt every direction from its damper.
 */
const NUDGE_KEY = 'walk:nudge';

export class Walker implements SessionModule {
  private route: Route | null = null;
  private index = 0;
  /**
   * Steps confirmed on *this journey* before the plan being walked now
   * (todo 03).
   *
   * `index` is the current plan's own count and it resets every time the
   * route is redrawn — a fight, a scatter, a door, a lever errand — so a
   * ninety-five step walk to the Bank of Khazard reported `2 of 15` after the
   * first monster, which is the leg's arithmetic and not the journey's. This
   * is the part of the journey the current plan no longer holds, added back
   * at both ends of the fraction. Reset only by `start`, which is the one
   * place a *new* journey begins.
   */
  private walked = 0;
  private status: WalkStatus = 'idle';
  private reason: string | null = null;
  /** Consecutive quarry holds at the current step; bounded so nothing pins a walk. */
  private quarryHolds = 0;
  /**
   * Whether the room the step in flight is leaving held a monster.
   *
   * The one fact that says a follower is possible, and it cannot be read off
   * the room the character lands in: the server computes the follow inside the
   * move and writes the arrival sentences *after* the room block
   * (`settleForFollowers`). Kept from the last state seen in the departure
   * room rather than from the state the step was sent against, because a
   * monster that charges in while the step is on the wire is the case this
   * exists for — five saracens did exactly that, 1.3 seconds after `e` had
   * gone out and 0.8 seconds before the room the client walked them into.
   */
  private leftMobsBehind = false;
  /**
   * The spent light this walker has already spoken about, or null.
   *
   * A fact about the pack, so it is said once and not once per dark step — see
   * `warnBeforeDark`. Cleared when the answer changes, and on a new connection.
   */
  private warnedLight: string | null = null;
  /**
   * How long the step now outstanding has waited to reach the wire, counting
   * only the beats the arbiter was free to send it — see `waitForSend`.
   */
  private waitedToSend = 0;
  /**
   * Whether the step now outstanding has actually reached the wire.
   *
   * The arbiter may send it inside `enqueue` or minutes later, and the two
   * waits mean different things — see `waitForSend`. Written by the intent's
   * own `onSent`, so a step sent synchronously does not have its answer
   * deadline overwritten by the send deadline `sendCurrent` would arm behind
   * it.
   */
  private stepSent = false;
  /**
   * When this step spent its one *where am I* on the realm, or null.
   *
   * A moment rather than a flag, because asking is only half of it: the
   * client has to **wait** for the answer. Measured on the wire 2026-09-14 —
   * the walk asked, said so, and the very next status line fell through to
   * *I can no longer tell which room you are in* and stopped the journey,
   * before `rm` had been answered. The lap's own locate has always waited
   * (`LoopRunner.retryAfterLocate`); this had nothing.
   *
   * Cleared with every send, because it is a property of the step.
   */
  private askedWhereAt: number | null = null;
  /**
   * When the step now outstanding reached the wire, or null.
   *
   * One end of the only measurement this walker takes — see `noteAnswered`.
   * Cleared when the step is answered, and whenever a walk ends without one:
   * a timestamp left over from a step nobody is walking any more would be
   * measured against the next arrival and record a wait that never happened.
   */
  private stepSentAt: number | null = null;
  /**
   * How long this realm has actually taken to answer a move, newest last, at
   * most `walk.nudgeSamples` of them.
   *
   * **The nudge deadline is a measurement, not a claim.** It was a flat
   * second, on the reasoning that "a move that landed is answered in well
   * under a second" — which is a fact about one realm written down as a fact
   * about every realm. Paradigm answers a move in a median 1,239ms (measured
   * over 22 uninterrupted town steps in
   * `logs/2026-09-02_21-04-28_festus.mudcap.jsonl`; p25 1,228, p90 1,250 —
   * the server's movement round, tight enough to be a constant of it). Every
   * normal step was therefore late by 240ms, the fallback fired on all of
   * them, and the bare Enter it sends is answered with a **full reprint of
   * the room** — so the console showed every room twice for the whole lap,
   * and each step spent a second command out of the budget the fighting is
   * done from.
   *
   * Kept per connection rather than per walk: the realm does not change
   * between two routes, and starting from nothing again would put the same
   * spurious Enter on the wire at the top of every one. `reset()` clears it,
   * because that is a new connection and possibly a different server.
   */
  private answers: number[] = [];
  /** Whether *Stealth 0, not sneaking* has been said this session. */
  private saidNoStealth = false;
  /**
   * Whether this walk is owed back after the connection is lost and regained.
   *
   * True for a route the **player** asked for, for `resumeAfterFight`'s
   * reason: it is the one walk with nobody else holding its destination. A
   * loop's leg, an errand's walk and a retreat's walk home are each planned
   * again by what asked for them, so they opt out — `journey` answers null for
   * them, and `SessionManager` picks up only what it is handed.
   */
  private resumeAfterLoss = true;
  /**
   * Whether every re-plan of this walk is by distance alone: a lap's leg
   * (`LoopRunner`), whose route is always the shortest way to the next stop.
   * See `mudengine-automation` › *A lap walks the shortest way*.
   */
  private shortest = false;
  /*
   * There was a `recent` here — the last few steps *this walker* confirmed —
   * and it is gone with its only reader, `retreatFrom`.
   *
   * It could not answer *where did we come from*, and the reason is worth
   * keeping: the step that matters is the one taken as a fight starts, and a
   * fight starting is exactly what calls `stop()` before the room arrives, so
   * the newest entry pointed at the room the character had left. The escape
   * reported *no confirmed step to retrace* while standing where it had walked
   * itself. `CharacterTracker.trail` records every move whoever caused it, and
   * `TrailStep` carries the capture.
   */
  /**
   * True while the walk in progress is one something else is narrating.
   *
   * A loop's legs are not news. The loop already says what it is doing — which
   * loop, which stop, why it skipped one, why it stopped — and the walker
   * saying `Walking 1 step to Newhaven, Narrow Road.` and `Arrived at
   * Newhaven, Narrow Road.` under it puts two lines of chrome between every
   * pair of the game's own, twice a stop, all evening. A player looping is not
   * navigating; they are watching a fight happen in a room they already chose.
   *
   * Set from `start`, so it is a property of *this walk* rather than a
   * question the walker asks about loops — the walker knows nothing about
   * loops, which is what keeps a plain walk a plain walk. A route planned from
   * the palette is loud, because there the walk *is* the thing that happened.
   *
   * Quiet is about the console and never about the fact: `progress` still
   * carries the destination, the step and the reason for the card to draw, and
   * `ended` still reaches whoever is walking because of something else. The
   * same distinction `stop`'s own `quiet` already makes for combat.
   */
  private quiet = false;
  /**
   * Whether this walk is a journey the player asked for. See
   * `WalkProgress.asked`, which is this published.
   *
   * Its own flag rather than `!quiet`, though the two agree for the loop's leg
   * and the errand: the walk home from a `safe-haven` retreat is announced —
   * running away is exactly the thing that has to be said out loud — and is
   * still nothing anybody asked for.
   */
  private asked = true;

  /** The step's deadline and the hold's re-ask: see `WalkClock`. */
  private readonly clock = new WalkClock();
  /** The holds, and the one-deep slot they share. */
  private readonly holds: Holds;
  /** The lever errand. */
  private readonly levers: Levers;
  /** The barrier ladder and the search for a hidden exit. */
  private readonly barriers: Barriers;

  constructor(
    private config: AutomationConfig,
    private readonly queue: CommandQueue,
    private readonly events: WalkerEvents = {}
  ) {
    const inFlight: WalkInFlight = {
      walking: () => this.walking,
      quiet: () => this.quiet,
      step: () => this.route?.steps[this.index],
      publish: () => this.publish(),
      stop: (reason) => this.stop(reason),
      stepAgain: () => this.sendCurrent(false)
    };
    this.holds = new Holds(
      config,
      events,
      {
        ...inFlight,
        retryAfter: (ms, state) => this.retryAfter(ms, state),
        recheck: (state) => this.onCharacter(state),
        carryOn: (state) => this.carryOn(state),
        onward: (state, here) => this.onward(state, here),
        cancelQueued: () => this.cancelQueued()
      },
      this.clock
    );
    this.levers = new Levers(queue, events, {
      ...inFlight,
      shortest: () => this.shortest,
      destination: () => this.route?.steps.at(-1),
      detour: (route, state) => this.detour(route, state)
    });
    this.barriers = new Barriers(
      config,
      queue,
      events,
      {
        ...inFlight,
        retry: (state, fresh) => this.retry(state, fresh),
        dispatch: (step, command, reason, onSent) => this.dispatch(step, command, reason, onSent),
        onWire: (step) => this.onWire(step),
        nudgeAfter: () => this.nudgeAfter(),
        reprint: (reason) => this.reprint(reason)
      },
      this.clock,
      this.holds,
      this.levers
    );
  }

  configure(config: AutomationConfig): void {
    this.config = config;
    this.holds.configure(config);
    this.barriers.configure(config);
  }

  /** Whether a route is being walked right now. */
  get walking(): boolean {
    return this.status === 'walking';
  }

  /**
   * Where this walk still owes the player, or null.
   *
   * Read by `SessionManager` at the moment a socket is lost, before the walk
   * is stopped: the room and the name the route ends in, for a walk somebody
   * will not plan again themselves (`resumeAfterLoss`). A walk that is not in
   * progress owes nothing — a stopped route is a plan the client is no longer
   * following, and picking that one back up would walk a journey the player
   * had already watched end.
   */
  get journey(): { to: RoomId; name: string } | null {
    if (this.status !== 'walking' || !this.resumeAfterLoss) return null;
    const last = this.route?.steps.at(-1);
    return last === undefined ? null : { to: last.to, name: last.name };
  }

  /**
   * The route this walk stopped part-way through, for the player to pick back
   * up. Null while it is walking, once it has arrived, and before anything has
   * been walked at all.
   *
   * `stop` deliberately keeps the route it was walking — that is what makes a
   * stop *a pause that may or may not be permanent* — so everything needed to
   * resume is already here: where it was going, and `left`, the steps it still
   * owed when it stopped. `SessionManager.startMoving` plans afresh from
   * wherever the character now stands and compares the two, which is how *you
   * have wandered a long way from this route* is measured without a second
   * copy of the route being kept anywhere.
   *
   * Unlike `journey` this ignores `resumeAfterLoss`: that flag is about what
   * the *client* picks back up unasked across a dropped socket, and this is
   * somebody pressing play.
   */
  get unfinished(): { to: RoomId; name: string; left: number } | null {
    if (this.status !== 'stopped' || this.route === null) return null;
    const last = this.route.steps.at(-1);
    if (last === undefined) return null;
    return { to: last.to, name: last.name, left: this.route.steps.length - this.index };
  }

  get progress(): WalkProgress {
    const step = this.route?.steps[this.index] ?? null;
    const last = this.route?.steps.at(-1) ?? null;
    /*
     * The rooms still to travel, for the map to draw the route with.
     *
     * `from` of the step being attempted is where the character is standing —
     * the index only advances on a *confirmed* step — so it is the anchor the
     * line is drawn out of, and every `to` after it is a room not yet entered.
     * Sliced from `index`, which is what takes a room off the drawing as it is
     * walked rather than the renderer having to work out which are behind.
     */
    const ahead = this.status === 'walking' ? (this.route?.steps.slice(this.index) ?? []) : [];
    return {
      status: this.status,
      // An idle walker has walked nothing to be wrong about, and a stopped leg
      // must not be read as a stopped route: see `movementOf`.
      asked: this.status === 'idle' ? true : this.asked,
      // The journey's, not this plan's: `walked` is what the redrawn
      // plans before this one already covered. See the field.
      done: this.walked + this.index,
      total: this.walked + (this.route?.steps.length ?? 0),
      /*
       * The same journey the map draws, in words. The step at `index` is the
       * one being attempted, so its room is the *next* one entered and every
       * `to` after it is further ahead — which is exactly the list a reader
       * wants and exactly what `ahead` above is already sliced to.
       */
      ahead: ahead.map((entry) => entry.name),
      destination: last?.name ?? null,
      // No route is stated as null, not laundered through a parser's refusal.
      destinationRoom: last === null ? null : asRoomReference(last.to),
      step:
        this.status === 'walking' && step
          ? {
              command: step.command,
              name: step.name,
              /*
               * The realm's own instruction was what this said — `Toll: 5`,
               * `Key: 1124`, a number with no unit and an id with no name. The
               * composed obstacle is the same fact in words a player can act
               * on, and it is what the route panel and the map both show, so
               * the three cannot disagree about one door.
               */
              note: step.obstacle?.label ?? step.requirement?.raw ?? null,
              to: asRoomReference(step.to)
            }
          : null,
      path: ahead.length === 0 ? [] : [ahead[0]!.from, ...ahead.map((leg) => leg.to)],
      reason: this.reason,
      // A hold only means anything while the walk is still running: a stopped
      // walk that reported one would be drawn as recovering rather than ended.
      hold: this.holding
    };
  }

  /**
   * Why the walk is waiting, or null when it is moving or not walking at all.
   *
   * Read by `SessionManager.mayRest`, which is the whole point of publishing
   * it: a walk that is standing still for health must let `Recovery` sit the
   * character down, and a walk that is *marching* must not — those two were
   * one condition (`walker.walking`) until a route learned to wait.
   *
   * A `fight` hold answers the same way, and it is the one that matters most
   * often: the fight ends, the character is standing in the room it was won
   * in, and the health hold underneath has not been reached yet because the
   * status line has not arrived. Refusing the rest there would put the route
   * back to marching at whatever health the fight left it.
   */
  get holding(): WalkHold {
    return this.walking ? this.holds.current : null;
  }

  /**
   * The hit points the walk is resting towards before the trap ahead, or
   * null when it is not standing still for one. `Recovery.needAtLeast` reads
   * it, so the rest that ends this hold is proposed by the module that owns
   * resting rather than by a second `rest` sender.
   */
  get restingFor(): number | null {
    return this.walking ? this.holds.restingFor : null;
  }

  /**
   * Begins a walk. Returns the reason it could not start, or null.
   *
   * A blocked route is refused rather than half-walked: its steps lead
   * somewhere the pathfinder already said it could not reach, so walking the
   * prefix strands the character partway with no plan.
   *
   * `quiet` is for a caller that narrates the walk itself — a loop. See the
   * field: the progress, the destination and `ended` are unaffected; only the
   * lines this walker would have written into the console are.
   *
   * `holdWhenHurt` is on for a route the **player** asked for, which is the
   * only walk with nobody else deciding whether the character is fit to make
   * it. The two that turn it off each have their own reason and say so at the
   * call site:
   *
   * - A **`safe-haven` retreat** exists *because* the character is hurt.
   *   Holding it leaves a bleeding character in the open beside the lair it
   *   just run from, which is worse than every step of the journey.
   * - A **loop's leg** is held by `LoopRunner`, off the same two thresholds
   *   and with its own `health` hold to report it. Deciding it here as well
   *   would be two halves of one gate in two files, which agree exactly until
   *   one of them is edited — `AutoCombat.quarry`'s own lesson. It was caught
   *   by `npm run smoke`, whose fixture runs a loop at 98/400: the leg was
   *   held here, the lap never took its first step, and the loop's own hold
   *   would have been the thing to fix if that were the real complaint.
   *
   * `resumeAfterFight` is on for the same walk and for the same reason. A
   * fight used to **end** a route, which meant a journey across a realm whose
   * corridors are full of wandering monsters ended at the first one: the
   * character stood where the fight left it until a person noticed and asked
   * for the route again. Measured
   * (`logs/2026-09-02_16-54-23_festus.mudcap.jsonl`): `Walking 21 steps to
   * Bank of Godfrey`, two steps walked, a nasty giant rat, and then **140
   * seconds in which this client sent nothing at all**, ended by the player
   * typing an Enter by hand. A loop already waited a fight out and planned
   * again; a route the player asked for is a journey with a destination in it,
   * and there is no reason for the two to differ. The two callers that turn it
   * off are the two that already answer the question:
   *
   * - A **`safe-haven` retreat** is a walk *away from* a fight. Standing still
   *   until it is over is the opposite of what it is for.
   * - A **loop's leg**, which `LoopRunner` waits out itself and then replans
   *   from whichever room the fight left the character in — reading `ended`
   *   to know the leg is over. Holding here instead would mean `ended` never
   *   fires and the lap never takes another step.
   *
   * Named options rather than positional booleans from the moment there were
   * two, because `start(route, state, true)` no longer said which.
   */
  start(
    route: Route,
    from: CharacterState,
    {
      quiet = false,
      asked = true,
      holdWhenHurt = true,
      resumeAfterFight = true,
      whileFighting = true,
      resumeAfterLoss = true,
      shortest = false
    }: {
      quiet?: boolean;
      asked?: boolean;
      holdWhenHurt?: boolean;
      resumeAfterFight?: boolean;
      whileFighting?: boolean;
      resumeAfterLoss?: boolean;
      shortest?: boolean;
    } = {}
  ): string | null {
    if (!this.config.enabled) return t('automation.walk.refusalDisabled');
    if (route.blocked) return route.reason ?? t('automation.walk.refusalNoRoute');
    if (route.steps.length === 0) return t('automation.walk.alreadyThere');
    /*
     * A move this client sent has not been answered, so the room on the books
     * is the one the character is *leaving* and this route was planned from
     * it. Its first step is therefore the move already on the wire, sent a
     * second time — and from then on the server's answer to the first is read
     * as the answer to the second.
     *
     * Measured 2026-08-30 (`logs/2026-08-30_17-00-14_main.mudcap.jsonl`): a
     * fight ended while a loop's `ne` was still unanswered, the loop replanned
     * from the room it had left, sent `ne` again, and the `There is no exit in
     * that direction!` that earned was booked against the `se` behind it —
     * striking a real corridor out of every route for the rest of the session
     * and, two stops later, ending the loop.
     *
     * `considerRetreat` already refuses to plan across this window by waiting
     * for the room to change; this is the same refusal made from the fact
     * itself rather than from a clock.
     */
    if ((this.movesInFlight() ?? 0) > 0) return t('automation.walk.refusalMoveInFlight');
    /*
     * A fight is already running — and whether that stops the walk depends
     * entirely on **who asked**.
     *
     * The refusal was written for a loop, and the capture behind it is a loop:
     * 2026-09-01, a lap started in a room with two monsters swinging, sent its
     * opening `n` mid-round, and the character walked out over the coins its
     * own kill dropped a moment later, spending the loot commands in the wrong
     * room. Nothing chose that; automation did, and automation can wait — so a
     * loop still opts in here (`whileFighting: false`), and still reads this
     * exact string to tell "the fight guard lost a race with the wire" from
     * "this stop cannot be reached".
     *
     * A **route the player planned and pressed Walk on** is the opposite case
     * and had the same answer, which is what was reported: *"when I navigate,
     * just navigate — I am the controller, I told you so."* The panel already
     * says the character is fighting, the person read it and asked anyway, and
     * walking out of a room is not a dubious thing to want — on this realm it
     * is the **only** way to break combat, and the client's own retreat does it
     * unasked. Refusing there was the client overruling the one decision it is
     * not entitled to overrule.
     *
     * **That is still true of the refusal and no longer true of the step**
     * (2026-09-06). The walk always *starts*; whether its first step goes out
     * over a live fight is `Holds.leavingAFight`'s question further down, and the
     * answer now depends on whether anything this client runs would end that
     * fight. Walking out is the escape for a character that will not fight;
     * for one whose journey is fighting on the way (todo 00), it
     * was the client overruling the other decision it is not entitled to
     * overrule. Both readings are the player's own configuration, so neither
     * is guessed at.
     *
     * The quarry hold below is no cover for either case: engagement correctly
     * answers "already fighting" while a target is live, which makes that hold
     * transparent in exactly this window.
     *
     * **Anything swinging, not only the server's flag** (2026-09-04). This read
     * `from.inCombat`, and a loop's leg was planned the moment `*Combat Off*`
     * arrived for a kill in a room that still held the *other* monster — one
     * that had been biting the whole fight and bit again on the very next line
     * (`logs/2026-09-04_00-05-40_festus.mudcap.jsonl`, t=452664: `You gain
     * 100 experience.`, `*Combat Off*`, `The big carrion beast snaps at you`,
     * a millisecond apart). The flag was down and the beast was in
     * `attackers`, so the leg started, `Holds.leavingAFight` read the same state as
     * *asked to leave this fight* and stood the fight branch of `onCharacter`
     * down, the quarry hold held for its 1,500ms, and the re-ask then found a
     * live target — "already fighting", no quarry — and sent `e` out of the
     * fight at t=454167. `fightIsRunning` is the walk's own definition of a
     * fight everywhere else in this class; the refusal now reads it too.
     */
    if (!whileFighting && fightIsRunning(from)) return t('automation.walk.refusalInCombat');

    const here = roomAddress(from.room);
    if (here === null) {
      // Starting from an unknown room means the first step is a guess about
      // which exit we are taking, and every step after it inherits that guess.
      return t('automation.walk.refusalUnknownStart');
    }
    if (here !== route.steps[0]!.from) {
      return t('automation.walk.refusalStaleRoute');
    }

    /*
     * Replacing a walk that is still running — a `safe-haven` retreat over a
     * route held for a fight, in practice, which only became possible when a
     * fight stopped ending a route. Two things follow from it:
     *
     * - **The timers are this walker's**, so the replaced walk's re-ask would
     *   otherwise wake the *new* one for a decision about the old.
     * - **It is said**, because the journey the player asked for has just been
     *   dropped and the console would otherwise only ever mention the one that
     *   replaced it. Silent for a walk nobody was told about in the first
     *   place — a loop's leg — which is what `this.quiet` still means here.
     *
     * `ended` is deliberately *not* raised: `LoopRunner` reads it, and a leg
     * booked as failed for a walk that was superseded rather than stopped
     * would skip a stop nothing went wrong at.
     */
    if (this.status === 'walking') {
      this.clock.clear();
      const dropped = this.route?.steps.at(-1)?.name;
      if (!this.quiet && dropped !== undefined) {
        this.events.notice?.(t('automation.walk.superseded', { destination: dropped }));
      }
    }

    this.route = route;
    this.index = 0;
    this.walked = 0;
    this.reason = null;
    this.status = 'walking';
    // A fresh walk gets the whole patience. `quarryHolds` is otherwise only
    // cleared by a confirmed step, so a route that ended mid-hold — which is
    // what combat does to a loop's leg — would leave the next one starting
    // with the budget already spent and its first step unheld.
    this.quarryHolds = 0;
    // And the room behind is the last walk's, not this one's: `sendCurrent`
    // reads it again from the state this route is planned from.
    this.leftMobsBehind = false;
    /*
     * A door another walk found locked says nothing about this one's, which
     * may not even pass the same room — and the errand belongs to the journey
     * that was interrupted, which this replaces.
     */
    this.barriers.passed();
    this.levers.begin();
    // No step of this walk is on the wire any more, whatever was when it ended.
    this.stepSent = false;
    // After the refusals, so a walk that was declined does not leave the next
    // one — which may be a plain one — inheriting this one's silence.
    this.quiet = quiet;
    this.asked = asked;
    this.resumeAfterLoss = resumeAfterLoss;
    this.shortest = shortest;
    /*
     * Asked for while a fight was running, so this walk's job is to leave it —
     * **but only when leaving is what ends the fight**.
     *
     * Without the exemption at all, the refusal above would simply have become
     * a *hold*: the very next status line would put the route in a `fight`
     * hold and it would stand still until the fight was over — the same
     * standing still, now silent, which is worse than the refusal it replaced.
     * That is the whole argument for it, and it holds exactly as far as
     * `Holds.canEndAFight` says nothing else will: on this realm walking out of the
     * room is the only way to break combat, so for a character that will not
     * fight and will not retreat, the step *is* the escape and standing still
     * is standing there being beaten.
     *
     * **A character that fights is the opposite case, and had the same
     * answer** (2026-09-06). Reported as *"the automation when walking just
     * decided to not finish attacking even though auto combat is on — auto
     * combat should always clear the room before moving on"*, and measured
     * (`logs/2026-09-06_11-19-43_festus.mudcap.jsonl`): auto-combat sent `aa
     * big skeleton` at t=7634, `*Combat Engaged*` came back at t=7703, and the
     * route's opening `n` went out at t=7916 — 213ms later, over a monster the
     * client had just re-engaged and was two rounds from killing, on a profile
     * with `combat.enabled` **and `retaliate` both on**, and a route that
     * fights on the way; every one of them says *finish fights while walking*
     * and this one line overrode the lot.
     *
     * `AutoCombat.quarry` already asks the journey override for precisely this —
     * the walker holds a step out of a room engagement would open on — but
     * that path sits *below* this flag in `holdBeforeSending`, so it was never
     * asked. `Holds.canEndAFight` is the predicate that was missing, and it is the
     * one `Holds.answerFight` already uses for the mirror case: a hold whose reason
     * is *withdrawn* mid-fight walks on. This is that sentence read forwards.
     *
     * **`resumeAfterFight` is the other half, and the retreat is why.** A walk
     * that does not hold for fights answers one by *stopping* (`Holds.answerFight`),
     * so a `safe-haven` escape — `resumeAfterFight: false`, `whileFighting`
     * left at the player's default — would have stopped itself on the very
     * fight it was planned to run from. A walk that will not wait one out is
     * always leaving one.
     *
     * It covers **the fight that was running when it was asked for and no
     * other**. A monster wandering into a corridor twelve steps later is a
     * fight nobody asked about, and holding for that one is the behaviour a
     * separate report asked for (see `Holds.holdForFight`): a route abandoned two
     * steps into twenty-one, in a sewer, for the ordinary reason a sewer
     * exists. Cleared the first moment nothing is fighting, which is precise
     * and needs no clock — `state.inCombat` outlives an escape by a measured
     * median of 3,493ms, so a step that got the character away still reads as
     * fighting for about three seconds, and that window is exactly the one
     * this must not stop in.
     */
    this.holds.begin({ holdWhenHurt, resumeAfterFight }, fightIsRunning(from));
    const stepCount = route.steps.length;
    const arrival = route.steps.at(-1)!;
    const destination = arrival.name;
    if (!quiet) {
      this.events.notice?.(
        stepCount === 1
          ? t('automation.walk.started.one', { stepCount, destination })
          : t('automation.walk.started.many', { stepCount, destination })
      );
    }
    // After the refusals above, so a walk that was declined is not written down
    // as a place this character went: every `return` before this point is the
    // walk not happening.
    this.events.destination?.(arrival.to, destination);

    /*
     * A resting character is walked, and nothing is sent to stand it up.
     *
     * This used to spend a `l` first and announce it. Two things were wrong
     * with that: a look does not break a rest (2026-08-27 — see `Recovery`), so
     * the command bought nothing; and moving *does*, so the first step of the
     * route ends the rest by itself. The command it spent was for a state that
     * stops nothing anyway.
     *
     * Nothing is said out loud either, because nothing is done — the rest ends
     * as a side effect of the walk the player asked for, and a notice about it
     * would be the client narrating the game's own rules.
     */
    /*
     * And the same beat the *middle* of a route already took, before the first
     * step of a new one — because the room a route is planned from is the room
     * the character is standing in, which is exactly where engagement fires.
     *
     * This was the one place `holdAt` was never asked, and it is the place a
     * loop lands every time: `Walker` stops when a fight starts, the loop waits
     * it out and plans **a fresh route** from where the character is standing,
     * and `start` sent its first step unheld. Captured 2026-09-01 — a room with
     * `big thug, thug` in it, the first killed, and then, off one status line,
     * `a thug` (combat band) and `e` (movement band) queued together and both
     * on the wire inside the 350ms gap. The server engaged the second thug and
     * the character walked out of the fight it had just opened, leaving a live
     * monster and the experience behind.
     *
     * Cancelling the step after the fact cannot fix that: `*Combat Engaged*`
     * arrives after the move has gone, and a sent command cannot be recalled.
     * Not stepping out of a room that still holds a quarry is the only place
     * the decision is still revisable.
     */
    if (this.holdBeforeSending(from)) return null;
    this.sendCurrent(true, from);
    return null;
  }

  /** Ends the walk. Safe to call when not walking. */
  stop(reason: string, quiet = false): void {
    if (this.status !== 'walking') return;
    this.clock.clear();
    // The outstanding step is not going to be answered as this step any more,
    // so the clock it was being timed against goes with it. See `answers`.
    this.stepSentAt = null;
    this.cancelQueued();
    this.status = 'stopped';
    this.reason = reason;
    // The errand dies with the journey it was for: `start` clears it too, and
    // both are here because a stopped walk that is never restarted must leave
    // nothing armed.
    this.levers.drop();
    // `this.quiet` is the whole walk's silence and `quiet` is this stop's; a
    // loop's leg ending is already reported by the loop, which says what it
    // decided to do about it rather than merely that a walk ended.
    if (!quiet && !this.quiet) this.events.notice?.(t('automation.walk.stopped', { reason }));
    // Quiet or not, whoever walks *because of* something else must hear it end.
    this.events.ended?.(false, reason);
    this.publish();
  }

  /** A new connection: forget everything. */
  reset(): void {
    this.answers = [];
    this.stepSentAt = null;
    this.clock.clear();
    this.route = null;
    this.index = 0;
    // And the journey's own counter with it: `walked` survives a redrawn plan
    // by design, so a reconnect that did not clear it published a finished
    // journey — `done: 20, total: 20` — for a walker walking nothing.
    this.walked = 0;
    this.status = 'idle';
    this.reason = null;
    this.asked = true;
    this.stepSent = false;
    this.leftMobsBehind = false;
    this.quiet = false;
    this.resumeAfterLoss = true;
    this.shortest = false;
    this.warnedLight = null;
    /*
     * The units, in the order their fields were cleared here before todo 740
     * carved them out: the holds, then the barrier, then the lever errand.
     */
    this.holds.reset();
    this.barriers.reset();
    this.levers.reset();
    this.publish();
  }

  dispose(): void {
    this.clock.dispose();
  }

  /**
   * The player moved the character themselves, and the room proved it.
   *
   * The walk ends. The player outranks automation, and a walk that keeps
   * steering while someone is steering too is two drivers with one wheel — the
   * desynchronisation it causes surfaces several rooms later as a route that
   * mysteriously went wrong.
   *
   * **A landed move, not a keystroke.** This used to fire on every command the
   * player typed, so checking a stat sheet mid-lap (`st`) ended the loop with
   * `Manually stopped` and nothing about it said which of the two had happened.
   * Typing is not taking the wheel: `l`, `st`, `exp`, a `say` and a direction
   * into a wall all leave the character exactly where the route left it.
   * `SessionManager` holds the typed direction until a room answers it and
   * calls this then — see its `playerMove`.
   */
  notePlayerMoved(): void {
    this.stop(t('automation.walk.reasonPlayerTookOver'));
  }

  /**
   * The character ran away. The journey is held, not ended — but it is not
   * walked straight on from either.
   *
   * `LoopRunner.noteEscaped` in the other walker caller, for the identical
   * measured reason: an escape leaves the character one room from what it ran
   * from, and the route's shortest path onward very often starts with the
   * reverse of the move that got away. Before a route could survive a fight at
   * all this was the loop's problem alone, because combat ended a plain route
   * before the escape could matter.
   *
   * Only for a walk that resumes. A haven walk and a loop's leg both say
   * `resumeAfterFight: false`, and a haven walk is a walk that exists *because*
   * of the escape — holding it is the one thing it must not do.
   */
  noteEscaped(): void {
    if (this.status !== 'walking') return;
    this.holds.noteEscaped();
  }

  /**
   * A classified block arrived. The refusals matter here, and so does every
   * answer to the walker's own attempts on a barrier in the way — each handed
   * to `Barriers`, whose header has the ladder.
   */
  onBlock(block: Block): void {
    if (this.status !== 'walking') return;

    /*
     * The character died, so the route is over and it is over for a *reason*.
     * Ahead of the fight guard below, because a death is exactly the case
     * where a fight was running: everything the walk would otherwise do next
     * goes out from a character standing in a temple it did not choose.
     *
     * Without this the walk still stopped — the temple is not the room the
     * route expected — but it stopped saying "you ended up somewhere the route
     * did not expect (Temple, Halls of the Dead)", which describes the symptom
     * of a death rather than the death. Somebody reading the record an hour
     * later has to work out from the room name what happened.
     */
    if (block.type === 'user-dies') {
      this.stop(t('automation.walk.reasonDied'));
      return;
    }

    /*
     * Every rung below answers the step in flight by **sending another
     * command** — `search`, `open`, a bash, a pick, the direction again — and
     * a movement command that reaches the wire mid-round walks the character
     * out of the fight it is standing in, which `cancelQueued` cannot recall
     * (`Holds.holdForFight`, and `start`'s own refusal, both state it).
     *
     * It is reachable exactly because a held walk is still `walking`. Found by
     * review and reproduced on stock settings: a step through one of the 249
     * `Hidden/Searchable` exits the router prices a search into, a wanderer
     * opening before the answer landed, and then `There is no exit in that
     * direction!` putting `search e` and `e` on the wire inside the round.
     *
     * Nothing is lost by ignoring it: the refusal is the answer to a step the
     * fight has already suspended, and `Holds.resumeFromFight` plans the whole leg
     * again from wherever the fight leaves the character — the same repair,
     * made once the character is free to make it.
     */
    if (this.holds.current === 'fight') return;
    this.holds.afterBlock();

    switch (block.type) {
      case 'direction-failed':
        this.barriers.onRefusedStep(block);
        return;
      case 'open-failed':
        this.barriers.onOpenRefused(block);
        return;
      // Each read only while the walk has that attempt of its own in flight:
      // see `Barriers.onForcingFailed`.
      case 'bash-failed':
        this.barriers.onForcingFailed('bash');
        return;
      case 'skill-failed':
        this.barriers.onForcingFailed('pick');
        return;
      case 'command-no-effect':
        this.barriers.onForcingFailed('key');
        return;
      case 'door-changed':
        this.barriers.onBarrierChanged(block);
        return;
      case 'user-search-succeeded':
      case 'user-search-failed':
        this.barriers.onSearchAnswered(block);
        return;
      case 'spell-onset': {
        // Only while this walk's own step is on the wire with nothing back —
        // see `Holds.onsetAnsweredStep`. An onset at any other moment is an effect
        // landing and refuses nothing.
        if (!this.stepSent) return;
        this.holds.noteOnset(block);
        return;
      }
      default:
        return;
    }
  }

  /** Moves sent and not yet answered, or null when nobody is counting. */
  private movesInFlight(): number | null {
    return this.events.pendingMoves?.() ?? null;
  }

  /**
   * Character state changed. This is where a step is confirmed.
   *
   * Called for every state change, most of which are not room changes, so the
   * cheap rejections come first.
   */
  onCharacter(state: CharacterState): void {
    // Kept whether or not a walk is running: see `Barriers.noteSkills`.
    this.barriers.noteSkills(state);

    if (this.status !== 'walking' || this.route === null) return;

    if (fightIsRunning(state)) {
      this.holds.fightGoesOn();
      /*
       * A route waits the fight out; a loop's leg and a retreat still end
       * here. See `start`'s `resumeAfterFight` for why those two differ, and
       * `Holds.holdForFight` for what waiting costs.
       *
       * When it *does* end, it is said out loud, and the per-stop `quiet` that
       * used to be here is gone (2026-09-02). The argument for silence was
       * that a fight starting is ordinary — on a loop it is the *point* — and
       * that is entirely true of a loop, whose leg is already silent through
       * `this.quiet`. So the flag was doing nothing except silencing the one
       * case where a fight ending a walk is news.
       *
       * The wording is `a fight started` rather than `you are in combat`
       * because a stop's reason outlives the fight by minutes and the second
       * one is false within seconds of being written — reported as *"we got
       * `*Combat Off*` but the route says you are in combat"*.
       *
       * The reason still reaches `ended`, which is what the loop reads: quiet
       * is about the console, never about the fact.
       *
       * **Except where this walk was asked for in order to leave this fight**,
       * in which case standing still is the one thing it must not do — see
       * `Holds.leavingAFight` in `start`.
       */
      /*
       * **A draw the client could not place asks before the fight holds.**
       *
       * One `rm` is what turns an unplaceable landing into a journey that
       * carries on, and the fight branch returns before the arrival check
       * where that ask lives — so a monster meeting the character on the
       * landing buried the question until `Holds.resumeFromFight`, which has no ask
       * of its own and gives up after `stepTimeoutMs`. The realm makes this
       * the ordinary case rather than the corner: all nine of spell 597's
       * padded cells hold a lair, share one name and share one exit
       * signature, so a draw into them is unplaceable by construction and
       * likely to be met by something.
       *
       * Ahead of the hold because it costs one probe-band command and changes
       * nothing about the fight: the character stands still either way, and
       * the answer is what the walk needs the moment the fight is over.
       */
      this.askWhereAfterDraw(state);
      // Under a timed spell a fight is walked out of, never waited out: the
      // spell is the deadline, and standing still for a round is drowning.
      if (!this.holds.leaving && this.events.moveOnly?.(state) !== true && this.holds.answerFight())
        return;
    } else {
      this.holds.nothingFighting();
    }

    /*
     * The fight this route stood still for is over. Pick the journey back up
     * from wherever it actually left the character — which is not necessarily
     * where it started, and the step-confirmation below would read a room the
     * character was chased into as the route having gone wrong.
     */
    if (this.holds.current === 'fight') {
      this.holds.resumeFromFight(state);
      return;
    }

    const step = this.route.steps[this.index];
    if (!step) return;

    /*
     * **An exit whose cast moves the character answers twice**, and the first
     * answer is the room the exit table names — a room it is in for no time at
     * all. Acting on it would replan from somewhere the spell is about to take
     * the character out of, and on a `teleports` step it would stop the walk
     * outright, because that room is not `step.to`.
     *
     * The second block is still on the wire, so the client's own move count is
     * the test — the same one `Holds.resumeFromFight` makes about a step it has not
     * seen answered. The step's deadline is armed underneath and stops the
     * walk if the second block never comes.
     */
    if (movesTwice(step) && (this.movesInFlight() ?? 0) > 0) return;

    const here = roomAddress(state.room);
    // Not resolved yet, or the same room the step started from: the move has
    // simply not landed. The timeout is what stops this waiting forever.
    if (here === null) {
      /*
       * Unless the step was a draw, in which case *the client cannot know* and
       * one command settles it. Asked once per step: `rm` states coordinates
       * outright, so a second ask would answer nothing a first did not, and
       * the step's own deadline is still armed underneath — a realm with no
       * locate word sends nothing and the walk stops as it did before.
       */
      if (this.askWhereAfterDraw(state)) return;
      if (state.room.ambiguous > 1) {
        this.stop(t('automation.walk.reasonAmbiguous'));
        return;
      }
      /*
       * A room the server would not describe, and dead reckoning could not
       * place either — the realm data disagreed that the destination is dark,
       * or there was no known room to reckon from.
       *
       * Stopped here rather than left to the deadline, which reported
       * `nothing came back after d` — a sentence that blames the server for a
       * silence that never happened. Plenty came back; it said the room was
       * dark.
       *
       * **Unless a light is coming**, which is the ordinary case and was
       * stopping the walk a tenth of a second before the fix arrived: see
       * `Holds.holdForLight`.
       */
      if (isBlinding(state.room.light)) {
        if (this.holds.holdForLight(state)) return;
        this.stop(t('automation.walk.reasonDarkUnresolved', { lightLevel: state.room.light }));
      }
      return;
    }
    /*
     * The room can be read again, so whatever the dark hold was waiting for
     * has arrived. Only its own hold, as every release here is.
     */
    this.holds.releaseDarkHold();
    if (here === step.from) {
      // Still where the step started, so this is the room anything that
      // follows will follow *out of* — read every time, because a monster can
      // walk in while the step is on the wire. See `settleForFollowers`.
      this.noteRoomBehind(state);
      return;
    }

    /*
     * A draw landed. **This is the step working, not the walk going wrong.**
     *
     * A scatter step is the last one a plan can hold (`RouteStep.scatter`), so
     * where the character is now is a fact nobody had until this moment — and
     * `here !== step.to` below, which is the guard against a route quietly
     * desynchronising, would read the realm doing exactly what the plan said
     * it would as the plan being wrong and stop the journey one step from the
     * old man's cell.
     *
     * So the journey is planned again from here, the same replan `onward`
     * makes after a fight moved the character, and for the same reason: the
     * steps ahead were directions from a room the character is not in. Landing
     * on the destination is an arrival, and is handled by the ordinary path
     * below because `step.to` *is* the destination on a scatter step.
     *
     * **And a gate the router said it could not read is the same fact in the
     * realm's other spelling** (2026-09-15). A room script states its landing
     * per branch — `9/1291`'s `go portal` goes to `9/1424` on `checkability
     * 133 5` and names no room at all on the two branches below it — and
     * `linkPortals` takes the landing it has, with the guard it cannot
     * evaluate on `Requirement.unread`. So a step whose condition failed puts
     * the character somewhere the plan never named, which is not the route
     * desynchronising: it is the one outcome the plan already admitted it
     * could not predict. Live, that was the Caves of Chaos, two maps from
     * `9/1424`, reported as *That is not where the route says you should be*.
     */
    if ((step.scatter !== undefined || unreadGate(step)) && here !== step.to) {
      this.stepAnswered();
      this.scattered(state, step, here);
      return;
    }

    if (here !== step.to) {
      this.stop(t('automation.walk.reasonWrongRoom', { roomName: state.room.name ?? here }));
      return;
    }

    const wasLeaving = this.stepAnswered();
    this.index += 1;
    if (this.index >= this.route.steps.length) {
      this.arrive(state, step.name);
      return;
    }

    this.warnBeforeDark(state);
    /*
     * And the fight is asked again here, because the exemption expired one
     * line ago and the branch that would have caught it ran while it was still
     * in force. Without this the walk sends its *second* step into the fight
     * as well — which in a corridor of back-to-back engagements, or behind a
     * monster that follows every room, is marching the whole route through
     * them: exactly what the exemption was scoped not to do.
     */
    if (wasLeaving && fightIsRunning(state) && this.holds.answerFight()) return;
    if (this.holdBeforeSending(state)) return;
    // And not under a timed spell, where `holdBeforeSending` has already
    // returned early for every other hold: the spell is the deadline, nothing
    // in there will fight what followed, and a third of a second a room is
    // a third of a second of held breath bought for no decision.
    if (this.events.moveOnly?.(state) !== true && this.settleForFollowers(state)) return;
    this.sendCurrent();
  }

  /**
   * A room answered the step in flight: the room it named, or a draw landing
   * somewhere else. Returns whether the walk was still leaving the fight it
   * was asked for in, which the landing ends (`Holds.landed`).
   */
  private stepAnswered(): boolean {
    this.clock.clear();
    // What this realm charges for a move, which is the only thing that can
    // say what "late" means on it. Taken here because this is the moment the
    // walk *knew* it had arrived, which is the quantity the deadline bounds.
    this.noteAnswered();
    /*
     * The answer arrived after all, so the Enter asking for one is a reprint
     * nobody needs — and an arriving room consumes the expectation queue, so
     * one landing behind the *next* step would be read as that step's arrival.
     * Recallable only while it is still queued, which is exactly why it is
     * dropped here rather than reasoned about later.
     */
    this.forgetNudge();
    // And the step is no longer on the wire, so an onset landing during
    // whatever hold follows is not read against it.
    this.stepSent = false;
    this.quarryHolds = 0;
    this.barriers.passed();
    this.levers.landed();
    return this.holds.landed();
  }

  /**
   * The journey's last room is reached. Unless this walk came here for a
   * lever, in which case arriving is the middle of the journey and not the
   * end of it — asked ahead of everything, because `ended` is what a loop
   * books a leg on.
   */
  private arrive(state: CharacterState, stepName: string): void {
    if (this.levers.finishErrand(state)) return;
    this.status = 'arrived';
    this.reason = null;
    if (!this.quiet) this.events.notice?.(t('automation.walk.arrived', { stepName }));
    this.events.ended?.(true, null);
    this.publish();
  }

  /**
   * Stand still a moment in the room just arrived in, where something in the
   * room behind may be about to walk in after the character.
   *
   * **A room block is the room as the server described it, not as the read
   * carrying it leaves it.** The server works the follow out inside the move
   * (`Exits.cs:165`), so the arrival sentences are composed *after* the room
   * block and `Also here:` is absent from a room about to hold five monsters
   * — and the walk read it six milliseconds into the socket read that said
   * so. The capture, the measurement behind `walk.followSettleMs` and the
   * chase this deliberately does not cover are in `mudengine-automation`
   * › *A room block is the room before whatever followed the character in*.
   *
   * Decides nothing about the monsters: it only stops the walk deciding
   * before they are on the list, then re-asks the ordinary holds. Its own
   * timer and outside `walk.maxHolds`, for `Holds.holdForLight`'s reason — the step
   * *was* answered. Silent, being shorter than a round and resolving either
   * into a hold that states its own reason or into the step it was going to
   * send anyway.
   */
  private settleForFollowers(state: CharacterState): boolean {
    if (!this.leftMobsBehind) return false;
    // Spent by the arrival it was recorded for: the room ahead is the next
    // step's, and `noteRoomBehind` will read it when the character is in it.
    this.leftMobsBehind = false;
    // The live room, which is the whole point of having waited — and the
    // arrival's own state behind it, as every other hold's re-ask falls
    // back, so a session that cannot answer holds exactly as it used to.
    this.retryAfter(tuning().walk.followSettleMs, state);
    return true;
  }

  /**
   * Whether the room the character is standing in holds a monster.
   *
   * `countMobs` and not `countThreats`: what follows is decided by the
   * server's own `CurrentTarget`, which this client cannot read, so a monster
   * whose row the realm does not hold — `kind: 'mob'`, no disposition — is
   * one that may follow. It stops at `kind`, though: an `unknown` is a
   * capitalised name nobody has listed, which is far likelier to be a person,
   * and a person walking out behind the character drags nothing.
   */
  private noteRoomBehind(state: CharacterState): void {
    this.leftMobsBehind = countMobs(state.room.occupants) > 0;
  }

  /**
   * Says *before* the step that the light the pack lists is spent, which is the
   * only moment the fact is worth anything.
   *
   * Both halves are already known: the realm names the room being walked into
   * and records its light level (`RouteStep.dark`), and the pack listing counts
   * the pearl's charges. Afterwards it is merely an explanation for why nothing
   * can be seen.
   *
   * **Carrying nothing at all is not said, and that is the whole of this
   * (2026-09-02).** The realm says it itself — `The room is pitch black - you
   * can't see anything`, and `The room is very dark` for the grade below,
   * printed on arrival in every capture that walks into one. This client
   * printed a line of its own *per step* on top of that, so a corridor of six
   * dark rooms carried six duplicate warnings between the game's own sentences.
   * A client repeating the server in its own words is the chrome talking over
   * the realm.
   *
   * A **spent** light is the half the realm never states, and it is the half
   * that matters: the server treats a zero-charge light as *absent*
   * (`use glowing pearl` → `You don't have glowing pearl.`, measured live
   * 2026-08-27), so a player who believes they packed a light did not. Said
   * once per light rather than once per step, for the same reason the other
   * half went: it is a fact about the **pack**, which does not change because
   * the character took another step. Re-armed when the answer changes, so
   * readying a fresh pearl and spending that one is said again.
   *
   * **Said here; acted on by `AutoLight`** (2026-09-03). This used to end
   * *said, never acted on*, pointing at `automation.rules` — and a rule cannot
   * see the step about to be taken, which is the only moment lighting a torch
   * is worth anything. The acting moved to `beforeStep`, which the arbiter
   * puts ahead of the direction; what stays here is the one sentence the
   * realm never prints, that the light the pack lists is spent, said once.
   */
  private warnBeforeDark(state: CharacterState): void {
    const step = this.route?.steps[this.index];
    if (!step?.dark) return;
    const light = this.events.lightSource?.(state);
    if (light?.state !== 'spent') {
      // Including `none`: the realm says that one itself, on arrival.
      this.warnedLight = null;
      return;
    }
    const name = light.name ?? t('automation.walk.fallbackLight');
    if (name === this.warnedLight) return;
    this.warnedLight = name;
    this.events.notice?.(
      t('automation.walk.darkLightSpent', { stepName: step.name, lightName: name })
    );
  }

  /**
   * A beat in the room the character is standing in, when whoever is watching
   * asks for one — the room a step just confirmed, or the room a fresh route
   * is planned from.
   *
   * Engagement fires from a room the character is standing in, not one it is
   * leaving — so if that room holds a quarry, the step out of it waits. A
   * fight starting stops the walk through the ordinary path; the timer exists
   * for the other outcome, where nothing bites and the walk must not stall.
   */
  private holdBeforeSending(state: CharacterState): boolean {
    /*
     * Under a timed spell, nothing holds but a condition the server has
     * stated: a rest, the health, a trap, a fight and a quarry all wait at
     * the mouth of the passage, and inside it the one thing that helps is
     * the next step (todo 104). Being held is the exception because a step
     * while held is a command spent to be refused.
     */
    if (this.events.moveOnly?.(state) === true) return this.holds.holdForAffliction(state);
    /*
     * A rest this client has just asked for, first of all and outside the
     * beat's budget — and the floor read after a kill (`Holds.holdForFloor`).
     *
     * They are the shortest of the holds and the only ones about something
     * *this client* did a millisecond ago. Ahead of health because a walk that
     * is about to stand still for health anyway must not spend its one step
     * breaking the rest that would have fixed it, and ahead of the fight
     * because a rest is only ever asked for with nothing swinging.
     */
    if (this.holds.holdForRest(state) || this.holds.holdForFloor(state)) return true;
    // Health, and outside the beat's budget — see `Holds.holdForHealth`.
    if (this.holds.holdForHealth(state)) return true;
    // Then a condition the server has stated, on the same terms.
    if (this.holds.holdForAffliction(state)) return true;
    // Then the trap the step ahead fires, on the same terms again.
    if (this.holds.holdForTrap(state)) return true;
    /*
     * A fight running here is not "no quarry", and it is outside the budget
     * too. `holdAt` asks whether engagement *would open* on something in this
     * room, and engagement answers "already fighting" while a target is live
     * — the right answer for a swing, and the opposite of the right answer
     * for a step out of the room. Read as "nothing to wait for", it released
     * the first step of a loop's leg into the fight the hold had waited for
     * (`logs/2026-09-04_00-05-40_festus.mudcap.jsonl`, t=454167: `e` sent
     * 1,503ms after the hold began, with `*Combat Engaged*` on screen). The
     * fight is answered as a fight — held for a route, ended for a loop's leg
     * — and never as a spent beat, which `maxHolds` would otherwise turn it
     * into 4.5 seconds later.
     */
    if (fightIsRunning(state) && !this.holds.leaving) return this.holds.answerFight();
    /*
     * A hidden exit the room has not printed yet — todo 04's first point,
     * *"do not try the direction first unless it is available"*. Sending the
     * step there is a command spent to be refused, and the refusal is answered
     * by the search this sends instead. Outside the beat's budget for
     * `Holds.holdForHealth`'s reason: `maxHolds` bounds a wait for a *quarry*, and
     * spending it here would march the step into the wall three beats later.
     */
    const step = this.route?.steps[this.index];
    if (step !== undefined && this.barriers.mustSearchFirst(state, step)) {
      this.barriers.holdSearching(step);
      return true;
    }
    if (this.quarryHolds >= tuning().walk.maxHolds) return false;
    if (this.events.holdAt?.(state) !== true) return false;
    this.quarryHolds += 1;
    this.publish();
    /*
     * **Re-asked, not resumed.** This went straight to `sendCurrent` and
     * therefore held exactly once — one beat of 1,500ms — whatever the
     * answer had become, which made `tuning.walk.maxHolds` unreachable and the
     * documented "re-asks on a short timer" false. One beat is one round
     * trip: enough for a monster that is *going* to be engaged, and not
     * enough for one whose engagement is waiting on anything at all.
     *
     * Asking again is what makes the bound mean something. `quarryHolds` is
     * reset on every confirmed step, so the three are three at *this* step; a
     * quarry nothing will engage costs 4.5 seconds and then the walk goes
     * on, which is the whole reason there is a bound rather than a wait.
     */
    this.retryAfter(tuning().walk.holdMs, state);
    return true;
  }

  /**
   * One `rm` for a draw whose landing the client cannot place, once per step.
   *
   * Returns whether it asked, so the arrival check can stand down and wait for
   * the answer. `rm` states coordinates outright, so a second ask would answer
   * nothing a first did not, and the step's own deadline is still armed
   * underneath — a realm with no locate word sends nothing and the walk stops
   * exactly as it did before.
   */
  private askWhereAfterDraw(state: CharacterState): boolean {
    if (this.route === null || this.events.locate === undefined) return false;
    const step = this.route.steps[this.index];
    if (step?.scatter === undefined) return false;
    // Only while the landing is genuinely unplaced: a draw that resolved is a
    // question already answered.
    if (roomAddress(state.room) !== null) return false;
    // Already asked and still waiting, which is the whole point — the answer
    // is one command away and stopping the walk for want of it is the failure
    // this exists to fix. Bounded by the step's own deadline, which is still
    // armed underneath and stops the walk if nothing ever answers.
    if (this.askedWhereAt !== null) return true;
    this.askedWhereAt = Date.now();
    this.events.locate();
    if (!this.quiet) {
      this.events.notice?.(
        t('automation.walk.scatteredUnplaced', { spellName: step.scatter.landing.name })
      );
    }
    return true;
  }

  /**
   * The draw landed somewhere, and the journey carries on from there.
   *
   * `Holds.resumeFromFight`'s replan without the waiting: there is nothing to
   * wait for, because the room that resolved the character *is* the answer to
   * the step and no move is outstanding behind it. What differs is only that
   * this is expected — a scatter step is the last one the plan could hold, so
   * a fresh plan is not a recovery here but the next instalment of the same
   * walk, and it is said out loud once rather than reported as a stop.
   */
  private scattered(state: CharacterState, step: RouteStep, here: RoomId): void {
    if (!this.quiet) {
      const roomName = state.room.name ?? here;
      this.events.notice?.(
        step.scatter !== undefined
          ? t('automation.walk.scattered', { spellName: step.scatter.landing.name, roomName })
          : // The realm's own words for the condition, because the whole of
            // what the client can say is that it could not read them.
            t('automation.walk.gateMissed', {
              condition: (step.requirement?.unread ?? []).join(', '),
              roomName
            })
      );
    }
    this.onward(state, here);
  }

  /**
   * The journey planned again from `here`, where a fight or a draw left the
   * character: **it replans; it never resumes**, because the steps ahead were
   * directions from a room the character is not in.
   *
   * A replan that finds nothing ends the walk with the router's own reason,
   * which is the honest outcome: the realm dropped the character somewhere the
   * destination cannot be reached from.
   */
  private onward(state: CharacterState, here: RoomId): void {
    const destination = this.route?.steps.at(-1);
    if (destination === undefined) return;
    const replanned = this.events.replan?.(destination.to, this.shortest);
    if (replanned === undefined) {
      // Nobody can plan for this walker, so a character that moved is exactly
      // the off-path case it has always stopped for.
      this.stop(t('automation.walk.reasonWrongRoom', { roomName: state.room.name ?? here }));
      return;
    }
    if (typeof replanned === 'string') {
      this.stop(replanned);
      return;
    }
    if (replanned.blocked) {
      this.stop(replanned.reason ?? t('automation.walk.refusalNoRoute'));
      return;
    }
    if (replanned.steps.length === 0) {
      /*
       * Already in the room the route was heading for — chased into it, the
       * last step's answer arriving among the combat lines, or the draw
       * putting the character there (one time in nine in the padded cells).
       * The journey is over the way it was asked for, so the hold goes with
       * it: an arrived walk publishing a stale hold chip is the card saying
       * the journey is waiting for something after it has finished. Standing
       * in the lever's room, the errand is done here too, and it is still not
       * an arrival (`arrive`).
       */
      this.clock.clear();
      this.holds.letGo();
      this.arrive(state, destination.name);
      return;
    }
    // Through `carryOn`: the two gates that outrank a step — the rest below
    // `restBelow`, and the monster standing in the room it left the character
    // in — get their say before the next command.
    this.redraw(replanned, state);
  }

  /** A fresh plan in place of this one, carried on from its first step. */
  private redraw(route: Route, state: CharacterState): void {
    this.walked += this.index;
    this.route = route;
    this.index = 0;
    this.carryOn(state);
  }

  /**
   * A lever errand's plan in place of this one. Its first step is not behind
   * the old door: the ladder, the lock and the rounds run at it all belong to
   * the step being left behind, so they are forgotten here rather than left
   * to `sendCurrent`, which `carryOn` may hold.
   */
  private detour(route: Route, state: CharacterState): void {
    this.barriers.forget();
    this.barriers.passed();
    this.redraw(route, state);
  }

  /**
   * Let the fight hold go and take the next step, whatever it now is.
   *
   * Through `holdBeforeSending` rather than straight to `sendCurrent`, so the
   * two gates that outrank a resumed journey get their say in order: the
   * character is sat down if the fight left it under `restBelow`, and the step
   * out of the room waits if what is standing in it is worth another fight.
   * Both are exactly the questions a fight ending raises, which is why this is
   * the one place a hold is handed to another.
   */
  private carryOn(state: CharacterState): void {
    /*
     * The hold's own re-ask goes with the hold. Reached from a state push, it
     * is still armed — and `Holds.holdForHealth` and the quarry beat both
     * arm the beat outright (`WalkClock`), so leaving it would orphan a timer
     * that wakes the walk again for a decision already made.
     */
    this.clock.clear();
    this.holds.letGo();
    this.quarryHolds = 0;
    this.publish();
    if (this.holdBeforeSending(state)) return;
    this.sendCurrent(true, state);
  }

  /**
   * The holds asked again, then the step: what a beat standing still ends in.
   * `state` undefined skips straight to the step, as the door and the search
   * rounds have always done where the session could not answer.
   */
  private retry(state: CharacterState | undefined, fresh = true): void {
    if (state !== undefined && this.holdBeforeSending(state)) return;
    this.sendCurrent(fresh);
  }

  /** A beat of `ms`, then `retry` against the state then, or `state`. */
  private retryAfter(ms: number, state: CharacterState): void {
    this.clock.afterHold(ms, () => {
      if (this.status !== 'walking') return;
      this.retry(this.events.stateNow?.() ?? state);
    });
  }

  /**
   * Ahead of the next step, when the character is meant to be sneaking and is
   * not.
   *
   * **Immediately before the step, every step, and that is the whole point.**
   * What it decides is whether the things in the *next* room notice the
   * arrival, so the only moment it can be decided from is the one the step
   * goes out in. This used to be asked in two places — once before a route's
   * first step and once when a hold let go — and that left the two cases the
   * walk provokes itself uncovered:
   *
   * - **A retry behind a door.** Picking or opening a barrier breaks stealth
   *   silently (`Door.cs`; the client now reads it, see
   *   `StealthReceipt.broke`), and the retry is not a fresh send, so
   *   nothing asked again. Reported 2026-09-11 as a character that sneaked,
   *   walked into a shut door, picked it, opened it and stepped through in
   *   plain sight.
   * - **Every ordinary step after the first.** A fight, a rest and equipping
   *   all break stealth, and a route's second step inherited whatever the
   *   first believed.
   *
   * Called from `sendCurrent` after `beforeStep`, so a torch readied for the
   * next room cannot break the stealth this just asked for: the two share the
   * `movement` band and the arbiter keeps a band in order. Coalesced, so a
   * retry that asks again while the first `sn` is still queued is one
   * command.
   *
   * `Stealth` is three-state for the reason this needs: `unknown` means nobody
   * has said, which is not `sneaking`, and a character that believes it is
   * hidden and is not walks into a lair in the open.
   */
  private sneakFirst(state: CharacterState): void {
    if (!this.config.movement.sneak || state.stealth === 'sneaking') return;
    /*
     * **A sheet that says `Stealth: 0` is never asked to sneak** (todo 104).
     * `SneakCommand.cs` rolls `Stealth − (players − 1 + mobs) ≥ rand(1,100)`,
     * so a figure of zero never passes — and a Mage rerolled from a Ninja
     * kept `movement.sneak` and spent one refused `sn` on every step of every
     * lap. The figure is the sheet's own column; an unread sheet (null) never
     * refuses, and a Ninja whose figure is low is still asked every step.
     */
    if (state.progress.stealthSkill === 0) {
      if (!this.saidNoStealth) {
        this.saidNoStealth = true;
        this.events.notice?.(t('automation.walk.sneakNoSkill'));
      }
      return;
    }
    if (cannotSneakHere(state)) return;
    this.queue.enqueue({
      command: 'sn',
      priority: 'movement',
      coalesceKey: 'sneak',
      reason: t('automation.walk.reasonSneak')
    });
  }

  /**
   * `from` is the state the caller was deciding on, for the two callers that
   * hold one before the tracker has pushed it — `start` and `carryOn`. Read
   * *after* `stateNow`, which is the fresher answer wherever it exists, and
   * the same `stateNow() ?? state` order every hold in this file uses.
   */
  private sendCurrent(fresh = true, from?: CharacterState): void {
    const step = this.route?.steps[this.index];
    if (!step) return;

    // A retry behind a door is the *same* step, so its door budget carries over
    // rather than starting again — otherwise `openTries` would never be reached.
    if (fresh) this.barriers.forget();
    /*
     * Whatever must go ahead of the step, before the step is queued: the two
     * share a band and the arbiter keeps a band in order, so a torch asked
     * for here is lit before the character moves. Only a fresh send — a
     * retry behind a door is the same step into the same room.
     *
     * The sneak is asked on **every** send and after the light, which is the
     * one thing here that is not per-step-per-room: see `sneakFirst`.
     */
    const now = this.events.stateNow?.() ?? from;
    if (now !== undefined) this.noteRoomBehind(now);
    if (fresh && now !== undefined) {
      this.events.beforeStep?.({ name: step.name, light: step.light }, now);
      // And the ward the room ahead wants, in the same band and after the
      // light for the same reason: both must reach the wire before the step.
      this.events.wardFor?.(step.to, now);
      /*
       * And the door the room has already said is shut, in place of the step
       * — see `Barriers.openShutWayFirst`. After the light, which the step behind the
       * door still needs and which only a fresh send asks for; before the
       * sneak, which the retry asks again for itself.
       */
      if (this.barriers.openShutWayFirst(step, now)) return;
      /*
       * And a hidden exit whose action has not yet opened it — see
       * `Levers.pullLeversFirst`. If the room's exits show the way is not there,
       * pulling the lever or using the item takes the step's place instead
       * of walking into the wall to be refused.
       */
      if (this.levers.pullLeversFirst(step, now)) return;
    }
    if (now !== undefined) this.sneakFirst(now);
    /*
     * And where the realm's own spell will put the character, for an exit
     * whose cast moves them — a draw *or* an address. Both answer with two
     * room blocks (`Expectations.hintCast`), so both are handed over; the
     * router already resolved the address half into `step.to`, and this is
     * what lets the parse read the second block rather than the first.
     */
    const cast = step.requirement?.landing;
    const moves =
      step.requirement?.spellEffect === 'scatters' || step.requirement?.spellEffect === 'teleports';
    this.events.stepping?.(step.command, step.direction, step.to, moves ? cast : undefined);
    this.askedWhereAt = null;
    this.dispatch(step, step.command, t('automation.walk.reasonStepping', { stepName: step.name }));
  }

  /**
   * A movement command for the step in flight — the step itself, or an
   * attempt on the barrier in its way (`Barriers`) — timed as the step is:
   * waited for until it reaches the wire, and its answer waited for after.
   * `onSent` is the step's own unless the caller says otherwise.
   */
  private dispatch(
    step: RouteStep,
    command: string,
    reason: string,
    onSent: () => void = () => this.noteStepSent(step, command)
  ): void {
    this.stepSent = false;
    // Never coalesced: a second `n` is a different move, which is exactly the
    // distinction text-matching de-duplication cannot make.
    const queued = this.queue.enqueue({ command, priority: 'movement', reason, onSent });
    /*
     * The arbiter's answer, which this used to throw away.
     *
     * `enqueue` returns false when the intent was dropped outright — chiefly
     * `automation.enabled` going off under a walk that is already running,
     * which the config watcher can do between two steps. Arming a deadline
     * against that produced a walk waiting eight seconds for a command the
     * client itself had refused to send, and then reporting the *server* as
     * silent. A refusal is a decision, and a decision nobody can read did not
     * happen.
     */
    if (!queued) {
      this.stop(t('automation.walk.reasonNotQueued', { command }));
      return;
    }

    // Only when it has not already gone out from inside `enqueue`: the send
    // is synchronous whenever the queue is idle, which is most of the time.
    if (!this.stepSent) this.waitForSend(command);
    this.publish();
  }

  /** The step is on the wire, so the wait becomes a wait on the server. */
  private noteStepSent(step: RouteStep, command: string): void {
    if (!this.onWire(step)) return;
    // This attempt's own evidence, never the last one's — see
    // `Holds.onsetAnsweredStep`.
    this.holds.sent();
    this.waitForAnswer(command);
  }

  /**
   * A command of the step in flight reached the wire, and its clock starts.
   * False for a late `onSent` from an intent this walk has moved past, which
   * decides nothing: `stop` cancels what is still queued, but a send racing
   * the cancel would otherwise re-arm a deadline for a step nobody is walking
   * any more.
   */
  private onWire(step: RouteStep): boolean {
    if (this.status !== 'walking' || this.route?.steps[this.index] !== step) return false;
    this.stepSent = true;
    this.stepSentAt = Date.now();
    return true;
  }

  /**
   * Waiting for the arbiter to put the step on the wire — the client's own
   * share of the silence, which is not the server's.
   *
   * Reported as the server's until 2026-09-02, and that was the bug: a walk to
   * the bank stopped with `nothing came back after se` for a step the capture
   * holds no trace of (`logs/2026-09-02_13-29-52_festus.mudcap.jsonl`). The
   * sentence blames the wire for something that never reached it, and sends
   * whoever reads it to look at the server.
   *
   * **A suppressed queue is not the walk failing.** The player holding the
   * floor with a half-typed line stands automation down entirely, and the
   * queue already credits that time back to every expiry it is holding
   * (`noteTyping`) — the walk's patience is an expiry clock in everything but
   * name, so held time is not spent here either.
   *
   * Which is why this is a **tally on a short beat** rather than one long
   * timer sampling the queue when it expires. Sampling raced the queue's own
   * abandoned-line ceiling: at the moment the hold lapses, the queue releases
   * the step and this asks whether the queue is suppressed, and whichever
   * timer happened to be registered first decided whether the walk carried on
   * or was stopped as never sent. Counting only the beats the queue was *free*
   * has no such moment — after a lapse the step goes out within the queue's
   * own poll, and this needs a further whole `stepTimeoutMs` of free silence
   * before it gives up.
   *
   * The beat is `walk.nudgeAfterMs`, which is already the walk's short tick; a
   * second key for the same cadence would be a knob with nothing to decide.
   */
  private waitForSend(command: string): void {
    this.clock.clear();
    this.waitedToSend = 0;
    this.pollForSend(command);
  }

  /** One beat of the send wait — see `waitForSend` for why it is a tally. */
  private pollForSend(command: string): void {
    const beat = tuning().walk.nudgeAfterMs;
    this.clock.afterStep(beat, () => {
      if (this.status !== 'walking') return;
      if (!this.queue.snapshot.suppressed) this.waitedToSend += beat;
      if (this.waitedToSend < this.config.walk.stepTimeoutMs) {
        this.pollForSend(command);
        return;
      }
      this.stop(t('automation.walk.reasonNotSent', { command }));
    });
  }

  /**
   * The step is on the wire and nothing has come back yet.
   *
   * Longer than this realm has ever taken to answer a move, and then one bare
   * Enter — see `nudgeAfter` for the deadline and `nudge` for what is sent.
   * Past that the silence is abnormal *for this server*, and the cheapest
   * thing that distinguishes **the server has not answered** from **this
   * client did not read the answer** is asking it to say something.
   *
   * The deadline used to be a flat second on the reasoning that a move is
   * answered in well under one. Paradigm takes 1.24s, so the abnormal case
   * was every case: see `answers`.
   */
  private waitForAnswer(command: string): void {
    this.clock.clear();
    this.clock.afterStep(this.nudgeAfter(), () => {
      if (this.status !== 'walking') return;
      if (this.afterTheLine(() => this.waitForAnswer(command))) return;
      if (portalLeftUnseen(this.route?.steps[this.index], this.events.stateNow?.())) {
        if (!this.quiet) this.events.notice?.(t('automation.walk.noNudgeUnseen', { command }));
      } else if (this.holds.standing()) this.nudge(command);
      this.waitForPrompt(command);
    });
  }

  /**
   * Runs `then` once the player's half-typed line has closed, and answers
   * whether it had to wait. The server holds its answers behind that line
   * (`TGSSocket.Send` backlogs while `CurrentCommand` is non-empty) and
   * flushes them on Enter, so a deadline on the wire that lapses while the
   * line is open is armed again in full once it closes, not spent. The check
   * runs on the send wait's beat so that the new window starts no earlier than
   * the Enter. Bounded by the queue's abandoned-line ceiling, past which
   * `suppressed` is false.
   */
  private afterTheLine(then: () => void): boolean {
    if (!this.queue.snapshot.suppressed) return false;
    this.clock.afterStep(tuning().walk.nudgeAfterMs, () => {
      if (this.status !== 'walking') return;
      if (!this.afterTheLine(then)) then();
    });
    return true;
  }

  /**
   * The realm answered a move, and how long it took is the measurement the
   * deadline is built from. Ignored when nothing is outstanding — a room can
   * confirm a step the walk never timed, and a wait that was not measured is
   * not a wait of zero.
   */
  private noteAnswered(): void {
    if (this.stepSentAt === null) return;
    const took = Date.now() - this.stepSentAt;
    this.stepSentAt = null;
    this.answers.push(took);
    const keep = tuning().walk.nudgeSamples;
    if (this.answers.length > keep) this.answers.splice(0, this.answers.length - keep);
  }

  /**
   * How long to give the server before asking it to say something.
   *
   * The slowest answer this realm has recently given, plus the configured
   * margin — so the fallback fires when the realm is slower than *itself*,
   * which is the only definition of late that survives meeting a second
   * realm. See `answers` for the measurement that made this necessary and
   * `walk.nudgeAfterMs` for what the margin is.
   *
   * Until a move has been answered even once there is nothing to be slower
   * than, and the margin is the whole deadline — the behaviour this had
   * before, kept for the one step per connection that cannot be informed by a
   * measurement. Never past `stepTimeoutMs`: a nudge the walk's own deadline
   * would beat to it is a command sent for nothing.
   */
  private nudgeAfter(): number {
    const margin = tuning().walk.nudgeAfterMs;
    if (this.answers.length === 0) return margin;
    const slowest = Math.max(...this.answers);
    return Math.max(margin, Math.min(slowest + margin, this.config.walk.stepTimeoutMs));
  }

  /**
   * Client-side patience, not a claim about the server.
   *
   * Some moves produce nothing at all — a command the game ignores, a room
   * whose description never arrives. Without a deadline the walk sits in
   * `walking` for ever, reporting progress it is not making, which is a worse
   * lie than stopping. This is the half of the wait that is genuinely about
   * the server: the step has gone, and a prompt has been asked for on top.
   */
  private waitForPrompt(command: string): void {
    this.clock.clear();
    this.clock.afterStep(this.config.walk.stepTimeoutMs, () => {
      /*
       * **A step nothing answered while the character is held was refused,
       * not lost**, and the difference is the whole of what a hold is for:
       * the client knows exactly where the character is standing, so there is
       * nothing to replan and nothing to ask a person about — the route goes
       * on by itself the moment the condition passes.
       *
       * Reported as `Walk stopped: nothing came back after ne` until now, on
       * a `ne` the server had answered with `You are flat on your back!` and
       * a prompt. The realm's own words for the hold, in a sentence this
       * parser did not read as anything, ended a journey that was never in
       * any trouble.
       *
       * `Holds.holdForAffliction` and not `holdBeforeSending`: every other gate in
       * that ladder is a reason not to *send*, and a step already on the wire
       * with no answer is not waiting on any of them. Down, it was refused (764).
       */
      if (this.afterTheLine(() => this.waitForPrompt(command))) return;
      if (this.holds.refusedAtDeadline(command)) return;
      this.stop(t('automation.walk.reasonTimeout', { command }));
    });
  }

  /**
   * One bare Enter, to make the server say something.
   *
   * An empty line is answered with a status line and a reprint of the room the
   * character is standing in — measured, in the capture that produced
   * `SessionManager.editorInput` (twenty Escapes and an Enter, answered with a
   * bare room reprint, because the server had kept none of them). That is
   * exactly the fact a stalled step is waiting for, for one command.
   *
   * `REREAD_ROOM`, the named empty command every other client-side re-read
   * sends, rather than a bare `''` here: one fact, one spelling, and the
   * places that send it stay findable.
   *
   * `probe`, the least urgent band, and coalesced: this must never displace an
   * attack or an escape, and **one per command sent** is the whole budget — the
   * beat is re-armed by `onSent`, so a step and each forcing attempt behind it
   * get one apiece and nothing gets two. A second for the same command would
   * be the client answering its own silence with more of it. Through the
   * arbiter rather than around it, which is what keeps it off a half-typed
   * line: gluing our Enter onto the player's partial command is the failure
   * `CommandQueue` exists for.
   *
   * The cost this used to carry is paid off (2026-09-02). A reprint is a room
   * block, and arriving rooms consume the expectation queue, so when the step's
   * real answer was merely late the server answered both in one packet and the
   * nudge's reprint landed against the *next* step as its arrival. In a
   * corridor of namesakes nothing said it was wrong — the walk did not stop,
   * it simply ran a room ahead of the character for the rest of the lap
   * (`2026-09-02_18-07-07_festus.mudcap.jsonl`, t=4862445: `e` sent twice
   * inside three milliseconds, then a fight opened out of a room block the
   * character was already leaving). `SessionManager` files the bare Enter
   * through `CharacterTracker.observeReread` now, so the block answering it is
   * attributed to it and **takes no move**. Still cancelled while queued the
   * moment the step confirms: a command not sent is cheaper than one correctly
   * accounted for. Behind a portal too, save from a room left unseen
   * (`portalLeftUnseen`, todo 808).
   */
  private nudge(command: string): void {
    this.reprint(t('automation.walk.reasonNudge', { command }));
  }

  /**
   * One bare Enter on the nudge's own key, which is every *make the server
   * reprint this room* the walk sends — the nudge and a search answered
   * (`Barriers.onSearchAnswered`): two queued together would be one wasted
   * and one resolved against a step it does not answer.
   */
  private reprint(reason: string): void {
    this.queue.enqueue({ command: REREAD_ROOM, priority: 'probe', coalesceKey: NUDGE_KEY, reason });
  }

  /** Drops a nudge that has not gone out; what has gone cannot be recalled. */
  private forgetNudge(): void {
    this.queue.cancel((intent) => intent.coalesceKey === NUDGE_KEY);
  }

  private cancelQueued(): void {
    // Anything not yet on the wire is still revisable; that is the point of the
    // queue. What has already gone cannot be recalled, and pretending otherwise
    // is how a "stopped" walk takes one more step.
    this.queue.cancel((intent) => intent.priority === 'movement');
    this.forgetNudge();
  }

  private publish(): void {
    this.events.progress?.(this.progress);
  }
}

/**
 * Whether a fight is running around this character right now.
 *
 * The server's own flag, **or** anything this client has recorded as swinging.
 * The second half is what makes it a walk's question rather than a repeat of
 * `state.inCombat`: `CharacterTracker` files an attacker the moment a blow
 * names one, which is a round before `*Combat Engaged*` on a monster that
 * opened the fight — and a step sent in that round walks the character out of
 * a fight it is in, which `cancelQueued` cannot recall.
 *
 * It is deliberately *not* `Recovery.fightIsHere`, which asks the narrower
 * question resting needs — that one falls back to "is anybody standing here"
 * to explain a flag with nothing behind it, and for a walk a monster standing
 * in the room is not by itself a reason to stop. What the two share is the
 * measured fact underneath: the flag outlives an escape by a median 3,493ms
 * and `attackers`/`target` are cleared by a confirmed move, so a character that
 * got away
 * reads as fighting for about three seconds and then walks on.
 */
export function fightIsRunning(state: CharacterState): boolean {
  return state.inCombat || state.combat.attackers.length > 0 || state.combat.target !== null;
}

/**
 * Whether the server would refuse a `sn` sent from this room, so that none is
 * sent.
 *
 * This is `SneakCommand`'s own condition transcribed, not a heuristic:
 * everything it does sits inside `if (CurrentTarget == null &&
 * Room.Mobs.Count == 0)`, and the `else` is the single line `You may not sneak
 * right now!`. So a monster in the room or a fight in progress means the
 * command cannot succeed, whatever the character's stealth skill is.
 *
 * **Players do not count, and that is the server's rule rather than a
 * kindness**: `Room.Mobs` holds monsters only, and standing beside somebody is
 * no bar to sneaking — the room's *players* are checked one rung further in,
 * and only to refuse somebody who has this character targeted.
 *
 * Without this the walker spent one `sn` per step in every room holding a
 * monster, each answered by a refusal, out of the budget the fight in that
 * room is about to be fought with — and each one also **broke the character's
 * rest**, since `SneakCommand` clears `Resting` before it gets as far as
 * refusing.
 *
 * `unknown` occupants deliberately do not block. A capitalised stranger is as
 * likely to be a person as a monster, refusing on one would stop sneaking in
 * any room with a name the client cannot place, and the cost of being wrong is
 * one refused command — the direction this file errs in everywhere else is the
 * one where the mistake costs a character, and that is the other one.
 */
export function cannotSneakHere(state: CharacterState): boolean {
  if (fightIsRunning(state)) return true;
  return state.room.occupants.some((occupant) => occupant.kind === 'mob');
}

/**
 * Whether this step's way through carries a condition the router could not
 * evaluate — and so whether landing somewhere else is a surprise the plan
 * already allowed for.
 *
 * `Requirement.unread` is written by `WorldGraph.linkPortals` alone, for a
 * room script, which is the one place in the realm where an edge's *landing*
 * depends on a branch: the script names a room on the branch it can and
 * nothing on the branches it cannot, and the router takes the landing it has
 * with the guard on `unread`. So this is not "the step failed" — a condition
 * that stops the move outright leaves the character where it was, which the
 * `here === step.from` line above already reads as *not landed yet*.
 */
function unreadGate(step: RouteStep): boolean {
  return (step.requirement?.unread?.length ?? 0) > 0;
}

/**
 * Whether this step's exit answers with two room blocks rather than one.
 *
 * `CastExit.TryMoveThroughExit` describes the room the exit table names and
 * *then* casts, and a teleport describes the room it lands in — so both a
 * `teleports` step and a `scatters` one print twice for one command. See
 * `Expectations.hintCast`, which queues the pair.
 */
function movesTwice(step: RouteStep): boolean {
  const effect = step.requirement?.spellEffect;
  return (
    (effect === 'teleports' || effect === 'scatters') && step.requirement?.landing !== undefined
  );
}
