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
 * (`holdForFight`, with the capture). So the route stands still, keeps its
 * destination, and when the fight is over plans again from wherever it left
 * the character — which is the same repair as above, applied without needing a
 * human to ask for it.
 *
 * A walk that somebody *else* decides about — a loop's leg, a retreat — says
 * `resumeAfterFight: false` and still ends, because those two already answer
 * the question and two answers to one question disagree the moment one is
 * edited.
 */
import type { WalkProgress, WalkStatus } from '../../shared/walk';
import {
  roomId,
  type Direction,
  type RoomId,
  type Route,
  type RouteStep,
  asRoomReference
} from '../../shared/world';
import type { Block } from '../../shared/blocks';
import { REREAD_ROOM } from '../../shared/commands';
import { isBlinding, type CharacterState } from '../../shared/character';
import { resumeAtHealth, type AutomationConfig } from '../../shared/config';
import { t } from '../app/i18n';
import type { CommandQueue } from './CommandQueue';
import { tuning } from '../app/tuning';

/** Which way a locked barrier is being forced, while the attempt is in flight. */
type Forcing = 'bash' | 'pick';

/**
 * The nudge's coalesce key — by intent, so a walk cannot queue two of them.
 *
 * Never by command text: the nudge *is* an empty command, and the queue's own
 * rule is that text-matching de-duplication is what made `megamind-client`
 * exempt every direction from its damper.
 */
const NUDGE_KEY = 'walk:nudge';

export interface WalkerEvents {
  notice?(message: string): void;
  /** Progress changed, so the renderer can redraw. */
  progress?(progress: WalkProgress): void;
  /**
   * The walk finished, one way or the other.
   *
   * For whoever is walking *because of* something else — a loop deciding where
   * to go next. The walker itself knows nothing about loops, which is what
   * keeps a plain walk a plain walk.
   */
  ended?(arrived: boolean, reason: string | null): void;
  /**
   * A step is about to be sent. The tracker cannot model a `Text:` exit as
   * movement from the command alone, and the walker planned it off a realm
   * edge — so the direction is handed over before the command goes out.
   */
  /**
   * A step's command is about to go out. `direction` is `'portal'` for a
   * scripted teleport, whose arriving room is resolved by the coordinates in
   * `to` rather than by an exit — which is why the destination rides along.
   */
  stepping?(command: string, direction: Direction | 'portal', to: RoomId): void;
  /**
   * What the character has to see by, when the next step goes somewhere dark.
   *
   * Asked rather than worked out here, for the reason `holdAt` is: answering it
   * needs the realm's item table to know which of the things in the pack is a
   * light at all, and the walker holds a route and a queue and deliberately not
   * the world. Absent, nothing is claimed and nothing is said.
   *
   * `spent` is the one worth interrupting for: the server treats a
   * zero-charge light as **absent** — `use glowing pearl` answers `You don't
   * have glowing pearl.` (measured live, 2026-08-27) — so a pearl reading
   * `(Readied/0)` is a stick. Note there is no `lit`: nothing on the wire says
   * whether a carried light is currently burning, and inventing that
   * distinction would be the reassuring guess.
   */
  lightSource?(state: CharacterState): { state: 'spent' | 'carried' | 'none'; name: string | null };
  /**
   * A step is about to be sent into `ahead`, and anything that must precede
   * it — a light, since 2026-09-03 — goes on the queue now, in the same band,
   * so it reaches the wire first.
   *
   * Asked here rather than worked out in the walker for `lightSource`'s
   * reason: the answer needs the pack's lights and the race's night vision,
   * and the walker holds a route and a queue. `light` is the destination's
   * recorded level, undefined for a room the realm records none for.
   */
  beforeStep?(ahead: { name: string; light: number | undefined }, state: CharacterState): void;
  /**
   * Whether to hold the next step a moment: the room just confirmed holds
   * something worth stopping for (a loop's auto-combat answers this). The
   * walker re-asks on a short timer and proceeds when the answer turns false
   * or the patience runs out, so a monster nothing will engage cannot pin a
   * walk forever.
   */
  holdAt?(state: CharacterState): boolean;
  /**
   * The character as it is *now*, for a question asked on a timer.
   *
   * `holdAt` is asked again when the beat expires, and the state captured when
   * the hold began is by then a second and a half old — the monster may be
   * dead, or the fight may have started. Absent, the stale state is used, which
   * is what every existing caller had.
   */
  stateNow?(): CharacterState;
  /**
   * The server refused a step the realm data promised — the `no exit` shape,
   * not a closed door. The edge is named so the session can stop planning
   * through it.
   */
  refused?(from: RoomId, direction: Direction | 'portal'): void;
  /**
   * A walk has been started, and this is where it is going.
   *
   * Raised here rather than at the IPC handler because this is the one funnel
   * every walk goes through — a route the player chose in the palette, and a
   * loop's own leg to its next stop, which never reaches an IPC handler at all.
   * Recording at the handler would have kept the palette's destinations and
   * silently missed every loop start point, which is half of what the recent
   * list is for.
   *
   * *Started*, not arrived: the destination is what the player asked for, and a
   * route that failed half way is the one they are most likely to ask for
   * again. The walker knows the room and its name off the last step and
   * deliberately not what is done with them.
   */
  destination?(room: RoomId, name: string): void;
  /**
   * How many moves this client has sent that the server has not answered yet.
   *
   * The tracker owns that queue (`CharacterTracker.pendingMoves`) because it
   * counts every move, not only the walker's — a typed direction, a party
   * follow, a leg the last walk had already sent when combat stopped it. The
   * walker needs the count for two decisions it cannot make from its own
   * route: whether the room on the books is one the character has left, and
   * whether a refusal off the wire is the answer to *this* step.
   *
   * Absent, nothing is claimed: the count reads as "only this step", which is
   * the behaviour before it existed.
   */
  pendingMoves?(): number;
  /**
   * A fresh route from where the character is *now* to where it was going.
   *
   * Asked when a fight the route stood still for is over and the character is
   * no longer standing where the held step starts — it killed the thing in
   * the next room, or ran, or was followed somewhere. **It replans; it never
   * resumes**, which is the rule `LoopRunner` already follows after every one
   * of its own interruptions and the one `Walker` follows after any failure:
   * the steps ahead were planned from a room the character may have left, and
   * walking them from here sends directions from somewhere it is not.
   *
   * Asked rather than worked out here for `holdAt`'s reason — the answer needs
   * the realm graph, the character's purse and the edges the server has
   * refused this session, and the walker holds a route and a queue and
   * deliberately not the world. Absent, a character that moved during a fight
   * stops the walk as it always did, which is the behaviour before this
   * existed.
   *
   * Returns the route, or the reason there is none — reported as the reason
   * the walk stopped, because a journey that cannot be re-planned is over.
   */
  replan?(to: RoomId): Route | string;
}

