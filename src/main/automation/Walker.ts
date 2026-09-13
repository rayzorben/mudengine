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
import {
  afflictionHolding,
  type WalkHold,
  type WalkProgress,
  type WalkStatus
} from '../../shared/walk';
import {
  roomId,
  asSpokenDirection,
  type Direction,
  type RemoteLever,
  type RoomId,
  type Route,
  type RouteStep,
  asRoomReference,
  trapOn
} from '../../shared/world';
import type { Block } from '../../shared/blocks';
import { REREAD_ROOM } from '../../shared/commands';
import { isBlinding, type CharacterState } from '../../shared/character';
import { resumeAtHealth, type AutomationConfig } from '../../shared/config';
import { t } from '../app/i18n';
import type { CommandQueue } from './CommandQueue';
import { tuning } from '../app/tuning';
import { openableHere } from '../../shared/world';

/**
 * The attempt on a barrier that is on the wire, while it is.
 *
 * `open` is one of them rather than a fire-and-forget: its answer decides the
 * next rung, and the step is no longer queued behind it — see `sendOpen`.
 */
type Forcing = 'bash' | 'pick' | 'open' | 'key';

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
   * The name to type for the key an exit demands, when this character is
   * carrying it — and null when it is not, or when the realm cannot name the
   * row.
   *
   * The walker holds a route and no realm and no pack, so both halves are
   * asked of the session, which owns the world data and the character. It
   * answers with a **name** rather than a row id because the command is
   * `use <item> <direction>` and the last word is the exit
   * (`UseCommand.cs` takes `splitcommand[length - 1]` as the exit name), so
   * what goes on the wire is the realm's own spelling of the item.
   */
  keyToUse?(keyId: number): string | null;
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
  refused?(from: RoomId, direction: Direction | 'portal', why: 'missing' | 'shut'): void;
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
  /**
   * Every lever the realm says opens this exit, and where each is pulled.
   *
   * Asked rather than worked out here for `replan`'s reason: the answer is an
   * index over every room in the realm and the walker holds a route and a
   * queue and deliberately not the world. Absent, or empty, means the realm
   * names nothing that opens this — which is every exit but 225 of them.
   */
  leversFor?(from: RoomId, direction: Direction): readonly RemoteLever[];
  /**
   * A route between two rooms neither of which is where the character is
   * standing.
   *
   * `replan` answers *from here*, which is every question a walk asks except
   * one: whether a **set** of levers in several rooms can be walked at all.
   * That is all or nothing — pulling some of them spends commands on a passage
   * that stays shut, which is `buildRealm`'s own reason for refusing to write
   * a half-matched `actions` list — so the whole run is checked before the
   * first lever, and legs two onwards start somewhere the character is not yet.
   *
   * Absent means the run cannot be checked, and an unchecked all-or-nothing
   * journey is not one to start.
   */
  routeBetween?(from: RoomId, to: RoomId): Route | string;
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
  /**
   * Whether the key has already been tried against the barrier in the way.
   *
   * A flag rather than a count, and it is the difference between this rung and
   * the two under it: picking and bashing are rolls that are worth repeating,
   * and a key either matches the door's row or does not. Sending it twice in
   * one run of the ladder would spend a command to be told `Your command had
   * no effect.` a second time.
   *
   * Cleared with the other two, so `holdAtBarrier` running the ladder again
   * does try the key again — which is what answers the door the server
   * re-locks behind the character on its own timer.
   */
  private keyed = false;
  private locked = false;
  /**
   * How many times the whole ladder has been run again at the barrier the step
   * in flight is standing at.
   *
   * Not per step like the three above — those are reset every time the step is
   * sent, which is exactly what a retry does, so a counter reset there could
   * never bound anything. This one is cleared by a **confirmed step**: the
   * fact that says the character got past the door. See `holdAtBarrier`.
   */
  private barrierRounds = 0;
  /** Searches spent looking for the hidden exit at the step in flight. */
  private searched = 0;
  /**
   * The server has said it found this step's hidden exit.
   *
   * **The bound on a search rung that otherwise has none.** `mustSearchFirst`
   * decides *is it open yet* from the room's own `Obvious exits:` line, which
   * is right — a found exit joins it, so a lap pays for one search and no more
   * — and it is a line this client does not always read: `open trap door
   * below` was a direction `parseExit` had no word for until today, and a
   * realm may qualify one some third way tomorrow. With no ceiling on the
   * searching (todo 04) and no blame written down for a searchable edge, a
   * walk that could not recognise its own success searched every 1.5s forever
   * and said so once every five minutes.
   *
   * `You found an exit …!` is the server saying so outright, which outranks
   * reading it back off a list. Cleared with the rest of the step's budget.
   */
  private found = false;
  /**
   * When the line about that search was last said. Zero so the first one
   * always speaks; see `holdSearching` for why it speaks again.
   */
  private searchSaidAt = 0;
  /**
   * Rounds of levers pulled at the step in flight — format 23's other kind of
   * hidden exit. Counted separately from `searched`: an exit is one or the
   * other, and one budget for two remedies would let a search spend the pulls.
   */
  private levered = 0;
  /**
   * The lever this walk has gone to fetch, and the journey it interrupted.
   *
   * A route that reaches a gate it cannot open asks the realm what does open
   * it (`leversFor`); where the answer is a lever in another room, the walk
   * **goes and pulls it** and then plans on to where it was going. That is one
   * errand, held here, and it is the reason the arrival at the lever's room is
   * not an arrival: `ended` must not fire, or a loop reading it would book the
   * leg as arrived and advance to the next stop while the gate is still shut.
   *
   * Null for every walk that is not fetching one, which is nearly all of them.
   */
  private errand: {
    /** The lever rooms still to visit, in the order they are to be visited. */
    rooms: Array<{ at: RoomId; say: string[] }>;
    back: RoomId;
    backName: string;
  } | null = null;
  /**
   * The exits this walk has already made that errand for, `from|direction`.
   *
   * Bounded per walk rather than per step, because the errand *replaces the
   * route* — the step counters are reset by the walk to the lever, so a
   * counter could never bound this. Once is the whole budget that makes sense:
   * a lever pulled that did not open the gate is not a lever that opens it,
   * and walking back for it again is a lap of a corridor spent on the same
   * refusal. Cleared by `start`, so the next leg of a loop may try again — the
   * gate may have shut behind the character.
   */
  private detoured = new Set<string>();
  /** Whether this step's unreachable levers have been reported. Said once. */
  private leverSaid = false;
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
  private hold: WalkHold = null;
  /**
   * The health the step ahead wants before its trap is walked into, while
   * the walk stands still for it — `holdForTrap`. Null otherwise. Read by
   * `Recovery` through the session, which is what makes the hold end: a
   * trap floor is above `restBelow` by construction, so nothing else would
   * sit the character down to it.
   */
  private trapFloor: number | null = null;
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
   * Whether the client could have ended a fight when this hold was taken.
   *
   * The hold's own reason, kept so its **withdrawal** can be noticed: a
   * configuration that never could fight is the stock one and holds as it
   * always has, bounded by `fightHoldMs`. Cleared when it is acted on, so one
   * hold produces one decision and one line.
   */
  private fightHeldCouldEnd = false;
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
   * Cleared on every send, so it describes this attempt and no earlier one.
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
      done: this.index,
      total: this.route?.steps.length ?? 0,
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
  get holding(): WalkHold {
    return this.status === 'walking' ? this.hold : null;
  }

  /**
   * The hit points the walk is resting towards before the trap ahead, or
   * null when it is not standing still for one. `Recovery.needAtLeast` reads
   * it, so the rest that ends this hold is proposed by the module that owns
   * resting rather than by a second `rest` sender.
   */
  get restingFor(): number | null {
    return this.holding === 'trap' ? this.trapFloor : null;
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
      resumeAfterLoss = true
    }: {
      quiet?: boolean;
      asked?: boolean;
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
     * **That is still true of the refusal and no longer true of the step**
     * (2026-09-06). The walk always *starts*; whether its first step goes out
     * over a live fight is `leavingAFight`'s question further down, and the
     * answer now depends on whether anything this client runs would end that
     * fight. Walking out is the escape for a character that will not fight;
     * for one whose `combat.whileWalking` says *finish them on the way*, it
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
    this.barrierRounds = 0;
    /*
     * A door another walk found locked says nothing about this one's, which
     * may not even pass the same room — and the errand belongs to the journey
     * that was interrupted, which this replaces.
     */
    this.forgetLock();
    this.errand = null;
    this.detoured.clear();
    this.leverSaid = false;
    // A health hold belongs to the walk that was waiting, not to the next one:
    // left set, a fresh route would be measured against the *resume* ceiling
    // before it had held for anything, and would announce recovering from a
    // hold it never took.
    this.hold = null;
    this.fightClearedAt = null;
    this.fightHeldSince = null;
    this.heldSince = null;
    this.onsetAnsweredStep = null;
    // An escape belongs to the walk that ran away. A fresh route is the player
    // asking again, from here, with that already taken into account.
    this.escaped = false;
    // After the refusals, so a walk that was declined does not leave the next
    // one — which may be a plain one — inheriting this one's silence.
    this.quiet = quiet;
    this.asked = asked;
    this.holdWhenHurt = holdWhenHurt;
    this.resumeAfterFight = resumeAfterFight;
    this.fightHeldCouldEnd = false;
    this.resumeAfterLoss = resumeAfterLoss;
    /*
     * Asked for while a fight was running, so this walk's job is to leave it —
     * **but only when leaving is what ends the fight**.
     *
     * Without the exemption at all, the refusal above would simply have become
     * a *hold*: the very next status line would put the route in a `fight`
     * hold and it would stand still until the fight was over — the same
     * standing still, now silent, which is worse than the refusal it replaced.
     * That is the whole argument for it, and it holds exactly as far as
     * `canEndAFight` says nothing else will: on this realm walking out of the
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
     * with `combat.enabled`, `retaliate` **and `whileWalking` all on**. Three
     * settings say *finish fights while walking* and this one line overrode
     * every one of them.
     *
     * `AutoCombat.quarry` already reads `whileWalking` for precisely this —
     * the walker holds a step out of a room engagement would open on — but
     * that path sits *below* this flag in `holdBeforeSending`, so it was never
     * asked. `canEndAFight` is the predicate that was missing, and it is the
     * one `answerFight` already uses for the mirror case: a hold whose reason
     * is *withdrawn* mid-fight walks on. This is that sentence read forwards.
     *
     * **`resumeAfterFight` is the other half, and the retreat is why.** A walk
     * that does not hold for fights answers one by *stopping* (`answerFight`),
     * so a `safe-haven` escape — `resumeAfterFight: false`, `whileFighting`
     * left at the player's default — would have stopped itself on the very
     * fight it was planned to run from. A walk that will not wait one out is
     * always leaving one.
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
    this.leavingAFight = fightIsRunning(from) && (!this.resumeAfterFight || !this.canEndAFight());
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
    this.clearTimer();
    // The outstanding step is not going to be answered as this step any more,
    // so the clock it was being timed against goes with it. See `answers`.
    this.stepSentAt = null;
    this.cancelQueued();
    this.status = 'stopped';
    this.reason = reason;
    /*
     * The errand dies with the journey it was for. Left standing, the next
     * walk's arrival would pull a lever for a gate nobody is going through --
     * `start` clears it too, and both are here because a stopped walk that is
     * never restarted must leave nothing armed.
     */
    this.errand = null;
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
    this.asked = true;
    this.trapFloor = null;
    this.fightClearedAt = null;
    this.fightHeldSince = null;
    this.heldSince = null;
    this.onsetAnsweredStep = null;
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
    this.barrierRounds = 0;
    this.forgetBarrier();
    /*
     * And the same group again, for the state added with the lever errand.
     * `start` clears all four before anything can act on them, so today this is
     * belt and braces — which is precisely the argument four lines up, and the
     * reason `locked` is here rather than left to `forgetBarrier`: it stopped
     * being part of that reset when a lock had to survive a barrier round.
     */
    this.forgetLock();
    this.errand = null;
    this.detoured.clear();
    this.leverSaid = false;
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
   *
   * And nothing waits for an answer it already has. `The gate is locked.` is
   * the whole of the news; the move queued behind the `open` that provoked it
   * is taken back rather than sent to be refused — see `onOpenRefused`.
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
        this.onOpenRefused(block);
        return;
      case 'bash-failed':
        // Only when the walker is the one bashing. A hand-typed `bas` at a
        // door the player is dealing with themselves is not the walk's news.
        if (this.forcing === 'bash') this.forceAgainOrHold();
        return;
      case 'skill-failed':
        // The same sentence answers a failed trap disarm, so it means "the
        // pick missed" only while the walker has one in flight.
        if (this.forcing === 'pick') this.forceAgainOrHold();
        return;
      case 'command-no-effect':
        /*
         * What `Door.TryUnlock` answers a key that does not match the door's
         * row with — the same sentence the server gives every command it could
         * not carry out, which is why this is read **only** while this walk has
         * a `use` of its own in flight. It is the commonest line in the game
         * after the status line, and acting on it unguarded would end a walk
         * every time the player typed at something that was not there.
         */
        if (this.forcing === 'key') this.forceAgainOrHold();
        return;
      case 'door-changed':
        this.onBarrierChanged(block);
        return;
      case 'user-search-succeeded':
      case 'user-search-failed':
        this.onSearchAnswered(block);
        return;
      case 'spell-onset':
        // Only while this walk's own step is on the wire with nothing back —
        // see `onsetAnsweredStep`. An onset at any other moment is an effect
        // landing and refuses nothing.
        if (this.stepSent) this.onsetAnsweredStep = block.at;
        return;
      default:
        return;
    }
  }

  /**
   * `open` came back refused, so that rung is spent and the next one is taken
   * now.
   *
   * **The step is no longer queued behind the `open`**, which is what makes
   * this worth reading at all. It used to be, so that the `direction-failed`
   * it came back with would take the next rung — a move sent to be told `The
   * gate is closed!` a second time, out of the budget the walk is walked with.
   * Reported from the wire with the whole exchange in it:
   *
   *     [HP=112/MA=16]:e          The gate is closed!
   *     [HP=112/MA=16]:open e     The gate is locked.
   *     [HP=112/MA=16]:e          The gate is closed!   <- this one
   *     [HP=112/MA=16]:bas e      You bashed the gate open.
   *
   * Cancelling it from the queue instead does not work and looking at why is
   * the useful part: the queue's window is three commands and its gap is
   * 350ms, while this realm answers a command in a measured 1,239ms — so the
   * step is on the wire long before its answer could recall it. *A sent
   * command cannot be recalled* is the rule, and the fix has to be not sending
   * it. `sendOpen` therefore waits for the `open`'s own answer, of which this
   * is one and `door-changed` is the other.
   *
   * `The door is locked.` additionally spends **every** remaining `openTries`:
   * a lock answers the same word every time, so repeating the rung is a
   * command per attempt spent to be told what the client already knows. The
   * other shape (`That is not a door or a gate!`) leaves the budget alone and
   * simply moves on, because it says the realm data was wrong about the
   * barrier rather than anything about a lock.
   */
  private onOpenRefused(block: Block): void {
    if (this.forcing !== 'open') return;
    this.forcing = null;
    if (block.groups['reason'] === 'locked') this.locked = true;

    const step = this.route?.steps[this.index];
    if (step === undefined) return;
    const barrier = block.groups['barrier'] ?? t('automation.walk.fallbackBarrier');
    if (this.force(step, barrier)) return;
    this.holdAtBarrier(step, barrier);
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
        this.sendOpen(step, barrier);
        return;
      }
      if (this.force(step, barrier)) return;
      /*
       * Every rung spent and the way still shut. It waits and runs the ladder
       * again rather than ending the journey — see `holdAtBarrier`.
       */
      this.holdAtBarrier(step, barrier);
      return;
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
      if (this.pullLevers(step)) return;
      /*
       * A remote-action exit is the fourth of that sentence's four causes
       * (docs/greatermud/movement.md) and the one the client could do
       * something about and did not. See `fetchLever`.
       */
      if (this.fetchLever(step)) return;
      /*
       * **What is written down is which of the two the refusal was**, because
       * the sentences are not interchangeable and the wrong one was being
       * said. `The realm data promised an exit n that the realm refuses` is
       * true of a corridor the data invented; said about a `Hidden/Needs 2
       * Actions` exit it accuses the realm data of exactly the thing the realm
       * data got right — the exit is real and it is shut. Reported as todo 04
       * with the room number in it (`1/1056`), and the exit is in the file,
       * with both its levers.
       */
      if (this.blameable(step)) {
        this.events.refused?.(step.from, step.direction, this.shutRatherThanMissing(step));
      }
    }
    this.stopRefused(step, barrier);
  }

  /**
   * Looks for the hidden exit the realm says is there, and **keeps looking**.
   * Returns whether anything was sent.
   *
   * A `Hidden/Searchable` exit answers a bare direction with `There is no exit
   * in that direction!` until it has been found, so the refusal is not news —
   * it is the step the realm data already described, and `edgePenalty` priced
   * the search into the route when it chose this leg.
   *
   * **It searches until it works** (todo 04, 2026-09-06). It used to be
   * bounded at `searchTries`, after which the walk gave up and struck the edge
   * out — and the reported transcript is exactly that: two searches at Outer
   * Keep 1/1368, the route stopped, the corridor blacklisted, and a hand-typed
   * `sea s` a moment later answering `You found an exit to the south!`. The
   * realm's own data says a search reveals this one; a client that stops
   * asking has decided the realm is wrong on two rolls of a skill check. And
   * the person it stops belongs to stated the trade: *the player would prefer
   * the slowdown over coming back to his character stopped after being gone 8
   * hours.*
   *
   * **The unbounded set is narrow and the realm chose it.** Only an edge the
   * realm marks `Hidden/Searchable` — 251 of the shipped file's 1,469 hidden
   * exits — reaches here.
   * Every other refusal is blamed and written down after one, exactly as
   * before, so a corridor that genuinely no longer exists is still struck out.
   *
   * **Paced by a floor, not by a count**, and the walk *holds* rather than
   * marching on: `searchRetryMs` is the beat, `WalkHold` says `searching`, and
   * `holdBeforeSending` is what stops the step going out at a wall it already
   * knows about.
   *
   * The answer (`You found an exit to the east!`) is deliberately not read —
   * the room reprints with the exit in its own list, which is what the step
   * ahead of it reads.
   */
  private searchFor(step: RouteStep): boolean {
    const need = step.requirement;
    if (need?.kind !== 'hidden' || need.searchable !== true) return false;
    this.holdSearching(step);
    return true;
  }

  /**
   * Sends one `search <direction>` and stands still for a beat.
   *
   * Shaped on `holdAtBarrier`, which answers the same question about a shut
   * door: the way is not open *this time round*, the reason is temporary, and
   * a route that ended there would have to be noticed and asked for by hand.
   * The one difference is that this has no ceiling — see `searchFor`.
   */
  private holdSearching(step: RouteStep): void {
    /*
     * Said when it starts and **again on a slow clock**, unlike the barrier's
     * one line: that hold lasts a round and ends the walk, where this one has
     * no ceiling and can outlast a lap. Said once, the reason a character is
     * standing in a corridor at 3am is a line eight hours up the scrollback —
     * the reviewer's find, 2026-09-06.
     */
    const now = Date.now();
    if (!this.quiet && now - this.searchSaidAt >= tuning().walk.searchSayEveryMs) {
      this.searchSaidAt = now;
      this.events.notice?.(t('automation.walk.searchHolding', { stepName: step.name }));
    }
    this.searched += 1;
    this.queue.enqueue({
      command: `search ${step.direction}`,
      priority: 'movement',
      /*
       * **Coalesced, because the searching has no ceiling.** The beat is
       * measured from the enqueue, not from the send, so while the queue is
       * holding — a half-typed line holds it for up to `abandonedLineMs` — one
       * more un-expiring `movement` intent piled up every `searchRetryMs` and
       * they all flushed together when the hold released. One search at a time
       * is what a search *means*, which is the queue's own rule: coalesce by
       * intent, never by command text. The key names the direction, so a
       * search of a different way is a different intent.
       */
      coalesceKey: `walk:search:${step.direction}`,
      reason: t('automation.walk.reasonSearching', { stepName: step.name })
    });
    this.armSearchBeat();
  }

  /**
   * Stands still for one beat and then asks the whole question again.
   *
   * Its own method because two things arm it — a search going out, and a
   * reprint asked for after one is answered — and the second has to measure the
   * beat from **its own** command rather than inheriting what is left of the
   * search's. A search is answered in about a round, so the remainder would
   * often be too short for the reprint to land, and the re-ask would send
   * another search at a room whose answer was still on the wire.
   */
  private armSearchBeat(): void {
    // The step's deadline was timing a move the refusal has already answered.
    this.clearTimer();
    this.hold = 'searching';
    this.publish();
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (this.status !== 'walking') return;
      /*
       * Let go before anything else is asked, exactly as the barrier's retry
       * does: `holdForHealth` claims a walk only when nothing else is holding
       * it, and a `searching` left standing here would silence the hold this
       * beat exists to give way to.
       */
      this.hold = null;
      const state = this.events.stateNow?.();
      if (state !== undefined && this.holdBeforeSending(state)) return;
      this.sendCurrent();
    }, tuning().walk.searchRetryMs);
    this.holdTimer.unref?.();
  }

  /**
   * The server answered a search, and the room on screen has not changed.
   *
   * **`You found an exit to the south!` does not reprint the room** — reported
   * as todo 03, with the wire under it: eleven `search s` at Outer Keep,
   * Intersection, seven of them answered `You found an exit to the south!`, and
   * not one step taken. The exit was found on the *first* one.
   *
   * `mustSearchFirst` reads the room block's own `Obvious exits:` line, which
   * is the right source — a found exit joins it, so a lap that found the way
   * once pays no search on the next lap. What was missing is anything to make
   * that source current, so the walk held on a line the server had already
   * superseded and asked again every beat, for as long as the character was
   * left alone.
   *
   * So the answer is one bare Enter (`REREAD_ROOM`, never `l` — a look
   * announces itself to everybody in the room), and the beat is re-armed from
   * it so the reprint has a full round to land.
   *
   * **Not every realm withholds the reprint**, and the claim here was once
   * written as though none reprinted at all. `captures/005:186` is a MajorMUD
   * realm answering `sear d` with `You found an exit downwards!` *and* the room
   * in the same breath. Where that happens this costs one bare Enter, once,
   * coalesced onto the nudge's own key — and the `found` flag rather than the
   * reprint is what actually ends the searching, so the extra command is the
   * whole of the cost on a realm that did not need it.
   *
   * **A failure asks too, every `searchRecheckEvery`th time**, which is the
   * other half of what was asked for. A success can be missed two ways — the
   * sentence arriving in a burst while the walk was not holding, and somebody
   * else opening the way — and the room is the only thing that actually
   * settles it. Counted rather than clocked, so a slow link does not change how
   * many searches it costs.
   */
  private onSearchAnswered(block: Block): void {
    if (this.hold !== 'searching') return;
    const step = this.route?.steps[this.index];
    if (step === undefined || step.direction === 'portal') return;
    /*
     * The server names the direction it searched, and a search the *player*
     * typed some other way is not this step's news. `Your search revealed
     * nothing.` names none, and an unnamed direction is taken as this one —
     * the walk is holding on a search of its own, and it is the only search
     * this client has out.
     */
    /*
     * Read through `asSpokenDirection`, because the server has more than one
     * word for the same way: `You found an exit downwards!` is the corpus's
     * only successful search and it says neither `down` nor `d`. A word this
     * client cannot read at all is treated as **this** step's, which is the
     * safe direction — the walk is holding on a search of its own and it is
     * the only search this client has out, so acting is at worst one bare
     * Enter and refusing would be the stuck search all over again.
     */
    const said = block.groups['direction']?.trim();
    const about = said === undefined ? null : asSpokenDirection(said);
    if (about !== null && about !== step.direction) return;

    if (block.type === 'user-search-succeeded') {
      // The one fact that ends the searching. See `found`.
      this.found = true;
    } else {
      const every = tuning().walk.searchRecheckEvery;
      if (every <= 0 || this.searched % every !== 0) return;
    }
    this.queue.enqueue({
      command: REREAD_ROOM,
      priority: 'probe',
      // The step nudge's key: both are *make the server reprint this room*,
      // and two bare Enters queued together would be one wasted and one
      // resolved against a step it does not answer.
      coalesceKey: NUDGE_KEY,
      reason: t('automation.walk.reasonRereading', { stepName: step.name })
    });
    this.armSearchBeat();
  }

  /**
   * Whether the room on screen has yet to print the hidden exit this step
   * needs — in which case the step is a command spent to be refused.
   *
   * *"Do not try the direction first unless it is available"* (todo 04): a
   * found exit joins the room's own `Obvious exits:` line — `secret passage
   * south`, which `parseExit` reads as `s` — so the room the character is
   * standing in already answers *is it open yet*. That is what keeps this from
   * being the pre-emptive search the reactive rung was written against: a lap
   * that found the exit once pays no search on the next lap, because the exit
   * is printed.
   *
   * **A room whose exits were never read proves nothing.** `exitsUnseen` —
   * a blinding room prints no list at all — so the step goes out and the
   * refusal, if it comes, is answered the way it always was.
   */
  private mustSearchFirst(state: CharacterState, step: RouteStep): boolean {
    const need = step.requirement;
    if (need?.kind !== 'hidden' || need.searchable !== true) return false;
    // The server said it found this one. That outranks reading it back off a
    // list the client may not be able to parse -- see `found`.
    if (this.found) return false;
    if (state.room.exits.length === 0) return false;
    return !state.room.exits.some((exit) => exit.direction === step.direction);
  }

  /**
   * Pulls the levers the realm says open this exit. Returns whether anything
   * was sent.
   *
   * The other kind of hidden exit, and the same rung as `searchFor` in every
   * respect that matters: the refusal is not news — it is the step the realm
   * data already described — the answer is reactive rather than pre-emptive so
   * a lap pays for it once, and `edgePenalty` charged the commands into the
   * route when it chose this leg.
   *
   * **Only where every lever is in this room** (`openableHere`, the one
   * reading the price also uses). A passage whose lever is two rooms away is a
   * detour the router does not plan, and pulling the levers that *are* here
   * would spend commands on a passage that stays shut. The realm's own order
   * is what `Requirement.actions` is sorted in, which is what `specific order`
   * wants; `any order` does not care, so one order serves both.
   *
   * The first phrase of each, because the realm lists its own spelling first
   * and the rest are synonyms for the same lever — `Requirement.commands` on a
   * text exit is read exactly this way.
   *
   * Reported as todo 01: the realm said a concealed passage led south out of
   * Small Chamber 10/4 and that `pull lever` opened it, in the room's own `W`
   * column; the converter dropped that column, the walk was refused, and a
   * real corridor was struck out of every route for the session.
   */
  private pullLevers(step: RouteStep): boolean {
    const need = step.requirement;
    if (!openableHere(need)) return false;
    if (this.levered >= tuning().walk.leverTries) return false;
    this.levered += 1;
    for (const act of need!.actions!) {
      const phrase = act.say[0];
      if (phrase === undefined) continue;
      this.queue.enqueue({
        command: phrase,
        priority: 'movement',
        reason: t('automation.walk.reasonLever', { stepName: step.name, phrase })
      });
    }
    // And the step again behind them, as `search` and `open` both do.
    // `sendCurrent` re-arms the deadline so the walk does not time out on the
    // levers' own round trip.
    this.sendCurrent(false);
    return true;
  }

  /**
   * Goes and pulls the lever that opens this step, wherever the realm keeps
   * it. Returns whether anything was sent.
   *
   * **The rung above every other one at a shut way**, and the only one that is
   * not a command sent at the door. It is reached once the ladder is spent —
   * `open` refused, nothing to force with — and once the two rungs that act on
   * a hidden exit in place have declined it.
   *
   * Reported as todo 01, from the wire: `Inner Gate`, `Obvious exits: closed
   * gate north`, a gate reading `Door [301 picklocks/strength]` against a
   * character with 0 picklocks and 86 strength, and the Guardroom **one room
   * west** holding the lever that raises it. The client sent `n` and `open n`
   * alternately until its budget ran out, wrote nothing down about the lever,
   * and the player walked west and typed `pull lever` themselves.
   *
   * ## Three shapes, and only two are acted on
   *
   * Measured over the shipped realm — 225 exits have a lever at all:
   *
   * | Where the levers are | Exits | What happens |
   * |---|---|---|
   * | all in the exit's own room | 171 | pulled in place, and the step again behind them |
   * | all in one other room | 35 | this errand: walk there, pull, plan on |
   * | spread over several rooms | 14 | refused, out loud |
   * | naming an exit the room does not have | 5 | nothing to route through |
   *
   * The first shape overlaps `pullLevers`, which serves the 150 of it whose
   * exit *states* `Needs N Actions`. The other 21 say `Door` and nothing else,
   * so nothing reading the requirement could ever have found them — which is
   * exactly the Inner Gate's shape one room closer.
   *
   * **Several rooms is refused rather than attempted.** A `specific order`
   * across two rooms is a journey with an ordering constraint, and pulling the
   * ones that are reachable spends commands on a passage that stays shut —
   * `buildRealm` already refuses to write `actions` for the same reason.
   *
   * ## Why it replaces the route rather than starting a new walk
   *
   * `start` raises `destination` and `ended`, and a loop reads both: an
   * arrival at the Guardroom would be booked as the leg arriving and the lap
   * would advance to the next stop with the gate still shut. So the route is
   * swapped in place and `carryOn` takes it from there — the same mechanism
   * `resumeFromFight` uses, and for the same reason.
   */
  private fetchLever(step: RouteStep): boolean {
    const route = this.route;
    if (route === null) return false;
    if (step.direction === 'portal') return false;
    /*
     * **Never while an errand is already running**, which is the one guard
     * that keeps this from eating the journey it was sent to serve.
     *
     * `detoured` is keyed by the *gate*, so a second gate met on the errand's
     * own route passes it — and `back` is taken from the route in flight,
     * which during an errand is the way to the lever rather than the way to
     * where the player asked to go. So the original destination is silently
     * replaced by a lever room, and arriving there fires `ended(true)`: the
     * exact false arrival this rung exists to avoid, a loop booking a leg it
     * never walked. For a set it is worse still, because the outer round is
     * abandoned half-pulled and the passage stays shut, which is the
     * all-or-nothing rule broken from the inside.
     *
     * A gate on the way to a lever is left to the ladder that was already
     * there: open, force, and then the barrier hold. One errand at a time.
     */
    if (this.errand !== null) return false;
    const key = `${step.from}|${step.direction}`;
    if (this.detoured.has(key)) return false;
    const levers = this.events.leversFor?.(step.from, step.direction) ?? [];
    if (levers.length === 0) return false;

    /*
     * Grouped by the room each is pulled in, in the order the realm listed
     * them — which is what `specific order` wants and what `any order` does
     * not care about, so one order serves both.
     */
    const rooms = new Map<RoomId, RemoteLever[]>();
    for (const lever of levers) {
      const held = rooms.get(lever.at);
      if (held) held.push(lever);
      else rooms.set(lever.at, [lever]);
    }

    /*
     * **A set spread over rooms is a round of them**, and the realm's own count
     * is what says it is a set: `buildRealm` writes `Requirement.actions` only
     * when the stated count matches the levers found, and this is that same
     * test asked of a journey rather than of a room. Eleven exits of the
     * shipped realm are `Needs N Actions` with N levers over several rooms —
     * six across two, two across three, two across four and one across seven.
     * `runLeverSet` walks them; it was a refusal until todo 04 reported one of
     * the six (`1/1056` north, two levers, `any order`).
     */
    const needed = step.requirement?.actionsNeeded;
    if (rooms.size > 1 && needed !== undefined && needed === levers.length) {
      return this.runLeverSet(step, key, rooms.size);
    }

    /*
     * Everything else names **alternatives**, and the realm says so two ways:
     * a count smaller than the levers found (`Needs 1 Actions` with a lever on
     * each side of the door — 2 exits), or no count at all, which is the
     * reported gate. `1/1331` north out of Inner Gate reads `Door [301
     * picklocks/strength]`, and the two Guardrooms flanking it — 1/1339 east
     * and 1/1345 west — each hold a lever. The wire settles which reading is
     * right: the player walked into **one** of them, typed `pull lever`, and
     * the gate came up.
     *
     * So one room is chosen and every lever in it is pulled: the room the
     * character is already standing in first, and otherwise the cheapest the
     * router will actually take us to.
     */
    const here = rooms.get(step.from);
    if (here !== undefined) {
      this.detoured.add(key);
      this.pull(here, step.name);
      this.sendCurrent(false);
      return true;
    }

    const state = this.events.stateNow?.();
    if (state === undefined) return false;

    let best: { at: RoomId; route: Route } | null = null;
    let why: string | null = null;
    for (const at of rooms.keys()) {
      const there = this.events.replan?.(at);
      if (there === undefined) return false;
      if (typeof there === 'string') {
        why ??= there;
        continue;
      }
      if (there.blocked || there.steps.length === 0) {
        why ??= there.reason ?? null;
        continue;
      }
      if (best === null || there.cost < best.route.cost) best = { at, route: there };
    }
    if (best === null) {
      /*
       * The realm names the lever and this client cannot get to it. Said out
       * loud, because a walk that then stands at the gate until its rounds run
       * out is otherwise indistinguishable from one that never knew — and
       * spent, so the barrier's remaining rounds do not each cost a route
       * search over the whole realm for the same answer.
       */
      this.detoured.add(key);
      this.sayLeverUnreachable(levers[0]!, why);
      return false;
    }

    const pulling = rooms.get(best.at)!;
    const destination = route.steps.at(-1)!;
    this.detoured.add(key);
    this.errand = {
      rooms: [{ at: best.at, say: pulling.map((lever) => lever.say) }],
      back: destination.to,
      backName: destination.name
    };
    if (!this.quiet) {
      this.events.notice?.(
        t('automation.walk.leverFetching', {
          phrase: pulling[0]!.say,
          roomName: pulling[0]!.roomName,
          stepName: step.name
        })
      );
    }
    this.route = best.route;
    this.index = 0;
    // The new route's first step is not behind the old door: its ladder, its
    // lock and the rounds run at it all belong to the step being left behind.
    // Set here rather than left to `sendCurrent`, which `carryOn` may hold.
    this.forgetBarrier();
    this.forgetLock();
    this.barrierRounds = 0;
    this.carryOn(state);
    return true;
  }

  /** Queues each lever in the room the character is standing in. */
  private pull(levers: readonly RemoteLever[], stepName: string): void {
    for (const lever of levers) {
      this.queue.enqueue({
        command: lever.say,
        priority: 'movement',
        reason: t('automation.walk.reasonLever', { stepName, phrase: lever.say })
      });
    }
  }

  /**
   * The errand is over: pull what was come for and plan on to where the walk
   * was going. Returns whether it took the arrival.
   *
   * The lever goes out ahead of the first step of the way back because the two
   * share the `movement` band and the arbiter keeps a band in order -- the same
   * property that puts a torch on the wire before the step it lights.
   *
   * **The way back is planned from here, before the lever has been answered**,
   * and that is deliberate: the router priced this gate as passable-but-dear
   * when it chose to come this way, and it will price it the same again. A
   * plan that waited for the gate to be seen open would need a room block
   * nobody has asked for.
   */
  private finishErrand(state: CharacterState): boolean {
    const errand = this.errand;
    if (errand === null) return false;
    const done = errand.rooms.shift();
    if (done === undefined) {
      this.errand = null;
      return false;
    }
    /*
     * The levers go out before the fight is consulted, deliberately. They are
     * `movement` band, so they displace no attack, and pulling the lever is the
     * whole reason the character walked here — holding it would leave the
     * errand standing in the lever room with the gate still shut, which is
     * strictly worse than one command spent mid-round. The **step** that
     * follows is held the ordinary way, by `carryOn`.
     */
    for (const phrase of done.say) {
      this.queue.enqueue({
        command: phrase,
        priority: 'movement',
        reason: t('automation.walk.reasonLever', { stepName: errand.backName, phrase })
      });
    }

    /*
     * The next lever room, or the journey the errand interrupted. Both are
     * planned from **here** through `replan`, because that is where the
     * character is standing now — `routeBetween` was only for checking the run
     * before any of it was walked.
     */
    const next = errand.rooms[0];
    const to = next?.at ?? errand.back;
    if (!this.quiet) {
      this.events.notice?.(
        next === undefined
          ? t('automation.walk.leverPulled', { destination: errand.backName })
          : t('automation.walk.leverNext', { roomCount: errand.rooms.length })
      );
    }
    const on = this.events.replan?.(to);
    if (on === undefined || typeof on === 'string') {
      this.errand = null;
      this.stop(on ?? t('automation.walk.refusalNoRoute'));
      return true;
    }
    if (on.blocked) {
      this.errand = null;
      this.stop(on.reason ?? t('automation.walk.refusalNoRoute'));
      return true;
    }
    if (on.steps.length === 0) {
      /*
       * Nowhere to walk.
       *
       * On the **last** leg that is the errand's own room being where the walk
       * was going, so this really is the arrival and falling through reports
       * one. On a **middle** leg it would mean two lever rooms resolving to the
       * same place, which `runLeverSet` cannot build — it groups by room — so
       * the branch is unreachable by construction rather than by argument. It
       * is answered anyway, by pulling what is there and asking again, because
       * the cost of being wrong about "cannot happen" here is an `ended(true)`
       * for a journey that has not finished.
       */
      this.errand = null;
      if (next === undefined) return false;
      this.errand = { ...errand, rooms: errand.rooms };
      return this.finishErrand(state);
    }
    if (next === undefined) this.errand = null;
    this.route = on;
    this.index = 0;
    // The way on starts at a fresh step, and the gate the errand was for is
    // several steps ahead rather than one command away.
    this.forgetBarrier();
    this.forgetLock();
    this.barrierRounds = 0;
    this.carryOn(state);
    return true;
  }

  /**
   * Walks a **set** of levers spread over several rooms, in the realm's own
   * order. Returns whether anything was sent.
   *
   * Reported as todo 04 and correctly guessed to be todo 01's: `Crypt, Stone
   * Hallway` 1/1056 leaves north through `Hidden/Needs 2 Actions, any order`
   * with a lever in 1/1038 and another in 1/1044. Todo 01 taught the client to
   * fetch **one** lever and refused this shape outright; the report is the
   * refusal, one room further on — the walk stopped, and the console said the
   * realm data had promised an exit that did not exist about an exit that does.
   *
   * Eleven exits of the shipped realm are this shape: six across two rooms,
   * two across three, two across four and one across seven; five say `any
   * order` and six `specific order`.
   *
   * - **The order is the realm's**, and it is `Requirement.actions` that has
   *   it: `buildRealm` sorts those by the realm's own lever index, where the
   *   room-command index this rung otherwise reads is in whatever order the
   *   rooms were loaded. So a set is refused outright when `actions` is absent
   *   or does not place every lever — with no stated order there is nothing to
   *   honour, and `specific order` is six of the eleven. That costs nothing:
   *   `actions` is written exactly when the realm's count matches the levers
   *   found, which is the same test that makes this a set at all.
   * - **The whole run is checked before the first lever.** All or nothing is
   *   what a set means, and pulling some of them spends commands on a passage
   *   that stays shut — `buildRealm`'s own reason for refusing a half-matched
   *   list. `replan` answers the first leg and `routeBetween` the rest, since
   *   those start somewhere the character is not yet.
   */
  private runLeverSet(step: RouteStep, key: string, rooms: number): boolean {
    const route = this.route;
    if (route === null) return false;
    const acts = step.requirement?.actions;
    if (acts === undefined || acts.some((act) => act.at === undefined)) {
      this.detoured.add(key);
      this.sayLeversScattered(step, rooms);
      return false;
    }

    /*
     * The rooms in the realm's order, each with every lever pulled in it — two
     * levers in one room are one visit, and the realm's order between them is
     * the order they are queued in.
     */
    const chain: Array<{ at: RoomId; say: string[] }> = [];
    for (const act of acts) {
      const at = roomId(act.at!.map, act.at!.room);
      const phrase = act.say[0];
      if (phrase === undefined) continue;
      const last = chain.at(-1);
      if (last?.at === at) last.say.push(phrase);
      else chain.push({ at, say: [phrase] });
    }
    if (chain.length === 0) {
      this.detoured.add(key);
      this.sayLeversScattered(step, rooms);
      return false;
    }

    const state = this.events.stateNow?.();
    if (state === undefined) return false;

    // Leg one from here; the rest between rooms the character is not in yet.
    const first = this.events.replan?.(chain[0]!.at);
    if (first === undefined) return false;
    let why: string | null = typeof first === 'string' ? first : null;
    let walkable = typeof first !== 'string' && !first.blocked;
    for (let leg = 1; walkable && leg < chain.length; leg += 1) {
      const between = this.events.routeBetween?.(chain[leg - 1]!.at, chain[leg]!.at);
      if (between === undefined || typeof between === 'string') {
        why ??= typeof between === 'string' ? between : null;
        walkable = false;
        break;
      }
      if (between.blocked) {
        why ??= between.reason ?? null;
        walkable = false;
      }
    }
    // And back to the gate, or the levers buy a room nothing can leave.
    if (walkable) {
      const home = this.events.routeBetween?.(chain.at(-1)!.at, step.from);
      if (home === undefined || typeof home === 'string' || home.blocked) {
        why ??= typeof home === 'string' ? home : (home?.reason ?? null);
        walkable = false;
      }
    }
    if (!walkable) {
      this.detoured.add(key);
      this.sayLeverRunRefused(step, rooms, why);
      return false;
    }

    const opening = first as Route;
    const destination = route.steps.at(-1)!;
    this.detoured.add(key);
    this.errand = { rooms: chain, back: destination.to, backName: destination.name };
    if (!this.quiet) {
      this.events.notice?.(
        t('automation.walk.leverRun', { roomCount: chain.length, stepName: step.name })
      );
    }
    /*
     * The first room being the one the character is standing in is possible in
     * principle and does not happen in the shipped realm — a set is only a set
     * because its levers span rooms, and if one of them were here the run
     * would start with nothing to walk. `finishErrand` handles it either way:
     * an empty leg pulls what is here and plans the next.
     */
    if (opening.steps.length === 0) return this.finishErrand(state);
    this.route = opening;
    this.index = 0;
    this.forgetBarrier();
    this.forgetLock();
    this.barrierRounds = 0;
    this.carryOn(state);
    return true;
  }

  /**
   * Whether this refusal is the way being **shut** rather than the corridor
   * being absent, which are two different things said two different ways.
   *
   * `There is no exit in that direction!` is the sentence a hidden exit gives
   * until it is opened — the realm data's own promise, kept. Only an exit the
   * realm records nothing about is the data having been wrong.
   */
  private shutRatherThanMissing(step: RouteStep): 'missing' | 'shut' {
    return step.requirement?.kind === 'hidden' ? 'shut' : 'missing';
  }

  /**
   * Said once per step: the levers are a set the realm places in several rooms
   * and the run through them cannot be walked.
   *
   * Distinct from `sayLeversScattered`, which is the realm not stating an
   * order to walk them in. Both leave the way shut; a player reading the
   * console needs to know which, because only one of them is something they
   * can go and do by hand.
   */
  private sayLeverRunRefused(step: RouteStep, rooms: number, why: string | null): void {
    if (this.leverSaid || this.quiet) return;
    this.leverSaid = true;
    this.events.notice?.(
      t('automation.walk.leverRunRefused', {
        stepName: step.name,
        roomCount: rooms,
        reason: why ?? t('automation.walk.refusalNoRoute')
      })
    );
  }

  /** Said once per step: the realm keeps this exit's levers in several rooms. */
  private sayLeversScattered(step: RouteStep, rooms: number): void {
    if (this.leverSaid || this.quiet) return;
    this.leverSaid = true;
    this.events.notice?.(
      t('automation.walk.leversScattered', { stepName: step.name, roomCount: rooms })
    );
  }

  /** Said once per step: the lever is named and there is no way to it. */
  private sayLeverUnreachable(lever: RemoteLever, why: string | null): void {
    if (this.leverSaid || this.quiet) return;
    this.leverSaid = true;
    this.events.notice?.(
      t('automation.walk.leverUnreachable', {
        phrase: lever.say,
        roomName: lever.roomName,
        reason: why ?? t('automation.walk.refusalNoRoute')
      })
    );
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
    if (need?.kind !== 'hidden') return true;
    /*
     * **Never**, for an exit the realm says a search reveals. The searching
     * has no ceiling now (todo 04), so there is no point at which the refusal
     * becomes news about the edge — and writing one down is what took a real
     * corridor out of every route for the session in the report.
     */
    if (need.searchable === true) return false;
    /*
     * A lever exit is blamed only once its levers have been spent, and one
     * whose levers are **elsewhere is never blamed**: the client has not done
     * its part and has no way to, so the refusal says nothing about the edge.
     * Writing it into `refusedEdges` is what took a real corridor out of every
     * route for the session (todo 01).
     */
    if (openableHere(need)) return this.levered >= tuning().walk.leverTries;
    /*
     * And an exit the realm names a lever for **anywhere** is not blamed until
     * that errand has been run: the client had something left to do and had
     * not done it, so the refusal says nothing about the edge. That is the
     * whole of the rule this list keeps — a refusal is news only while there
     * is nothing left to try. Once the lever has been pulled and the way is
     * still shut, the errand is spent and the edge is blamed like any other.
     */
    if (this.leverAhead(step)) return false;
    /*
     * **Everything else hidden is blamed as it always was**, and the rule is
     * one sentence: a refusal is not news only while the client still has
     * something to try. Those are the two above — a search that never stops,
     * and levers within reach — and nothing else.
     *
     * That is 1,000 `Hidden/Passable` exits of the shipped realm's 1,469, plus
     * the 23 that state `Needs N Actions` and have no lever indexed against
     * them at all — a subset of the 28 whose stated count and lever count
     * disagree, which is why the two figures are not the same one told twice. In every one the client has nothing left to
     * do, so a route through it is a leg that fails again — which is what
     * `refusedEdges` exists to stop being replanned. An earlier cut of this
     * returned false for the lot, applying the lever argument to a set five
     * times its size without measuring it; a lap would have replanned the
     * identical refused leg until `LoopRunner` gave up, where before it
     * rerouted. Counted against the shipped file, reviewer's find 2026-09-06.
     */
    return true;
  }

  /**
   * Whether the realm names a lever for this step that this walk has not yet
   * been to fetch.
   *
   * Only the *existence* of one, deliberately: whether it can be reached is
   * `fetchLever`'s question and it answers it by trying. What this decides is
   * whether the refusal is news about the edge, and a client that has not been
   * to the lever has no business writing the corridor off either way.
   */
  private leverAhead(step: RouteStep): boolean {
    if (step.direction === 'portal') return false;
    if (this.detoured.has(`${step.from}|${step.direction}`)) return false;
    return (this.events.leversFor?.(step.from, step.direction) ?? []).length > 0;
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
      this.forgetLock();
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
      this.forgetLock();
      this.sendCurrent(false);
    }
  }

  /**
   * The forcing attempt in flight came back a failure. Try the next one, or
   * stand at the door and run the whole ladder again in a moment.
   */
  private forceAgainOrHold(): void {
    this.forcing = null;
    const step = this.route?.steps[this.index];
    if (step === undefined) {
      this.stopRefused(step, undefined);
      return;
    }
    const barrier = t('automation.walk.fallbackBarrier');
    if (this.force(step, barrier)) return;
    this.holdAtBarrier(step, barrier);
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

    /*
     * **The key first, and gated by neither switch.**
     *
     * Reported 2026-09-06 standing at a locked door in `Crypt, Sealed Tomb`
     * with two bone keys in the pack and a hundred and forty-three more on the
     * floor: the walk sent `n`, `open n`, and then bashed the door six times,
     * taking damage each time, and never once tried the key it was carrying.
     *
     * It is not a rung like the other two, and that is why it goes above them
     * and answers to neither `pickLocks` nor `bashDoors`:
     *
     * - **It cannot fail on a roll.** `Door.TryUnlock` compares the key's row
     *   against the door's `KeyItemID` and unlocks it. A pick is a skill check
     *   and a bash is a skill check paid for in hit points; this is neither.
     * - **The route exists *because* the key is held.** `edgePenalty` prunes a
     *   keyed edge outright once a listing has landed and the pack does not
     *   hold the key, so a step in front of a keyed door is one the router
     *   planned on the strength of that key being carried. Refusing to use it
     *   makes the plan a promise the walk breaks — the same argument the
     *   `stated` flag below already makes about a barrier the realm names no
     *   number for.
     * - **`AutoKeys` bent down for it.** That shipped hours earlier, on
     *   instruction, and picking a key up and then bashing the door it opens
     *   is the more expensive half of a feature doing nothing.
     *
     * One attempt per run of the ladder: a key that did not work will not work
     * on being sent again. `holdAtBarrier` runs the whole ladder afresh a
     * moment later, and `forgetBarrier` gives this its attempt back with the
     * rest — which is what covers the door the server re-locks on its own
     * timer (`TryUnlock` arms a `LockDoor` event for `openTime`).
     */
    if (need?.keyId !== undefined && !this.keyed) {
      const name = this.events.keyToUse?.(need.keyId);
      if (name !== null && name !== undefined) {
        this.keyed = true;
        this.sendForcing('key', `use ${name} ${step.direction}`, step, barrier);
        return true;
      }
    }
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
      !this.tooHurtToBash() &&
      meetsBarrier(need?.bashDifficulty, this.strength, tuning().walk.bashMargin, stated)
    ) {
      this.bashed += 1;
      this.sendForcing('bash', `bas ${step.direction}`, step, barrier);
      return true;
    }
    return false;
  }

  /**
   * Whether a bash costs more health than this character has to spend.
   *
   * *"You take 1 damage for bashing the gate!"* — the server prints it in the
   * room, and a bash is the one rung of the ladder that is paid for in hit
   * points. Before the ladder could be run again that was bounded by
   * `bashTries` and then the walk ended; now it repeats, and `bashTries` a
   * round for `barrierRetries` rounds is a character that can knock itself out
   * at a door with nothing else in the room threatening it.
   *
   * `restBelow` is the figure that already says *this character does not
   * travel below this*, and forcing a door is how this step travels — so it is
   * the same line, applied to the one rung that spends health. The pick is
   * ungated: it costs a command and nothing else.
   *
   * Read straight off the config rather than through `wantsHealthHold`, which
   * is gated on `holdWhenHurt`. That option answers *who is responsible for
   * resting this walk*, and the walk that turns it off — a loop's leg, held
   * for health by `LoopRunner` **between** legs and not within one — is
   * exactly the walk that would otherwise stand at a door bashing all night.
   *
   * Unknown never refuses, the rule every threshold here follows: a null
   * maximum is absence, not a low number.
   */
  private tooHurtToBash(): boolean {
    const { restBelow } = this.config.health;
    if (restBelow <= 0) return false;
    const state = this.events.stateNow?.();
    if (state === undefined) return false;
    const { hp, hpMax } = state.vitals;
    if (hp === null || hpMax === null || hpMax <= 0) return false;
    return hp / hpMax < restBelow;
  }

  /**
   * Stand at a shut door the ladder could not get past, and run the whole
   * ladder again in a moment.
   *
   * *"we shouldn't actually stop we should just wait and retry in case health
   * low"* — reported with the transcript in `onOpenRefused`. Every reason the
   * ladder runs out is a reason that may not be true a moment later: the bash
   * that was refused because the character is under `restBelow` is affordable
   * once `Recovery` has sat it down, the lock that took three failed rolls may
   * take the fourth, and a gate is a thing other people walk through. Ending
   * the journey at the first exhausted round meant a lap died at a shut door
   * and an unattended character stood in a corridor until somebody looked.
   *
   * On the health hold's terms, and it deliberately differs in one:
   *
   * - **A hold is not an ending.** The route, the destination and the step
   *   count all survive, and `WalkProgress.hold` says why the character is
   *   standing still.
   * - **The retry goes through `holdBeforeSending`**, so health, a stated
   *   affliction and the quarry beat all outrank it — which is what makes
   *   *wait in case health is low* mean something rather than merely
   *   describing the delay.
   * - **`forgetBarrier` gives the ladder its budget back**, because the round
   *   is the same three questions asked again of a door whose answers may
   *   have changed. That is why the bound is counted here and not in the
   *   per-step counters, which the retry itself resets.
   * - **It is bounded, unlike the health hold.** What ends that one is the
   *   character healing, which `Recovery` is doing precisely because the walk
   *   is standing still. Nothing in this client is working on the door, so
   *   this is `fightHoldMs`'s argument in another shape: a floor under a hold
   *   whose end nobody here can bring about. Past `walk.barrierRetries` the
   *   walk stops the way it always did, saying which door and what it wanted.
   *
   * Said out loud once per barrier rather than once per round: a line every
   * five seconds about the same shut door is the chrome talking over the room.
   */
  private holdAtBarrier(step: RouteStep, barrier: string): void {
    /*
     * The last rung, and the only one that is not a command sent at this door:
     * the realm may name a lever that opens it, in this room or in another.
     * Ahead of the wait, because standing here running the ladder again is
     * what the errand exists instead of — and reached from all three callers
     * at once, which is why it is here rather than beside each of them.
     */
    if (this.fetchLever(step)) return;
    if (this.barrierRounds >= tuning().walk.barrierRetries) {
      this.stopRefused(step, barrier);
      return;
    }
    if (this.barrierRounds === 0 && !this.quiet) {
      this.events.notice?.(
        t('automation.walk.barrierHolding', { barrier, detail: this.barrierDetail(step) })
      );
    }
    this.barrierRounds += 1;
    // The step's deadline was timing a move the refusal has already answered.
    this.clearTimer();
    this.hold = 'barrier';
    this.publish();
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (this.status !== 'walking') return;
      /*
       * The round is over, so its hold is let go before anything else is
       * asked: `holdForHealth` claims a walk only when nothing else is
       * holding it, and a `barrier` left standing here would silence the one
       * hold this retry exists to give way to.
       */
      this.hold = null;
      const state = this.events.stateNow?.();
      if (state !== undefined && this.holdBeforeSending(state)) return;
      this.sendCurrent();
    }, tuning().walk.barrierRetryMs);
    this.holdTimer.unref?.();
  }

  /**
   * Ask the barrier to open, and wait for the answer rather than queueing the
   * step behind it.
   *
   * The step used to go out behind the `open` unconditionally, so a locked
   * door cost a move to be refused a second time before the ladder moved on
   * (`onOpenRefused` has the transcript). Waiting means the two answers that
   * decide the next rung — `door-changed` and `open-failed` — are read before
   * anything else is spent.
   *
   * **And the deadline sends the step rather than giving up**, which is the
   * difference between this and `sendForcing`. A bash and a pick have their
   * successes and their failures in the corpus; `The <…> is now open.` is
   * read out of the server's source with only `door` ever captured, so a
   * realm that phrases it some third way would leave this waiting on a
   * sentence nothing matches. Falling back to the step is exactly what this
   * did before, one round trip later — the old behaviour as the *worst* case
   * instead of the only one.
   */
  private sendOpen(step: RouteStep, barrier: string): void {
    const command = `open ${step.direction}`;
    this.opened += 1;
    this.forcing = 'open';
    this.stepSent = false;
    const queued = this.queue.enqueue({
      command,
      priority: 'movement',
      reason: t('automation.walk.reasonOpening', { barrier, stepName: step.name }),
      onSent: () => this.noteOpenSent(step)
    });
    if (!queued) {
      this.stop(t('automation.walk.reasonNotQueued', { command }));
      return;
    }
    if (!this.stepSent) this.waitForSend(command);
    this.publish();
  }

  /**
   * The `open` is on the wire. Give the realm its round, and take the step
   * anyway if nothing this client reads comes back — see `sendOpen`.
   */
  private noteOpenSent(step: RouteStep): void {
    // A late `onSent` from an attempt this walk has moved past decides
    // nothing, exactly as in `noteStepSent`.
    if (this.status !== 'walking' || this.route?.steps[this.index] !== step) return;
    this.stepSent = true;
    this.stepSentAt = Date.now();
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.status !== 'walking' || this.forcing !== 'open') return;
      this.forcing = null;
      /*
       * Through the holds, because this fires on a clock rather than on an
       * answer: a fight, low health or a stated affliction may have arrived
       * while the door was being asked, and a movement command released here
       * would walk the character out of a fight `cancelQueued` cannot recall
       * it from.
       */
      const now = this.events.stateNow?.();
      if (now !== undefined && this.holdBeforeSending(now)) return;
      this.sendCurrent(false);
    }, this.nudgeAfter());
    this.timer.unref?.();
  }

  private sendForcing(
    kind: 'bash' | 'pick' | 'key',
    command: string,
    step: RouteStep,
    barrier: string
  ): void {
    this.forcing = kind;
    this.stepSent = false;
    const queued = this.queue.enqueue({
      command,
      priority: 'movement',
      reason:
        kind === 'pick'
          ? t('automation.walk.reasonPicking', { barrier, stepName: step.name })
          : kind === 'key'
            ? t('automation.walk.reasonUnlocking', { barrier, stepName: step.name })
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
    /*
     * Before the skill comparison below, because it is a different answer: the
     * character may be strong enough and simply too hurt to spend the health
     * a bash costs. Reading `requires 41; this character has 60 strength`
     * there would be the client contradicting itself.
     */
    if (movement.bashDoors && this.tooHurtToBash()) {
      return t('automation.walk.barrierTooHurt');
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
    this.keyed = false;
    this.searched = 0;
    this.searchSaidAt = 0;
    this.found = false;
    this.levered = 0;
    this.forcing = null;
  }

  /**
   * Forgets that the barrier ahead is locked.
   *
   * **Deliberately not part of `forgetBarrier`.** That one is spent by every
   * retry behind the same door, and a lock does not unlock itself between two
   * of them: `open` at a locked door answers the same word every time, which
   * is written down two rungs up and was then thrown away five seconds later.
   * Reported from the wire as the whole of todo 01 — twelve rounds of
   *
   *     [HP=148/MA=26]:n          The gate is closed!
   *     [HP=148/MA=26]:open n     The gate is locked.
   *
   * on a gate whose 301 picklocks the character had 0 of. Twenty-four commands
   * to be told twice over what the first two already said.
   *
   * What clears it is a fact: the door changing state (`onBarrierChanged`), a
   * confirmed step — the character got past — or a fresh walk.
   */
  private forgetLock(): void {
    this.locked = false;
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
    // The door is behind the character, which is the one fact that says the
    // ladder got past it. See `barrierRounds` — and `forgetLock`, which is the
    // same fact about the lock and is the only thing that clears it.
    this.barrierRounds = 0;
    this.forgetLock();
    // Said once per step, not once per round: `forgetBarrier` is spent by
    // every retry behind the same door, and a line repeated twelve times is
    // the chrome talking over the game.
    this.leverSaid = false;
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
      /*
       * Unless this walk came here for a lever, in which case arriving is the
       * middle of the journey and not the end of it. Ahead of everything
       * below, because `ended` is what a loop books a leg on.
       */
      if (this.finishErrand(state)) return;
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
    // Then a condition the server has stated, on the same terms.
    if (this.holdForAffliction(state)) return true;
    // Then the trap the step ahead fires, on the same terms again.
    if (this.holdForTrap(state)) return true;
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
    /*
     * A hidden exit the room has not printed yet — todo 04's first point,
     * *"do not try the direction first unless it is available"*. Sending the
     * step there is a command spent to be refused, and the refusal is answered
     * by the search this sends instead. Outside the beat's budget for
     * `holdForHealth`'s reason: `maxHolds` bounds a wait for a *quarry*, and
     * spending it here would march the step into the wall three beats later.
     */
    const step = this.route?.steps[this.index];
    if (step !== undefined && this.mustSearchFirst(state, step)) {
      this.holdSearching(step);
      return true;
    }
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
    /*
     * **The reason for waiting has been withdrawn** — todo 03, *"turning auto
     * combat off during attack should continue even if attacking"*.
     *
     * A fight hold waits for one of three endings and the client owns two of
     * them: auto-combat kills the monster, or the retreat walks out. Turning
     * one of those off *while the hold is running* is the player saying stop
     * fighting this — and on this realm walking out of the room is the only
     * way to break combat (there is no `flee`; the retreat does exactly this
     * unasked), so carrying on is not abandoning the character in a fight, it
     * is ending it.
     *
     * **Only when it could end it when the hold began.** A configuration that
     * never could is the stock one, and holding there — bounded by
     * `fightHoldMs` — is a settled decision from a separate report about a
     * route abandoned two steps into twenty-one. This is the *transition*, and
     * nothing else.
     *
     * Re-asked every `holdMs` through `reaskAfter`, so the switch flipping
     * mid-fight is answered within a beat and a half.
     */
    if (this.hold === 'fight' && this.fightHeldCouldEnd && !this.canEndAFight()) {
      this.fightHeldCouldEnd = false;
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
      if (!this.quiet) this.events.notice?.(t('automation.walk.reasonWalkingThroughFight'));
      return false;
    }
    if (this.holdForFight()) return true;
    this.stop(
      this.resumeAfterFight
        ? t('automation.walk.reasonFightUnending')
        : t('automation.walk.reasonCombat')
    );
    return true;
  }

  /**
   * Whether anything this client runs would end a fight around this walk.
   *
   * Three endings, and the client owns two of them: auto-combat kills the
   * monster, and the retreat walks the character out. (The third is the
   * character dying, which stops the walk anyway.) Read off the switches
   * rather than off what is happening, because the question is *will this
   * fight end*, which nothing on the wire answers.
   *
   * `engage: none` with `retaliate` on still ends a fight the character is
   * **in** — hitting back is the half that cannot start one — so either is
   * enough. The master switch gates both, as it gates everything.
   *
   * Deliberately not asked of the party's assist or defend: those end somebody
   * *else's* fight and only while a leader is in the room, which is too many
   * conditions to fold into a bound. Reading them as unable is the safe
   * direction here, and the only cost is the two-minute bound coming back.
   */
  private canEndAFight(): boolean {
    if (!this.config.enabled) return false;
    const combat = this.config.combat;
    if (combat.enabled && (combat.retaliate || combat.engage !== 'none')) return true;
    return this.config.safety.retreat.enabled;
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
      // What this hold is waiting for. See `answerFight`.
      this.fightHeldCouldEnd = this.canEndAFight();
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
      // The fight left the character standing in the room the lever is in, so
      // the errand is done here too -- and it is still not an arrival.
      if (this.finishErrand(state)) return;
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
    // The step landed, so whatever was holding it is over and the next one
    // starts its own window — see `heldSince`.
    this.heldSince = null;
    this.holds = 0;
    this.publish();
    if (this.holdBeforeSending(state)) return;
    this.sendCurrent(true, state);
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
   *   `CharacterTracker.stealthBroke`), and the retry is not a fresh send, so
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
    if (cannotSneakHere(state)) return;
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
      // Only its own hold: a walk standing still blind is not one whose health
      // has come back.
      if (this.hold === 'health') {
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

  /**
   * Stand still while the server says the character is blind, held or
   * poisoned — MegaMUD's `IgnoreBlind` / `IgnorePoison` defaults, which wait
   * (2026-09-05, MegaMUD §3.6). On the health hold's own terms: a hold, not an
   * ending; not bounded by `walk.maxHolds`, because what bounds it is the
   * condition passing (or a cure under `spells.cures` ending it sooner); and
   * re-asked on the beat's timer against `stateNow`, because the flag moves
   * only when the server says so and that sentence may land between beats.
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
  private holdForAffliction(state: CharacterState): boolean {
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
     * **All three, not just `held`** (todo 23, 2026-09-12). The bound was
     * written for `held` and the argument never turned on which condition it
     * was: a stated affliction whose *ending* the client cannot read holds the
     * step for ever. The step this spends to find out is the same probe in
     * every case — the server either walks the character or prints the hold's
     * own sentence again and re-arms the window.
     */
    const spent =
      this.heldSince !== null && Date.now() - this.heldSince >= tuning().walk.heldFallbackMs;
    if (reason === null || spent) {
      if (this.hold === 'blind' || this.hold === 'held' || this.hold === 'poisoned') {
        this.hold = null;
        if (!this.quiet && !spent) this.events.notice?.(t('automation.walk.afflictionResumed'));
        this.publish();
      }
      this.heldSince = null;
      this.onsetAnsweredStep = null;
      return false;
    }
    this.heldSince ??= Date.now();
    if (this.hold !== reason) {
      this.hold = reason;
      if (!this.quiet) {
        if (reason === 'blind') this.events.notice?.(t('automation.walk.holdingBlind'));
        else if (reason === 'held') this.events.notice?.(t('automation.walk.holdingHeld'));
        else this.events.notice?.(t('automation.walk.holdingPoisoned'));
      }
      this.publish();
    }
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (this.status !== 'walking') return;
      if (this.holdBeforeSending(this.events.stateNow?.() ?? state)) return;
      this.sendCurrent();
    }, tuning().walk.holdMs);
    this.holdTimer.unref?.();
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
  private holdForTrap(state: CharacterState): boolean {
    const step = this.route?.steps[this.index];
    const floor = step === undefined ? null : this.trapFloorFor(step, state);
    const { hp } = state.vitals;
    if (floor === null || hp === null || hp >= floor) {
      if (this.hold === 'trap') {
        this.hold = null;
        this.trapFloor = null;
        if (!this.quiet && step !== undefined) {
          this.events.notice?.(t('automation.walk.trapResumed', { stepName: step.name }));
        }
        this.publish();
      }
      return false;
    }
    if (this.hold !== 'trap' || this.trapFloor !== floor) {
      const fresh = this.hold !== 'trap';
      this.hold = 'trap';
      this.trapFloor = floor;
      if (fresh && !this.quiet && step !== undefined) {
        this.events.notice?.(
          t('automation.walk.trapHolding', {
            stepName: step.name,
            damage: trapOn(step)?.damage ?? 0,
            needed: floor,
            hp
          })
        );
      }
      this.publish();
    }
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (this.status !== 'walking') return;
      if (this.holdBeforeSending(this.events.stateNow?.() ?? state)) return;
      this.sendCurrent();
    }, tuning().walk.holdMs);
    this.holdTimer.unref?.();
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
    if (fresh) this.forgetBarrier();
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
    if (fresh && now !== undefined) {
      this.events.beforeStep?.({ name: step.name, light: step.light }, now);
    }
    if (now !== undefined) this.sneakFirst(now);
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
    // This attempt's own evidence, never the last one's — see
    // `onsetAnsweredStep`.
    this.onsetAnsweredStep = null;
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
       * `holdForAffliction` and not `holdBeforeSending`: every other gate in
       * that ladder is a reason not to *send*, and a step already on the wire
       * with no answer is not waiting on any of them.
       */
      const now = this.events.stateNow?.();
      if (now !== undefined && this.holdForAffliction(now)) return;
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