export class Walker {
  private route: Route | null = null;
  private index = 0;
  private status: WalkStatus = 'idle';
  private reason: string | null = null;
  /** The room the step in flight is supposed to reach. */
  private timer: NodeJS.Timeout | null = null;
  /**
   * Doors opened for the step in flight.
   *
   * Per step, not per route: a corridor with a door at each end is two ordinary
   * steps, and a counter that ran for the whole route would refuse the second
   * one because the first had used the budget. Reset every time a step is sent.
   */
  private opened = 0;
  /**
   * Bashes and picks spent on the step in flight, and whether the barrier is
   * known locked.
   *
   * Per step for `opened`'s reason, and `locked` is what stops the ladder
   * repeating its cheapest rung: `open` at a locked door answers `The door is
   * locked.` every single time (captured live in the sewers under Newhaven —
   * three `open w`, three identical refusals, then the walk stopped anyway).
   * Once the server has said the word, opening is spent and forcing is what is
   * left.
   */
  private bashed = 0;
  private picked = 0;
  private locked = false;
  /** Searches spent looking for the hidden exit at the step in flight. */
  private searched = 0;
  /**
   * The forcing attempt on the wire, if one is.
   *
   * `Your attempts to bash through fail!` and `Your skill fails you this time.`
   * are answers to a specific command, and the second is not even specific to
   * picking — the server spends the same sentence on a failed trap disarm. So
   * neither is acted on unless this says the walker asked the question.
   */
  private forcing: Forcing | null = null;
  /**
   * The two skills a barrier is graded against, from the last state seen.
   *
   * Kept here rather than asked for at the moment of the refusal because
   * `onBlock` has no state to read: a block is a line off the wire and the stat
   * sheet arrived some time earlier. Null until a sheet has said, and a null
   * skill never meets a stated number — the same direction `forcedDoorCost`
   * already takes, where a character whose sheet nobody has read is priced as
   * if it could force nothing.
   */
  private strength: number | null = null;
  private picklocks: number | null = null;
  /** Consecutive holds at the current step; bounded so nothing pins a walk. */
  private holds = 0;
  private holdTimer: NodeJS.Timeout | null = null;
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
  /**
   * Why the walk is standing still without having stopped, or null.
   *
   * Kept as state rather than re-derived because for `health` it is the
   * hysteresis — what counts as "recovered" depends on whether the walk is
   * already waiting, exactly as it does for a lap — and for `fight` it is what
   * says the route still has somewhere to be when the fight ends.
   */
  private hold: 'health' | 'fight' | null = null;
  /**
   * Whether this walk is one the walker itself decides fitness for.
   *
   * False for a retreat (the escape must not wait to be better) and for a
   * loop's leg, which `LoopRunner` holds off the same two thresholds. See
   * `start`, which has both reasons in full.
   */
  private holdWhenHurt = true;
  /**
   * Whether a fight holds this walk rather than ending it.
   *
   * True for a route the **player** asked for, which is the only walk with
   * nobody else deciding what to do when the fight is over. False for a loop's
   * leg and for a retreat; `start` has both reasons in full.
   */
  private resumeAfterFight = true;
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
   * When the fight this walk was holding for stopped being a fight, or null.
   *
   * The patience clock for `resumeFromFight`, and separate from the hold
   * itself because a fight lasting five minutes is ordinary while *five
   * minutes of not being able to say where the character is standing* is the
   * client having lost it. Re-armed from null on every fight, so a journey
   * through six of them gets the whole allowance each time.
   */
  /**
   * This walk was asked for mid-fight, and has not left it yet.
   *
   * Set by `start` and cleared the first moment no fight is running. See the
   * note there: it exempts *that* fight from the hold and nothing else.
   */
  private leavingAFight = false;
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

  constructor(
    private config: AutomationConfig,
    private readonly queue: CommandQueue,
    private readonly events: WalkerEvents = {}
  ) {}

  configure(config: AutomationConfig): void {
    this.config = config;
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
      done: this.index,
      total: this.route?.steps.length ?? 0,
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
      hold: this.status === 'walking' ? this.hold : null
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
  get holding(): 'health' | 'fight' | null {
    return this.status === 'walking' ? this.hold : null;
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
      holdWhenHurt = true,
      resumeAfterFight = true,
      whileFighting = true,
      resumeAfterLoss = true
    }: {
      quiet?: boolean;
      holdWhenHurt?: boolean;
      resumeAfterFight?: boolean;
      whileFighting?: boolean;
      resumeAfterLoss?: boolean;
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
     * `attackers`, so the leg started, `leavingAFight` read the same state as
     * *asked to leave this fight* and stood the fight branch of `onCharacter`
     * down, the quarry hold held for its 1,500ms, and the re-ask then found a
     * live target — "already fighting", no quarry — and sent `e` out of the
     * fight at t=454167. `fightIsRunning` is the walk's own definition of a
     * fight everywhere else in this class; the refusal now reads it too.
     */
    if (!whileFighting && fightIsRunning(from)) return t('automation.walk.refusalInCombat');

    const here = locate(from);
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
      this.clearTimer();
      const dropped = this.route?.steps.at(-1)?.name;
      if (!this.quiet && dropped !== undefined) {
        this.events.notice?.(t('automation.walk.superseded', { destination: dropped }));
      }
    }

    this.route = route;
    this.index = 0;
    this.reason = null;
    this.status = 'walking';
    // A fresh walk gets the whole patience. `holds` is otherwise only cleared
    // by a confirmed step, so a route that ended mid-hold — which is what
    // combat does to a loop's leg — would leave the next one starting with the
    // budget already spent and its first step unheld.
    this.holds = 0;
    // A health hold belongs to the walk that was waiting, not to the next one:
    // left set, a fresh route would be measured against the *resume* ceiling
    // before it had held for anything, and would announce recovering from a
    // hold it never took.
    this.hold = null;
    this.fightClearedAt = null;
    this.fightHeldSince = null;
    // An escape belongs to the walk that ran away. A fresh route is the player
    // asking again, from here, with that already taken into account.
    this.escaped = false;
    // After the refusals, so a walk that was declined does not leave the next
    // one — which may be a plain one — inheriting this one's silence.
    this.quiet = quiet;
    this.holdWhenHurt = holdWhenHurt;
    this.resumeAfterFight = resumeAfterFight;
    this.resumeAfterLoss = resumeAfterLoss;
    /*
     * Asked for while a fight was running, so this walk's job is to leave it.
     *
     * Without this the refusal above would simply have become a *hold*: the
     * very next status line would put the route in a `fight` hold and it would
     * stand still until the fight was over — the same standing still, now
     * silent, which is worse than the refusal it replaced.
     *
     * It covers **the fight that was running when it was asked for and no
     * other**. A monster wandering into a corridor twelve steps later is a
     * fight nobody asked about, and holding for that one is the behaviour a
     * separate report asked for (see `holdForFight`): a route abandoned two
     * steps into twenty-one, in a sewer, for the ordinary reason a sewer
     * exists. Cleared the first moment nothing is fighting, which is precise
     * and needs no clock — `state.inCombat` outlives an escape by a measured
     * median of 3,493ms, so a step that got the character away still reads as
     * fighting for about three seconds, and that window is exactly the one
     * this must not stop in.
     */
    this.leavingAFight = fightIsRunning(from);
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
     * Sneak first, when asked to and when the character is not already.
     *
     * Ahead of the first step because what it decides is whether the things in
     * the *next* room notice the arrival, and `Stealth` is three-state for the
     * reason this needs: `unknown` means nobody has said, which is not
     * `sneaking`, and a character that believes it is hidden and is not walks
     * into a lair in plain sight.
     */
    if (this.config.movement.sneak && from.stealth !== 'sneaking') {
      this.queue.enqueue({
        command: 'sn',
        priority: 'movement',
        coalesceKey: 'sneak',
        reason: t('automation.walk.reasonSneak')
      });
    }
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
    this.sendCurrent();
    return null;
  }

  /** Ends the walk. Safe to call when not walking. */
  stop(reason: string, quiet = false): void {
    if (this.status !== 'walking') return;
    this.clearTimer();
    // The outstanding step is not going to be answered as this step any more,
    // so the clock it was being timed against goes with it. See `answers`.
    this.stepSentAt = null;
    this.cancelQueued();
    this.status = 'stopped';
    this.reason = reason;
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
    this.clearTimer();
    this.route = null;
    this.index = 0;
    this.status = 'idle';
    this.reason = null;
    this.hold = null;
    this.fightClearedAt = null;
    this.fightHeldSince = null;
    this.escaped = false;
    this.quiet = false;
    this.holdWhenHurt = true;
    this.resumeAfterFight = true;
    this.resumeAfterLoss = true;
    // The fourth of the same group: `start` writes it unconditionally, but
    // this is the deterministic-cleanup path for a new session and one start
    // option surviving it is exactly the kind of thing that comes back.
    this.leavingAFight = false;
    this.warnedLight = null;
    this.strength = null;
    this.picklocks = null;
    this.forgetBarrier();
    this.publish();
  }

  dispose(): void {
    this.clearTimer();
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
    if (this.status !== 'walking' || !this.resumeAfterFight || this.escaped) return;
    this.escaped = true;
    this.escapedAt = Date.now();
  }

  /**
   * A classified block arrived. The refusals matter here, and so does every
   * answer to the walker's own attempts on a barrier in the way.
   *
   * ## The ladder
   *
   * A shut door is shut until something opens it, and there are three ways up:
   * `open` it, pick its lock, or bash it down. They are rungs rather than
   * alternatives because each one answers a question the one below could not:
   *
   * | The server says | What is left |
   * |---|---|
   * | `The door is closed!` | `open` — it may simply be shut |
   * | `The door is locked.` | opening is spent; a lock is what is in the way |
   * | `Your skill fails you this time.` | that pick did not take; another might |
   * | `Your attempts to bash through fail!` | that bash did not land; another might |
   *
   * Nothing here retries a rung it has already been refused on: `open` at a
   * locked door answers the same word every time, which is a command per
   * attempt spent to be told what the client already knows.
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
     * (`holdForFight`, and `start`'s own refusal, both state it).
     *
     * It is reachable exactly because a held walk is still `walking`. Found by
     * review and reproduced on stock settings: a step through one of the 249
     * `Hidden/Searchable` exits the router prices a search into, a wanderer
     * opening before the answer landed, and then `There is no exit in that
     * direction!` putting `search e` and `e` on the wire inside the round.
     *
     * Nothing is lost by ignoring it: the refusal is the answer to a step the
     * fight has already suspended, and `resumeFromFight` plans the whole leg
     * again from wherever the fight leaves the character — the same repair,
     * made once the character is free to make it.
     */
    if (this.hold === 'fight') return;

    switch (block.type) {
      case 'direction-failed':
        this.onRefusedStep(block);
        return;
      case 'open-failed':
        /*
         * `The door is locked.` — `open` cannot help from here on, whatever
         * `openTries` is left. Nothing is sent in answer: the direction was
         * already queued behind the `open` that provoked this, and the
         * `direction-failed` it comes back with is what takes the next rung.
         */
        if (block.groups['reason'] === 'locked') this.locked = true;
        return;
      case 'bash-failed':
        // Only when the walker is the one bashing. A hand-typed `bas` at a
        // door the player is dealing with themselves is not the walk's news.
        if (this.forcing === 'bash') this.forceAgainOrStop();
        return;
      case 'skill-failed':
        // The same sentence answers a failed trap disarm, so it means "the
        // pick missed" only while the walker has one in flight.
        if (this.forcing === 'pick') this.forceAgainOrStop();
        return;
      case 'door-changed':
        this.onBarrierChanged(block);
        return;
      default:
        return;
    }
  }

  /**
   * The server refused the step: no exit that way, or something in it.
   *
   * The two `direction-failed` shapes are not one fact and the pattern
   * captures which is which: `There is no exit in that direction!` says the
   * realm data was wrong, and no amount of opening or forcing helps. Only a
   * `door` or a `gate` is worth a command.
   */
  private onRefusedStep(block: Block): void {
    const step = this.route?.steps[this.index];
    const barrier = block.groups['barrier'];

    /*
     * A refusal is only this step's while this step's move is the only one
     * outstanding. More than one and the sentence answers whichever went
     * first, which this walk has no way to know — so it is acted on by
     * stopping and by nothing else: no door opened in a direction that may
     * not be in the way, no edge written down, no command spent on somebody
     * else's wall. The tracker consumes the move *after* the walker sees the
     * block, so this step's own is still counted here: one is ours.
     */
    if (!this.refusalIsOurs()) {
      /*
       * And it stops as *lost*, not as a refused route: one of the moves out
       * there landed and one did not, so which room this is standing in is
       * exactly the thing nobody knows. That is the reason a loop answers
       * with one `rm` and the same stop again, rather than by giving up on
       * a stop that was never the problem.
       */
      this.stop(t('automation.walk.reasonAmbiguous'));
      return;
    }

    if (step !== undefined && barrier !== undefined) {
      /*
       * Bounded by `openTries`, per step — and skipped outright once the
       * server has said `locked`, because that is the one refusal repeating
       * cannot get past.
       */
      if (
        !this.locked &&
        this.config.movement.openDoors &&
        this.opened < this.config.movement.openTries
      ) {
        this.opened += 1;
        this.queue.enqueue({
          command: `open ${step.direction}`,
          priority: 'movement',
          reason: t('automation.walk.reasonOpening', { barrier, stepName: step.name })
        });
        // And the step again behind it. `sendCurrent` re-arms the deadline,
        // which is what keeps the walk from timing out on the door's own round
        // trip.
        this.sendCurrent(false);
        return;
      }
      if (this.force(step, barrier)) return;
    }

    if (step !== undefined && barrier === undefined) {
      /*
       * `There is no exit in that direction!`. One sentence, four causes
       * (docs/greatermud/movement.md) — a wrong map, a hidden exit nobody has
       * found, a text exit approached as a direction, a remote-action exit —
       * and the document's own warning is that *a client that marks the map
       * from this message will mark it wrongly*. This client did.
       */
      if (this.searchFor(step)) return;
      if (this.blameable(step)) this.events.refused?.(step.from, step.direction);
    }
    this.stopRefused(step, barrier);
  }

  /**
   * Looks for the hidden exit the realm says is there. Returns whether
   * anything was sent.
   *
   * A `Hidden/Searchable` exit answers a bare direction with `There is no exit
   * in that direction!` until it has been found, so the refusal is not news —
   * it is the step the realm data already described, and `edgePenalty` priced
   * the search into the route when it chose this leg.
   *
   * Reactive rather than pre-emptive, and for the reason the `open` rung is:
   * a found exit stays found, so a route walked twice pays the search once
   * instead of on every lap. The answer (`You found an exit to the east!`) is
   * deliberately not read — the direction sent behind it says the same thing
   * and has to go out either way.
   */
  private searchFor(step: RouteStep): boolean {
    const need = step.requirement;
    if (need?.kind !== 'hidden' || need.searchable !== true) return false;
    if (this.searched >= tuning().walk.searchTries) return false;
    this.searched += 1;
    this.queue.enqueue({
      command: `search ${step.direction}`,
      priority: 'movement',
      reason: t('automation.walk.reasonSearching', { stepName: step.name })
    });
    // And the step again behind it, as `open` does. `sendCurrent` re-arms the
    // deadline so the walk does not time out on the search's own round trip.
    this.sendCurrent(false);
    return true;
  }

  /**
   * Whether the refusal off the wire answers the step this walk has out.
   *
   * Nobody counting reads as "only this step" — the behaviour before the count
   * existed. Absent must not become the alarming answer either way.
   */
  private refusalIsOurs(): boolean {
    return (this.movesInFlight() ?? 1) === 1;
  }

  /**
   * Whether this refusal is safe to write down against the edge.
   *
   * `There is no exit in that direction!` is not proof there is no exit, and a
   * hidden one says it until it has been found. Only once the searches have
   * been spent does the refusal say anything about the edge; before that it
   * says the client has not done its part yet.
   */
  private blameable(step: RouteStep): boolean {
    const need = step.requirement;
    if (need?.kind === 'hidden' && need.searchable === true)
      return this.searched >= tuning().walk.searchTries;
    return true;
  }

  /** Moves sent and not yet answered, or null when nobody is counting. */
  private movesInFlight(): number | null {
    return this.events.pendingMoves?.() ?? null;
  }

  /**
   * A barrier changed state — and *which* change decides what follows.
   *
   * **Bashed is open and picked is only unlocked.** `You bashed the door
   * open.` leaves the character standing exactly where it was with the way
   * clear (`captures/005`: the room reprinted with `open door north` and the
   * door behind it still to the south), so the direction goes out again.
   * `You successfully unlocked the door.` leaves a shut door, so an `open`
   * goes first — unconditionally, whatever `openDoors` says, because the pick
   * that unlocked it was this module's own act and a lock picked for a door
   * left shut is a command spent for nothing.
   */
  private onBarrierChanged(block: Block): void {
    if (this.forcing === null) return;
    const step = this.route?.steps[this.index];
    if (step === undefined) return;

    if (block.groups['state2'] === 'unlocked') {
      this.forcing = null;
      this.locked = false;
      this.queue.enqueue({
        command: `open ${step.direction}`,
        priority: 'movement',
        reason: t('automation.walk.reasonOpening', {
          barrier: t('automation.walk.fallbackBarrier'),
          stepName: step.name
        })
      });
      this.sendCurrent(false);
      return;
    }
    if (block.groups['state'] === 'open') {
      this.forcing = null;
      this.locked = false;
      this.sendCurrent(false);
    }
  }

  /**
   * The forcing attempt in flight came back a failure. Try the next one, or
   * end the walk saying which door and what it wanted.
   */
  private forceAgainOrStop(): void {
    this.forcing = null;
    const step = this.route?.steps[this.index];
    if (step === undefined) {
      this.stopRefused(step, undefined);
      return;
    }
    if (this.force(step, t('automation.walk.fallbackBarrier'))) return;
    this.stopRefused(step, t('automation.walk.fallbackBarrier'));
  }

  /**
   * Spends one attempt on the barrier in the way, if either skill is worth
   * spending it. Returns whether anything was sent.
   *
   * **Picking first when both are open.** A failed pick costs a command; a
   * failed bash costs a command and some health, and the server prints the
   * damage in the room. The cheaper question is asked first.
   */
  private force(step: RouteStep, barrier: string): boolean {
    const { movement } = this.config;
    const need = step.requirement;
    // The realm records a number for some barriers and nothing for others. No
    // number at all is not "impossible" — it is the plain `Door` the router
    // already priced as ordinary when it planned this route through it, so
    // refusing to force one would make the plan a promise the walk breaks.
    const stated = need?.pickDifficulty !== undefined || need?.bashDifficulty !== undefined;

    if (
      movement.pickLocks &&
      this.picked < movement.pickTries &&
      meetsBarrier(need?.pickDifficulty, this.picklocks, tuning().walk.pickMargin, stated)
    ) {
      this.picked += 1;
      this.sendForcing('pick', `pi ${step.direction}`, step, barrier);
      return true;
    }
    if (
      movement.bashDoors &&
      this.bashed < movement.bashTries &&
      meetsBarrier(need?.bashDifficulty, this.strength, tuning().walk.bashMargin, stated)
    ) {
      this.bashed += 1;
      this.sendForcing('bash', `bas ${step.direction}`, step, barrier);
      return true;
    }
    return false;
  }

  private sendForcing(kind: Forcing, command: string, step: RouteStep, barrier: string): void {
    this.forcing = kind;
    this.stepSent = false;
    const queued = this.queue.enqueue({
      command,
      priority: 'movement',
      reason:
        kind === 'pick'
          ? t('automation.walk.reasonPicking', { barrier, stepName: step.name })
          : t('automation.walk.reasonBashing', { barrier, stepName: step.name }),
      onSent: () => this.noteStepSent(step, command)
    });
    if (!queued) {
      this.stop(t('automation.walk.reasonNotQueued', { command }));
      return;
    }
    /*
     * The deadline is re-armed and the direction is deliberately *not* queued
     * behind this one. Unlike `open`, a forcing attempt has an answer worth
     * reading — `door-changed` says the way is clear, the two failures say to
     * try again — so sending the step blind would spend a move to be refused
     * by the same shut door, once per attempt.
     *
     * It is armed against `bas w` rather than against `w`, which is what the
     * step's own deadline would have said: a walk that gave up here used to
     * report `nothing came back after w` for a command nobody sent.
     */
    if (!this.stepSent) this.waitForSend(command);
    this.publish();
  }

  /** Ends the walk at a barrier, saying what the realm asked for and what this character has. */
  private stopRefused(step: RouteStep | undefined, barrier: string | undefined): void {
    const command = step?.command ?? t('automation.walk.fallbackMove');
    if (step === undefined || barrier === undefined) {
      this.stop(t('automation.walk.reasonRefused', { command }));
      return;
    }
    /*
     * Say what stood in the way. Somebody who turned bashing on and watched a
     * route stop at a door needs to see whether it was never tried, tried and
     * failed, or refused because the character is not strong enough — and the
     * three read identically from `the game refused w`.
     */
    this.stop(
      t('automation.walk.reasonBarrier', {
        barrier,
        command,
        detail: this.barrierDetail(step)
      })
    );
  }

  /** Why this barrier was not forced, in as many words. */
  private barrierDetail(step: RouteStep): string {
    const { movement } = this.config;
    if (this.picked > 0 || this.bashed > 0) {
      return t('automation.walk.barrierHeld');
    }
    if (!movement.pickLocks && !movement.bashDoors) {
      return t('automation.walk.barrierNotAllowed');
    }
    const need = step.requirement;
    const wanted = need?.pickDifficulty ?? need?.bashDifficulty;
    if (wanted === undefined) return t('automation.walk.barrierNotAllowed');
    return t('automation.walk.barrierTooHard', {
      wanted,
      picklocks: this.picklocks ?? t('automation.walk.barrierUnknownSkill'),
      strength: this.strength ?? t('automation.walk.barrierUnknownSkill')
    });
  }

  /** Everything remembered about the barrier at the step in flight. */
  private forgetBarrier(): void {
    this.opened = 0;
    this.bashed = 0;
    this.picked = 0;
    this.searched = 0;
    this.locked = false;
    this.forcing = null;
  }

  /**
   * Character state changed. This is where a step is confirmed.
   *
   * Called for every state change, most of which are not room changes, so the
   * cheap rejections come first.
   */
  onCharacter(state: CharacterState): void {
    /*
     * Kept whether or not a walk is running: the stat sheet arrives when it
     * arrives, and the moment a barrier is graded against these numbers is a
     * refusal off the wire with no state beside it.
     */
    this.strength = state.progress.strength;
    this.picklocks = state.progress.picklocks;

    if (this.status !== 'walking' || this.route === null) return;

    if (fightIsRunning(state)) {
      this.fightClearedAt = null;
      /*
       * A route waits the fight out; a loop's leg and a retreat still end
       * here. See `start`'s `resumeAfterFight` for why those two differ, and
       * `holdForFight` for what waiting costs.
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
       * `leavingAFight` in `start`.
       */
      if (!this.leavingAFight && this.answerFight()) return;
    } else {
      // Out of it. Anything that starts from here is a fight nobody asked
      // about, and holds for it as usual.
      this.leavingAFight = false;
    }

    /*
     * The fight this route stood still for is over. Pick the journey back up
     * from wherever it actually left the character — which is not necessarily
     * where it started, and the step-confirmation below would read a room the
     * character was chased into as the route having gone wrong.
     */
    if (this.hold === 'fight') {
      this.resumeFromFight(state);
      return;
    }

    const step = this.route.steps[this.index];
    if (!step) return;

    const here = locate(state);
    // Not resolved yet, or the same room the step started from: the move has
    // simply not landed. The timeout is what stops this waiting forever.
    if (here === null) {
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
       */
      if (isBlinding(state.room.light)) {
        this.stop(t('automation.walk.reasonDarkUnresolved', { lightLevel: state.room.light }));
      }
      return;
    }
    if (here === step.from) return;

    if (here !== step.to) {
      this.stop(t('automation.walk.reasonWrongRoom', { roomName: state.room.name ?? here }));
      return;
    }

    this.clearTimer();
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
    this.index += 1;
    this.holds = 0;
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

    if (this.index >= this.route.steps.length) {
      this.status = 'arrived';
      this.reason = null;
      if (!this.quiet) this.events.notice?.(t('automation.walk.arrived', { stepName: step.name }));
      this.events.ended?.(true, null);
      this.publish();
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
    if (wasLeaving && fightIsRunning(state) && this.answerFight()) return;
    if (this.holdBeforeSending(state)) return;
    this.sendCurrent();
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
    // Health first, and outside the beat's budget — see `holdForHealth`.
    if (this.holdForHealth(state)) return true;
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
    if (fightIsRunning(state) && !this.leavingAFight) return this.answerFight();
    if (this.holds >= tuning().walk.maxHolds) return false;
    if (this.events.holdAt?.(state) !== true) return false;
    this.holds += 1;
    this.publish();
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (this.status !== 'walking') return;
      /*
       * **Re-asked, not resumed.** This went straight to `sendCurrent` and
       * therefore held exactly once — one beat of 1,500ms — whatever the
       * answer had become, which made `tuning.walk.maxHolds` unreachable and the
       * documented "re-asks on a short timer" false. One beat is one round
       * trip: enough for a monster that is *going* to be engaged, and not
       * enough for one whose engagement is waiting on anything at all.
       *
       * Asking again is what makes the bound mean something. `holds` is reset
       * on every confirmed step, so the three are three at *this* step; a
       * quarry nothing will engage costs 4.5 seconds and then the walk goes
       * on, which is the whole reason there is a bound rather than a wait.
       */
      if (this.holdBeforeSending(this.events.stateNow?.() ?? state)) return;
      this.sendCurrent();
    }, tuning().walk.holdMs);
    this.holdTimer.unref?.();
    return true;
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
   *   `onBlock` already stops the walk for. **On a stock configuration none of
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
  /**
   * What a running walk does about a fight around it: hold, or end.
   *
   * One function because it is asked from two places and they must not drift —
   * `onCharacter`'s own branch, and again the moment a step lands, where the
   * exemption for the fight a walk was asked to leave has just expired. It
   * answers **true when the caller should stop processing**, which is either
   * way: a hold has been taken, or the walk has been stopped.
   */
  private answerFight(): boolean {
    if (this.holdForFight()) return true;
    this.stop(
      this.resumeAfterFight
        ? t('automation.walk.reasonFightUnending')
        : t('automation.walk.reasonCombat')
    );
    return true;
  }

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
       * to answer, and leaving `waitForPrompt` armed would stop the walk in
       * the middle of the fight it is waiting out. What replaces them is the
       * hold's own re-ask below, and `fightClearedAt`'s patience after it.
       */
      this.clearTimer();
      /*
       * Anything still queued goes with it, for `stop`'s reason: a movement
       * intent that reaches the wire mid-round walks the character out of a
       * fight it is in. What has already gone cannot be recalled, which is
       * what `resumeFromFight` waits for.
       */
      this.cancelQueued();
      this.hold = 'fight';
      this.publish();
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
   * duplicate-move bug in `start` wearing a different hat:
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
  private resumeFromFight(state: CharacterState): void {
    const route = this.route;
    if (route === null) return;
    this.fightHeldSince = null;
    if (this.fightClearedAt === null) this.fightClearedAt = Date.now();
    const spent = Date.now() - this.fightClearedAt;
    const patience = this.config.walk.stepTimeoutMs;

    const step = route.steps[this.index];
    if (!step) {
      // Out of range with the walk still running is a bug rather than a state;
      // the re-ask keeps the hold on a clock instead of leaving it a dead end.
      this.reaskAfter();
      return;
    }

    if ((this.movesInFlight() ?? 0) > 0) {
      /*
       * Named as what it is. Reading this as *"the client could not place the
       * character"* sends whoever meets it an hour later to look at room
       * resolution, when the client knows exactly where it is and is waiting
       * on a command the server never answered.
       */
      if (spent >= patience) {
        this.stop(t('automation.walk.reasonMoveUnanswered', { command: step.command }));
      } else this.reaskAfter();
      return;
    }
    const here = locate(state);
    if (here === null) {
      if (state.room.ambiguous > 1) {
        this.stop(t('automation.walk.reasonAmbiguous'));
        return;
      }
      if (spent >= patience) this.stop(t('automation.walk.reasonLostAfterFight'));
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
      this.carryOn(state);
      return;
    }

    const destination = route.steps.at(-1)!;
    const replanned = this.events.replan?.(destination.to);
    if (replanned === undefined) {
      // Nobody can plan for this walker, so a character that moved during the
      // fight is exactly the off-path case it has always stopped for.
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
       * The fight ended in the room the route was heading for — chased into
       * it, or the last step landed and its answer arrived among the combat
       * lines. The journey is over, and it is over the way it was asked for.
       */
      this.clearTimer();
      this.hold = null;
      this.fightClearedAt = null;
      this.status = 'arrived';
      this.reason = null;
      if (!this.quiet) {
        this.events.notice?.(t('automation.walk.arrived', { stepName: destination.name }));
      }
      this.events.ended?.(true, null);
      this.publish();
      return;
    }
    this.route = replanned;
    this.index = 0;
    this.carryOn(state);
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
     * is still armed — and `holdForHealth` and the quarry beat below both
     * assign `holdTimer` outright, so leaving it would orphan a timer that
     * wakes the walk again for a decision already made.
     */
    this.clearTimer();
    this.hold = null;
    this.fightClearedAt = null;
    this.fightHeldSince = null;
    this.holds = 0;
    this.publish();
    this.sneakFirst(state);
    if (this.holdBeforeSending(state)) return;
    this.sendCurrent();
  }

  /**
   * Ahead of the next step, when the character is meant to be sneaking and is
   * not.
   *
   * `start` does this before a route's first step because what it decides is
   * whether the things in the *next* room notice the arrival. A fight breaks
   * stealth, so without asking again here every step of a resumed journey was
   * taken in plain sight by a character configured to sneak, and nothing said
   * so — which is exactly what `Stealth` is three-state for: `unknown` is not
   * `sneaking`, and a character that believes it is hidden and is not walks
   * into a lair in the open.
   */
  private sneakFirst(state: CharacterState): void {
    if (!this.config.movement.sneak || state.stealth === 'sneaking') return;
    this.queue.enqueue({
      command: 'sn',
      priority: 'movement',
      coalesceKey: 'sneak',
      reason: t('automation.walk.reasonSneak')
    });
  }

  /**
   * Ask again in a beat, against the state as it will be then.
   *
   * The re-ask every hold in this class shares. A held walk has no wire event
   * left to wake it — `*Combat Off*` is a state change and arrives, but the
   * move that is still in flight, the room that has not been placed and the
   * health that has not come back are all things that change without one — so
   * the hold owns a clock, checks rather than trusts it, and reads
   * `stateNow()` because the state the hold began with is a second and a half
   * stale by the time this runs.
   */
  private reaskAfter(): void {
    if (this.holdTimer !== null) return;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (this.status !== 'walking') return;
      const now = this.events.stateNow?.();
      if (now) this.onCharacter(now);
    }, tuning().walk.holdMs);
    this.holdTimer.unref?.();
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
   * Three properties it does not share with the beat below it:
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
   * Said out loud on the way in and on the way out, because a route reading
   * *29 steps to Bank of Godfrey* that does not move is otherwise
   * indistinguishable from a broken client — and silent for a loop's own leg,
   * which reports its holds itself.
   */
  private holdForHealth(state: CharacterState): boolean {
    if (!this.wantsHealthHold(state)) {
      if (this.hold !== null) {
        this.hold = null;
        if (!this.quiet) this.events.notice?.(t('automation.walk.healthResumed'));
        this.publish();
      }
      return false;
    }

    if (this.hold === null) {
      this.hold = 'health';
      if (!this.quiet) this.events.notice?.(t('automation.walk.healthHolding'));
      this.publish();
    }

    /*
     * Re-asked on the beat's own timer rather than waiting on a state push:
     * `holdAt` already established that a walk decides on a clock here, and
     * health arrives on every status line anyway, so the answer is never more
     * than one tick stale.
     */
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (this.status !== 'walking') return;
      if (this.holdBeforeSending(this.events.stateNow?.() ?? state)) return;
      this.sendCurrent();
    }, tuning().walk.holdMs);
    this.holdTimer.unref?.();
    return true;
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

  private sendCurrent(fresh = true): void {
    const step = this.route?.steps[this.index];
    if (!step) return;

    // A retry behind a door is the *same* step, so its door budget carries over
    // rather than starting again — otherwise `openTries` would never be reached.
    if (fresh) this.forgetBarrier();
    /*
     * Whatever must go ahead of the step, before the step is queued: the two
     * share a band and the arbiter keeps a band in order, so a torch asked
     * for here is lit before the character moves. Only a fresh send — a
     * retry behind a door is the same step into the same room.
     */
    if (fresh) {
      const now = this.events.stateNow?.();
      if (now !== undefined) this.events.beforeStep?.({ name: step.name, light: step.light }, now);
    }
    this.events.stepping?.(step.command, step.direction, step.to);
    this.stepSent = false;
    const queued = this.queue.enqueue({
      command: step.command,
      priority: 'movement',
      // Never coalesced: a second `n` is a different move, which is exactly the
      // distinction text-matching de-duplication cannot make.
      reason: t('automation.walk.reasonStepping', { stepName: step.name }),
      onSent: () => this.noteStepSent(step, step.command)
    });
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
      this.stop(t('automation.walk.reasonNotQueued', { command: step.command }));
      return;
    }

    // Only when it has not already gone out from inside `enqueue`: the send
    // is synchronous whenever the queue is idle, which is most of the time.
    if (!this.stepSent) this.waitForSend(step.command);
    this.publish();
  }

  /** The step is on the wire, so the wait becomes a wait on the server. */
  private noteStepSent(step: RouteStep, command: string): void {
    // A late `onSent` from an intent this walk has moved past decides nothing:
    // `stop` cancels what is still queued, but a send racing the cancel would
    // otherwise re-arm a deadline for a step nobody is walking any more.
    if (this.status !== 'walking' || this.route?.steps[this.index] !== step) return;
    this.stepSent = true;
    this.stepSentAt = Date.now();
    this.waitForAnswer(step, command);
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
    this.clearTimer();
    this.waitedToSend = 0;
    this.pollForSend(command);
  }

  /** One beat of the send wait — see `waitForSend` for why it is a tally. */
  private pollForSend(command: string): void {
    const beat = tuning().walk.nudgeAfterMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.status !== 'walking') return;
      if (!this.queue.snapshot.suppressed) this.waitedToSend += beat;
      if (this.waitedToSend < this.config.walk.stepTimeoutMs) {
        this.pollForSend(command);
        return;
      }
      this.stop(t('automation.walk.reasonNotSent', { command }));
    }, beat);
    this.timer.unref?.();
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
  private waitForAnswer(step: RouteStep, command: string): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.status !== 'walking') return;
      this.nudge(step, command);
      this.waitForPrompt(command);
    }, this.nudgeAfter());
    this.timer.unref?.();
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
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.stop(t('automation.walk.reasonTimeout', { command }));
    }, this.config.walk.stepTimeoutMs);
    this.timer.unref?.();
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
   * accounted for.
   *
   * What it still takes is the **teleport promise** — `takeTeleport()` is spent
   * by any room block carrying a name, before anything decides whose it is —
   * which is why the portal refusal below has not moved and must not.
   */
  private nudge(step: RouteStep, command: string): void {
    /*
     * **Never behind a portal.** A move's reprint is bounded on the other side
     * too — `CharacterTracker` leaves a pending move alone when the block
     * names the room already resolved and the move predicts a different one —
     * and a *teleport* has no such discriminator: `takeTeleport()` spends the
     * promise unconditionally and only then decides whether to apply it. So a
     * reprint of the room being left would throw away the coordinates the
     * script stated, and the real arrival would resolve by name alone — which
     * across 293 rooms called Sewer Tunnel is the ambiguity this client
     * refuses to guess at. One step waits out its full deadline instead.
     */
    if (step.direction === 'portal') return;
    this.queue.enqueue({
      command: REREAD_ROOM,
      priority: 'probe',
      coalesceKey: NUDGE_KEY,
      reason: t('automation.walk.reasonNudge', { command })
    });
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

  private clearTimer(): void {
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
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

/** Where the character is, or null when the client does not actually know. */
/**
 * Whether a skill is worth spending a command against a barrier's number.
 *
 * `stated` is whether the realm named *any* number for this barrier: when it
 * named none it asks for no skill, which is the plain `Door` the router
 * already priced as ordinary. When it named one for the other channel only —
 * `Key: 2126 [or 157 picklocks]` says nothing about strength — this channel is
 * closed rather than free, because the realm has been specific.
 *
 * `0` is the realm's `any`: whoever leans on it gets through.
 *
 * An unknown skill never meets a stated number. That is the same direction
 * every threshold in this client takes — unknown is not plenty — and here it
 * is also the cheap one: the stat sheet is one `st` away.
 */
function meetsBarrier(
  need: number | undefined,
  skill: number | null,
  margin: number,
  stated: boolean
): boolean {
  if (!stated) return true;
  if (need === undefined) return false;
  if (need <= 0) return true;
  return skill !== null && skill >= need - margin;
}

function locate(state: CharacterState): string | null {
  const { map, number } = state.room;
  if (map === null || number === null) return null;
  return roomId(map, number);
}
