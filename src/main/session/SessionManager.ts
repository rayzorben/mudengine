/**
 * Owns one live game session: the transport, its observable state, and a
 * bounded diagnostic log. Everything it publishes goes through a sink supplied
 * by the caller, so it has no direct dependency on Electron's IPC.
 */
import { CommandQueue } from '../automation/CommandQueue';
import { Routines } from '../automation/Routines';
import { Walker } from '../automation/Walker';
import type { WalkProgress } from '../../shared/walk';
import type {
  AutomationSnapshot,
  EngageDecision,
  SafetyDecision,
  SentCommand
} from '../../shared/automation';
import { LoginAutomator, type StandDown } from '../automation/LoginAutomator';
import { RuleEngine } from '../automation/RuleEngine';
import { HangUpWatch, PVP_WINDOW_MS, playersHere } from '../automation/HangUp';
import { AutoCombat } from '../automation/AutoCombat';
import { Recovery } from '../automation/Recovery';
import { AutoDeposit } from '../automation/AutoDeposit';
import { AutoDrop } from '../automation/AutoDrop';
import { AutoSearch } from '../automation/AutoSearch';
import { AutoLoot } from '../automation/AutoLoot';
import { AutoLight } from '../automation/AutoLight';
import { Supplies } from '../automation/Supplies';
import { Remotes } from '../automation/Remotes';
import type { RemoteName } from '../../shared/remotes';
import { AutoHeal } from '../automation/AutoHeal';
import { Blessings } from '../automation/Blessings';
import { Cures } from '../automation/Cures';
import { Potions } from '../automation/Potions';
import { LoopRunner } from '../automation/LoopRunner';
import type { LoopProgress } from '../../shared/loops';
import { Events } from '../automation/Events';
import type { Loop } from '../../shared/loops';
import { splitStop } from '../../shared/loops';
import {
  OPPOSITE,
  asDirection,
  roomId,
  type Direction,
  type RoomId,
  type Route,
  type WorldSpell
} from '../../shared/world';
import { actionsFor } from './actions';
import { CharacterTracker } from '../parse/CharacterTracker';
import { Classifier } from '../parse/Classifier';
import { LineTokenizer, plainText } from '../net/LineTokenizer';
import { TelnetClient } from '../net/TelnetClient';
import type { Block } from '../../shared/blocks';
import { bankKey, type CharacterState, type SessionPhase } from '../../shared/character';
import { wireItem } from '../../shared/entities';
import type { WorldGraph } from '../world/WorldGraph';
import { NO_LORE, type MobLore } from '../../shared/lore';
import { NO_REALM_PLAYERS, type RealmPlayers } from '../../shared/players';
import { NO_BELONGINGS, type BelongingsSink } from '../../shared/belongings';
import { NO_FIGHTS, type FightSink } from '../../shared/fights';
import { describeDiscovery, discoveryKey, type Discovery } from '../../shared/memory';
import { DEFAULT_INTERNAL, type InternalConfig } from '../../shared/internal';
import { STATUS_LINE } from '../parse/patterns';
import { TerminalFeed } from './TerminalFeed';
import {
  DEFAULT_CONFIG,
  type AutomationConfig,
  type LoginConfig,
  type SupplyItem
} from '../../shared/config';
import { errorMessage } from '../../shared/values';
import { sameTarget } from '../../shared/types';
import { t } from '../app/i18n';
import type {
  ConnectionPhase,
  ConnectionState,
  ConnectionTarget,
  StreamChunk,
  StreamLine,
  TelnetEvent,
  TerminalMark,
  TerminalSize
} from '../../shared/types';
import { tuning } from '../app/tuning';

/**
 * The part of a chunk of keystrokes the server's line editor would keep.
 *
 * `send`'s shadow buffer exists to answer one question — *does the player have
 * a half-typed line on the wire* — and automation stands down entirely while
 * the answer is yes. So the buffer has to hold what the **server** holds, and
 * a control byte is not text: a terminal sends `\x1b` for Escape, `\x1b[A` for
 * an arrow key and `\t` for Tab, and none of them leaves a character in the
 * server's line.
 *
 * Measured, in the capture that produced this function
 * (`logs/2026-08-30_20-57-36_main.mudcap.jsonl`, t=66056): twenty Escapes and
 * an Enter were answered with a bare room reprint — which is exactly what an
 * *empty* line is answered with. The server had kept none of them. This client
 * had kept all twenty, so `outbound` never emptied, `noteTyping(true)` stood
 * automation down, and the attack decided the millisecond a hostile walked
 * into the room (t=43603) sat in the queue for **twenty-two seconds** while
 * the monster hit the character sixteen times. Nothing on screen said why: the
 * hold is invisible, and the only thing that released it was the player
 * pressing Enter.
 *
 * The terminator is kept, because the commit loop is what reads it, and so is
 * the erase pair, which is modelled rather than dropped.
 */
export function editorInput(data: string): string {
  let kept = '';
  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i]!;
    if (ch === '\x1b') {
      // The whole sequence, dropped as one. Dropping only the introducer
      // would leave `[A` behind, which is the same bug wearing the arrow
      // key's hat.
      i = endOfEscape(data, i);
      continue;
    }
    // The terminator and the two erases are modelled by the caller.
    if (ch === '\r' || ch === '\n' || ch === '\b' || ch === '\x7f') kept += ch;
    // Every other C0 control — Tab, a Ctrl chord, a stray NUL — leaves no
    // text behind for anything to be glued onto.
    else if (ch >= ' ') kept += ch;
  }
  return kept;
}

/**
 * The index of the last byte of the escape sequence beginning at `start`.
 *
 * CSI (`ESC [`) and SS3 (`ESC O`) run to a final byte in `@`–`~`, which is how
 * every arrow, function and editing key this client's own terminal emits is
 * shaped. Anything else after ESC is a two-byte sequence. A sequence the chunk
 * ends inside is consumed whole: the shadow buffer must never be left holding
 * half of something the server is not holding at all.
 */
function endOfEscape(data: string, start: number): number {
  const next = data[start + 1];
  if (next === undefined) return data.length;
  if (next !== '[' && next !== 'O') return start + 1;
  for (let i = start + 2; i < data.length; i += 1) {
    const ch = data[i]!;
    if (ch >= '@' && ch <= '~') return i;
  }
  return data.length;
}

/**
 * Silence after which a partial line is released as one.
 *
 * A prompt is a line that ends because the server stopped talking: MajorMUD's
 * `Please enter your username or "new":` and its in-game status line both
 * arrive with no terminator at all, and the server then waits. Without an idle
 * flush the single most interesting line on screen — the one the player is
 * staring at — never reaches a consumer until the socket closes, which makes
 * login automation impossible.
 *
 * `megamind-client` solves the same problem by reaching into its partial-line
 * buffer and classifying it in place. A timer is the same idea with one stream
 * API instead of two, and it reports the terminator honestly as `flush`.
 *
 * The trade-off: a line genuinely fragmented across a 150 ms gap is split.
 * That is rare at TCP level within one server write, and `flush` tells a
 * consumer not to treat the boundary as authoritative.
 */
export const IDLE_FLUSH_MS = 150;

/**
 * How well the client knows the exit it is running through. See
 * `SessionManager.wayOut`, which is where the ladder is written out.
 *
 * Reported rather than kept: it goes into the notice, so a player watching the
 * console can tell *retracing north* from *taking the only exit the server
 * printed*, and into `AutomationSnapshot.safety` so it survives the scrollback.
 */
type EscapeRung = 'retrace' | 'doubles-back' | 'known' | 'printed';

/**
 * One sentence per rung, so the console says which one answered.
 *
 * A switch of literal `t()` calls rather than a rung → key map, because
 * `i18n-coverage.test.ts` reads literal calls out of the source and a lookup
 * would be a dynamic one — which the same test fails the build for, and rightly:
 * a key nothing literally asks for is a key nobody can tell is dead. The four
 * are exhaustive over `EscapeRung`, which the compiler checks.
 */
function escapeNotice(how: EscapeRung, direction: Direction, why: string): string {
  switch (how) {
    case 'retrace':
      return t('session.safety.escapeRetrace', { direction, why });
    case 'doubles-back':
      return t('session.safety.escapeDoublesBack', { direction, why });
    case 'known':
      return t('session.safety.escapeKnown', { direction, why });
    case 'printed':
      return t('session.safety.escapePrinted', { direction, why });
  }
}

/**
 * Whether an exit wants something before it will let anybody through.
 *
 * A sort key, never a filter: a shut door is one refusal away from being an
 * exit, and every rung below the trail is a room the character has never seen
 * anyway. Preferring the plain one costs nothing and taking the noted one
 * beats standing in the room.
 */
function encumbered(exit: { note: string | null; requirement?: unknown }): boolean {
  return exit.note !== null || (exit.requirement ?? null) !== null;
}

/**
 * Somewhere to keep what a character learns about its realm.
 *
 * Narrow on purpose: the session layer decides *when* something has been
 * learned and says so, and knows nothing about where it is written down. The
 * implementation is `WorldMemory` in `src/main/world/`.
 */
export interface RealmMemory {
  /** Records it, or returns null if this was already known. */
  learn(discovery: Discovery): Discovery | null;
  /** Strikes one out by its `discoveryKey`. Whether there was one to strike. */
  forget(key: string): boolean;
  readonly all: readonly Discovery[];
}

export interface SessionSink {
  data(chunk: StreamChunk): void;
  /**
   * Raw payload bytes, Telnet framing removed and *not yet decoded*.
   *
   * The one record that can settle a disagreement about what the server
   * actually sent and in what order. `data` is already decoded and
   * quirk-adjusted, so an encoding fault or a reordering argued from it is
   * argued from the client's own interpretation rather than from the wire.
   */
  bytes?(payload: Buffer): void;
  /** One framed line of server output. See `LineTokenizer` for why this is not CRLF. */
  line(line: StreamLine): void;
  /** One classified line. Facts only — see docs/legacy-assessment.md §6. */
  block(block: Block): void;
  /** Character and room state, republished only when it actually changed. */
  character(state: CharacterState): void;
  state(state: ConnectionState): void;
  /**
   * The socket went and this client never asked it to.
   *
   * Separate from `state` because a `closed` phase cannot tell the two apart:
   * the player pressing Disconnect, the low-health hang-up, switching realms
   * and a dead link all arrive at that phase, and only this side knows which.
   * The alternative on offer was matching the notice's wording, and copy is
   * not a protocol.
   *
   * `why` is the reason dialling back would undo something somebody meant —
   * see `LoginAutomator.standDown` — or null when the connection was simply
   * lost.
   *
   * **Required**, unlike the other diagnostics on this sink. It is the only
   * channel auto-reconnect has, and a second implementation that forgot it
   * would be a client that silently never dials a dropped character back —
   * with no compile error to say so. The reason it was optional ("nothing in a
   * test needs it") was answered by the test file, which implements it.
   */
  dropped(why: StandDown | null): void;
  telnet(event: TelnetEvent): void;
  /** An engine message to surface inline in the terminal. */
  notice(message: string): void;
  /**
   * The decoded stream, whole — every byte the server sent, escape sequences
   * intact, before the feed decided what the terminal is shown. For the
   * capture and the session log, which are records of what happened rather
   * than of what was painted; `data` is what was painted.
   */
  decoded?(text: string): void;
  /**
   * Everything this character has learned about the realm, after learning
   * something new.
   *
   * The whole list rather than the one addition, for the same reason a `who`
   * listing replaces the roster: a window that missed a push would otherwise
   * hold a record with a hole in it and no way to notice.
   */
  learned?(discoveries: Discovery[]): void;
  /**
   * A command the client committed to the wire, reassembled from keystrokes.
   * One place does this, so a capture and the tracker cannot disagree.
   */
  command?(command: string, source: 'user' | 'automation'): void;
  /** How a route walk is going, when one is running. */
  walk?(progress: WalkProgress): void;
  /**
   * A walk was started toward this room — the palette's recent destinations.
   *
   * A hook rather than a store, for the reason `memory` is an interface: this
   * is the session layer, and where the file goes belongs to whoever decided
   * where the files go. Absent in every test and in the anonymous case, where
   * walking somewhere and forgetting it is better than refusing to walk.
   */
  destination?(room: RoomId, name: string): void;
  /** Loop progress — where the loop is, for the HUD. */
  loop?(progress: LoopProgress): void;
  /**
   * The decision trace: what automation queued, sent and decided.
   *
   * Coalesced by the caller rather than published per change — during a combat
   * burst the queue changes many times a second, and chrome must never be able
   * to pace the stream.
   */
  automation?(snapshot: AutomationSnapshot): void;
}

export class SessionManager {
  private readonly client = new TelnetClient();
  private readonly telnetLog: TelnetEvent[] = [];
  /**
   * Framing runs alongside the terminal feed, not in front of it. The terminal
   * gets every chunk the moment it arrives; the tokenizer's buffering can never
   * delay a paint, which is the whole reason parsing and rendering are separate
   * consumers of the same stream.
   */
  private readonly tokenizer = new LineTokenizer();
  private readonly classifier: Classifier;
  private readonly tracker: CharacterTracker;
  /**
   * What the terminal is shown, line by line. See `TerminalFeed` for why the
   * terminal is fed framed lines now and what that costs.
   */
  private readonly feed: TerminalFeed;
  private readonly world: WorldGraph | undefined;
  private internal: InternalConfig = DEFAULT_INTERNAL;
  private readonly lineLog: StreamLine[] = [];
  private seq = 0;
  private lineSeq = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Keystrokes since the last committed command. */
  private outbound = '';
  /** The command the last status line echoed, which the lines after it answer. */
  private answering: string | null = null;
  /**
   * A direction the **player** typed, waiting for the room that answers it.
   *
   * A walk or a loop stands down when the player takes the wheel, and taking
   * the wheel is *moving the character*, not typing. It used to be any command
   * at all: `st` mid-lap ended the loop with `Manually stopped`, which is a
   * client stopping the thing it was asked to do because somebody looked at
   * their own stat sheet. And a direction into a wall is not taking the wheel
   * either — the character is exactly where the route left it — so the typed
   * move is held here until a room says it landed.
   *
   * `where` is the room the character was standing in when it was typed, so
   * the arrival is recognised by the room *changing* rather than by counting
   * on any one block; `at` is what `tuning.session.playerMoveWindowMs` writes
   * it off against, so a refusal nothing classified cannot leave this armed
   * against a walk step three rooms later.
   */
  private playerMove: { where: string | null; at: number } | null = null;
  /**
   * The phase last seen, so *leaving the realm* is read as the transition it
   * is rather than as a state to be checked for on every line. See
   * `leftTheRealm`.
   */
  private phaseWas: SessionPhase = 'unknown';
  /** Whether a disconnect would be penalised, tracked from the stream. */
  private readonly hangUp = new HangUpWatch({
    pvpBlow: (attacker, at) => this.onPvpBlow(attacker, at)
  });
  /**
   * Gang alerts already sent, by attacker, so a fight producing a blow line
   * per round is one broadcast per attacker per five-minute window — the
   * server's own window, because that is the clock the alert is about.
   */
  private readonly pvpSaid = new Map<string, number>();
  /** The last refusal reported, so it is said once rather than per status line. */
  private lastHangUpRefusal: string | null = null;
  /**
   * When an escape was last *asked for*, so a failed one is retried rather than
   * spammed. Armed whether or not a way out was found.
   */
  private lastAskedToEscape = 0;
  /**
   * When a move was last actually sent to get out of a fight. Zero for never.
   *
   * **Two clocks, because they answer two questions**, and they used to be one
   * number: the cooldown on *asking* and the window in which a move is *in
   * flight*. That was harmless while the escape always enqueued something — and
   * became a defect the moment it could decide to send nothing, because
   * `isRetreating()` reads this one and everything that could keep a character
   * alive is gated on it: auto-combat and retaliation stand down, and so do the
   * heal, the potion, the cures, the blessings and `mayRest`. A room with no
   * exit the client can name would have printed *Standing and fighting* every
   * three seconds while having just switched fighting, healing and resting off
   * — the notice saying the opposite of what the code did.
   */
  private lastEscapeSent = 0;
  /**
   * Rooms this character has run out of, newest last, while the fight it ran
   * from is still going.
   *
   * **The escape must not retrace its own escape.** `CharacterTracker.trail`
   * records every confirmed move whoever sent it, which is the whole point of
   * it — and the escape's own move is one of those. So one second after running
   * `s` out of a lair, `wayBackFrom` names that very step and the reverse of it
   * is `n`, back through the door: the client runs out, walks in, runs out,
   * walks in, at cooldown speed. That is the cave-worm oscillation measured on
   * a loop (`logs/2026-09-02_09-58-25_festus.mudcap.jsonl`) reproduced inside
   * the escape, with no `escapeSettleMs` hold to stop it and a 100%-follower
   * monster — 374 rows of the shipped realm — to make it certain.
   *
   * Cleared when there is nothing left to run from, which is the one fact that
   * makes a room safe to walk back into. Bounded, because a chain of escapes
   * must avoid every room in it: running A→B→C and then back into A is the same
   * mistake one link longer.
   */
  private ranFrom: RoomId[] = [];
  /** A `safe-haven` walk home waiting for the fight to end; see `walkHomeIfDue`. */
  private retreat: { room: string; armedAt: number; from: string | null } | null = null;
  /**
   * Where a route the player was walking still owes them, across a lost
   * connection. See `pickUpAfterLoss`.
   *
   * Taken from `Walker.journey` at the moment the socket goes and only for a
   * loss — a deliberate disconnect is the player ending the session — and
   * spent the first time the character is back in the realm and placed, or
   * dropped when anything supersedes it: a new walk, leaving the realm, a dial
   * to a different realm. The loop keeps its own place (`LoopRunner.carried`);
   * this is the one journey with nobody else holding its destination.
   */
  private journey: { to: RoomId; name: string } | null = null;
  /**
   * Whether `pickUpAfterLoss` has said, this connection, that it is waiting
   * for the room. Once, because the entry probe is what asks, and this is only
   * ever waiting for the answer; reset with everything else at `connect`.
   */
  private saidWaitingToBePlaced = false;
  /**
   * What was done, or refused, to keep this character alive.
   *
   * Kept apart from the rule trace because a safety action is not a rule, and
   * apart from the sent log because hanging up produces no command at all —
   * which is exactly why it needs recording somewhere. "Why did the bot run?"
   * has to be answerable, and so does "why did it not hang up?".
   */
  private readonly safetyLog: SafetyDecision[] = [];
  /**
   * What auto-combat opened on, or declined to and why.
   *
   * Beside the safety trace and capped the same way, for the reason
   * `SafetyDecision` already gives: somebody who turned a feature on and saw
   * nothing happen needs to see that it *decided* not to. Auto-combat is the
   * loudest thing in the client and recorded only what it did.
   */
  private readonly engageLog: EngageDecision[] = [];
  private lastSize: TerminalSize = { cols: 80, rows: 24 };

  private current: ConnectionState = {
    phase: 'idle',
    target: null,
    connectedAt: null,
    detail: null,
    negotiated: {
      localEnabled: [],
      remoteEnabled: [],
      binary: false,
      suppressGoAhead: false,
      remoteEcho: false
    }
  };

  readonly queue: CommandQueue;
  readonly rules: RuleEngine;
  readonly walker: Walker;
  /**
   * Fighting on the character's behalf.
   *
   * Below the two safety nets in every sense: it is consulted *after* them on
   * every state change, it proposes in the `combat` band rather than
   * `emergency`, and it is told to stand down whenever an escape is in flight.
   */
  readonly combat: AutoCombat;
  /** What the arbiter actually sent, newest last. Bounded; this is a trace. */
  private readonly sentLog: SentCommand[] = [];
  private automationTimer: NodeJS.Timeout | null = null;
  /**
   * The next command answers a password prompt, so it must not be written down.
   *
   * A property of the *prompt*, not of who answers it: the automator and a
   * person typing are equally in need of this, and keying on the automator
   * would have left manual login credentials in the capture file. The session
   * capture records every outbound command verbatim, which is exactly what
   * makes it useful and exactly why this has to be filtered before it gets
   * there.
   */
  private awaitingPassword = false;
  /**
   * The configured password, so a command that *is* it is redacted even when
   * no prompt armed anything.
   *
   * The prompt is the right primary key — a hand-typed password answers the
   * same prompt the automator does — and it is also the weak point: a BBS
   * front-end whose password prompt the classifier has never met produces no
   * `prompt-password` block, and a manual login there would have written the
   * password down verbatim. What `connection.login` holds is known without
   * reading the prompt. Exact match only — a substring search over every
   * command is `check:secrets`' job, offline, where a false positive costs a
   * look rather than a command in the record.
   */
  private secret = '';
  private automationConfig: AutomationConfig;
  private readonly login: LoginAutomator;
  private readonly recovery: Recovery;
  private readonly loot: AutoLoot;
  private readonly drop: AutoDrop;
  /** Looking for what a room did not print. See `AutoSearch`. */
  private readonly search: AutoSearch;
  private readonly deposit: AutoDeposit;
  /** Readying a light before the dark. See `AutoLight`. */
  private readonly light: AutoLight;
  /** Keeping the pack stocked. See `Supplies`. */
  private readonly supplies: Supplies;
  private readonly remotes: Remotes;
  private readonly heal: AutoHeal;
  private readonly potions: Potions;
  private readonly cures: Cures;
  /** Blessings kept up by events on this character and the party. */
  private readonly blessings: Blessings;
  readonly loops: LoopRunner;
  /**
   * Followers who said `@wait` and have not yet said `@ok`, lower-cased.
   *
   * A set, not a flag: two followers may fall behind independently, and the
   * loop walks on only when the *last* of them has stood back up. Forgotten on
   * connect — a reconnect is a new session, and a `@wait` from the old one
   * must not hold a loop nobody asked it to.
   */
  private readonly waitingFollowers = new Set<string>();
  /**
   * Whether the loop's current pause is this session's own answer to `@wait`.
   *
   * `@ok` may only resume what `@wait` paused: a pause the player chose from
   * the Loop card is theirs to end, and a follower's `@ok` walking a
   * hand-paused loop away would be somebody else's typing moving this
   * character. Cleared the moment the loop is seen in any state but `paused`,
   * because however the pause ended — resumed here, resumed by hand, stopped,
   * reset — the claim is spent.
   */
  private pausedForFollowers = false;
  /**
   * The command that asks this realm where the character is standing, until
   * the realm says it has no such word.
   *
   * `rm` on GreaterMUD. MajorMUD has neither `rm` nor `pro`, and an
   * unrecognised command on either is **spoken aloud in the room** rather
   * than refused — so asking twice is not a wasted command, it is the client
   * broadcasting to everybody standing there. One refusal retires it.
   *
   * Null means this realm has answered that question. Restored by `useRealm`,
   * which is per *connection* and keyed on the address actually dialled — the
   * same reason the player book is. A character can be dialled at a saved
   * realm other than its own from the palette, so a word retired on a
   * MajorMUD board must not stay retired when the next connection is to
   * GreaterMUD. The cost of not knowing it is the same realm is one refusal
   * per connection, which is what `onEnterRealm` already pays.
   */
  private locateWord: string | null = 'rm';

  /**
   * The character's own persisted record, as `useRealm` handed it over — the
   * same instance the tracker writes through. Held here so the blessing
   * watchdog can read the measured durations at the point of use.
   */
  private belongings: BelongingsSink = NO_BELONGINGS;

  /**
   * Edges the live server refused this session (`from|direction`). Handed to
   * every route as `Traveller.refused`, and forgotten on disconnect: a server
   * restart may open what this session saw shut, and the permanent record
   * (`WorldMemory`) deliberately never reaches the pathfinder.
   */
  private readonly refusedEdges = new Set<string>();
  /** Stops listening to the realm's player book. See `useRealm`. */
  private forgetPlayers: () => void = () => {};
  private readonly events: Events;
  private readonly routines: Routines;

  constructor(
    private readonly sink: SessionSink,
    world?: WorldGraph,
    automation: AutomationConfig = DEFAULT_CONFIG.automation,
    login: LoginConfig = DEFAULT_CONFIG.connection.login,
    /*
     * What is known about monsters on *this character's* realm, and what
     * fighting them teaches. Defaults to knowing nothing, which is the honest
     * state for a client with no realm data and the one every test wants.
     */
    lore: MobLore = NO_LORE,
    /**
     * Where what this character learns about the realm is kept.
     *
     * An interface, not the store: this is the session layer, and the file
     * handling belongs to whoever decided where the file goes. Absent in every
     * test and in the anonymous single-session case, where learning something
     * and forgetting it is better than refusing to play.
     */
    private readonly memory?: RealmMemory,
    /**
     * Where fights are written down.
     *
     * Absent in every test and in the anonymous single-session case, where
     * there is no character file to keep a record beside. See
     * `shared/fights.ts` for why the record exists at all before anything reads
     * it.
     */
    fights: FightSink = NO_FIGHTS,
    /**
     * What the realm knows about the other players on it, shared by every
     * character dialling the same address. Defaults to a realm that knows
     * nothing, which is what every test wants.
     */
    players: RealmPlayers = NO_REALM_PLAYERS
  ) {
    this.tracker = new CharacterTracker(
      world,
      lore,
      (discovery) => this.remember(discovery),
      fights,
      players
    );
    this.useRealm(players);
    /*
     * One interval for the life of the session, armed here rather than in
     * `useRealm` — which the host calls again on **every** dial, so arming it
     * there left one live timer per connection with only the last handle kept.
     * A disposed session then went on ticking into a disposed queue, which
     * re-arms its own timer on every enqueue: a closed tab resurrecting itself
     * once a second and holding its whole object graph open. `unref` does not
     * help with that — an unref'd timer still fires.
     */
    this.reconsiderTimer = setInterval(() => this.reconsider(), tuning().session.reconsiderMs);
    // Never the reason a process stays alive.
    this.reconsiderTimer.unref?.();
    /*
     * The classifier is handed the two things that can say where a monster's
     * name ends inside a combat line — the room it is standing in and the
     * realm's monster table — as a lookup rather than as either object, which
     * is the shape `classifyOccupant` already takes for the same reason.
     *
     * Read through the tracker rather than copied: the occupant list changes
     * with every room and every arrival, and a snapshot taken at construction
     * would name monsters from a room the character left an hour ago.
     */
    this.classifier = new Classifier({
      present: () => this.tracker.current.room.occupants.map((who) => who.name),
      mob: (name) => world?.mob(name)
    });
    this.world = world;
    this.feed = new TerminalFeed(
      {
        isQuiet: (word) =>
          this.internal.terminal.quiet.enabled &&
          this.internal.terminal.quiet.commands.includes(word),
        isStatus: (plain) => STATUS_LINE.test(plain),
        now: () => Date.now()
      },
      // A held tail released by its timer, outside any chunk: painted as a
      // chunk of its own.
      (released) => {
        this.seq += 1;
        this.sink.data({
          seq: this.seq,
          at: Date.now(),
          text: released.text,
          ...(released.marks.length > 0 ? { marks: released.marks } : {})
        });
      }
    );

    /*
     * The arbiter. Everything automated goes through here, and nothing else may
     * write to the socket on automation's behalf — docs/legacy-assessment.md §6.
     */
    this.automationConfig = automation;
    this.queue = new CommandQueue(automation, {
      send: (command, intent) => {
        /*
         * An empty line is not a command, and the typed path has always said
         * so (`send` skips all three of these for a bare Enter). Filing one
         * would clear the slots that interpret the *previous* command — the
         * classifier's `lastCommand`, the tracker's aimed-at and unmodelled
         * slots — for a line the server keeps nothing of either. The walker's
         * nudge is the one thing that sends one.
         *
         * But it is still a **room block this client asked for**, and the one
         * fact that has to survive the gate is that one is coming: the nudge's
         * reprint was otherwise read as the arrival of the step sent behind it,
         * and the walk ran a room ahead of the character (2026-09-02,
         * `Expectations.noteReread`). That is what the `else` files, and it is
         * a door of its own precisely so this gate does not have to widen.
         */
        if (command.length > 0) {
          this.tracker.observeCommand(command);
          this.login.observeCommand(command);
          // The classifier needs it too: the server echoes what we send, and
          // `You say "<command>"` is only interpretable next to it.
          this.classifier.observeCommand(command);
        } else {
          this.tracker.observeReread();
        }
        const reported = this.reportable(command);
        this.sink.command?.(reported, 'automation');
        this.noteSent(command, 'automation');
        this.recordSent({
          at: Date.now(),
          command: reported,
          priority: intent.priority,
          ...(intent.reason === undefined ? {} : { reason: intent.reason })
        });
        this.client.send(`${command}\r\n`);
        // A character the client is already driving is not an idle one. Wired
        // here rather than at each proposer because this is the one funnel
        // every automated command goes through.
        this.routines.noteSent();
      },
      notice: (message) => this.sink.notice(message),
      /*
       * The emergency exception to the typing hold (see `CommandQueue.drain`):
       * committing the player's half-typed line goes through `send` — the
       * path a keystroke takes — so the partial command is observed, reported
       * and redacted exactly as if the player had pressed Enter themselves,
       * and the shadow buffer empties the way the server's buffer does.
       */
      clearTypedLine: () => this.send('\r')
    });

    this.routines = new Routines(automation, this.queue, {
      notice: (message) => this.sink.notice(message)
    });

    /*
     * Walking a route is an outbound action, so it proposes to the arbiter like
     * everything else. Phase 4 planned routes and stopped there deliberately;
     * this is the piece that executes one, a verified step at a time.
     */
    this.walker = new Walker(automation, this.queue, {
      // A loop walks through the walker, so this is how it hears a leg end.
      ended: (arrived, reason) => {
        this.loops.onWalkEnded(arrived, reason, this.tracker.current);
        this.supplies.onWalkEnded(arrived, reason, this.tracker.current);
      },
      stepping: (command, direction, to) => {
        if (direction === 'portal') {
          // A scripted teleport: the arriving room is resolved by the
          // coordinates the script states, never by an exit that does not
          // exist. `to` is `map/room` by construction; parsed, not trusted.
          const target = /^(\d{1,3})\/(\d{1,6})$/.exec(to);
          if (target) {
            this.tracker.hintTeleport(command, Number(target[1]), Number(target[2]));
          }
          return;
        }
        this.tracker.hintMove(command, direction);
      },
      refused: (from, direction) => {
        this.refusedEdges.add(`${from}|${direction}`);
        this.sink.notice(t('session.walk.exitRefused', { direction }));
      },
      // Where the player asked to go. Every walk goes through the walker — a
      // route from the palette and a loop's own leg alike — which is why the
      // record is taken here and not at the IPC handler the loop never reaches.
      // And a new walk supersedes a journey still owed from a lost
      // connection, whoever started it — the walker replaces a walk silently,
      // and picking the old one up later would replace the new one the same
      // way.
      destination: (room, name) => {
        this.journey = null;
        this.sink.destination?.(room, name);
      },
      // The tracker's queue, not the walker's own idea of one: it counts a
      // typed direction and a leg left over from a walk combat stopped, which
      // are the moves a route cannot see and is desynchronised by.
      pendingMoves: () => this.tracker.pendingMoves,
      /*
       * A route that stood still for a fight plans again from wherever the
       * fight left the character. Answered here for the reason `holdAt` and
       * `lightSource` are: the answer needs the realm graph, the character's
       * purse and the edges this session has seen refused, and the walker
       * holds a route and a queue and deliberately not the world.
       */
      replan: (to) => this.planFromHere(to),
      // A walk that engages pauses where there is something worth fighting, so
      // the wanderer met mid-corridor is met, not passed — and so is the second
      // monster in a room the first was just killed in. Asked of auto-combat
      // whole: which walks engage is `whileWalking` and `looping`, and stating
      // half of that here left the two able to disagree. See `quarry`.
      holdAt: (state) => this.combat.quarry(state),
      // The beat is re-asked on a timer, by which time the state it began with
      // is a second and a half old.
      stateNow: () => this.tracker.current,
      // Which of the things in the pack is a light is realm data, so the
      // question is answered here where the world graph is and not in the
      // walker, which holds a route and a queue and nothing else.
      lightSource: (state) => this.lightSource(state),
      // And the light itself, ahead of the step. See `AutoLight`.
      beforeStep: (ahead, state) => this.light.beforeStep(ahead, state),
      notice: (message) => this.sink.notice(message),
      progress: (progress) => {
        /*
         * Auto-combat is told whether a route is running, rather than reaching
         * into the walker for it. A walk stops the moment combat starts, so a
         * client that opened a fight with everything between here and the bank
         * would turn one route into a dozen — and the walker is the only thing
         * that knows a route is in progress.
         */
        this.combat.noteWalking(progress.status === 'walking');
        this.sink.walk?.(progress);
      }
    });

    this.combat = new AutoCombat(
      automation.combat,
      automation.enabled,
      this.queue,
      {
        notice: (message) => this.sink.notice(message),
        /*
         * The trace, not the console. A refusal to open a fight is not news
         * the *game's* surface should carry — it happens in every corridor and
         * would be the chrome talking over the realm — but it is exactly what
         * somebody asking "why did it walk past those thugs" needs, and the
         * Automation card is where a decision is read back.
         */
        decided: (decision) => {
          this.engageLog.push(decision);
          if (this.engageLog.length > tuning().session.safetyLogLimit) this.engageLog.shift();
        }
      },
      automation.spells,
      (name) => this.world?.spellNamed(name) ?? null
    );

    /*
     * Sitting down, which is the opposite answer to the same number the
     * retreat reads. Both are consulted below, in the order that settles which wins:
     * running away is `emergency` and this is `probe`, so a character under
     * both thresholds runs first and rests wherever it lands.
     */
    this.recovery = new Recovery(
      automation.health,
      automation.enabled,
      this.queue,
      automation.party,
      { notice: (message) => this.sink.notice(message) }
    );
    /*
     * The realm's row for a name on the floor. Read at the point of use, like
     * `realmSpell` below and for the same reason: `this.world` arrives with
     * `useRealm` and may not exist yet. A realm with no data answers a whole
     * wire entity, which is what makes the predicates decline rather than
     * throw.
     */
    this.loot = new AutoLoot(automation.loot, automation.enabled, this.queue, (name) =>
      this.world === undefined ? wireItem(name) : this.world.buildItemEntity(name)
    );
    /*
     * The light, asked by the walker before every step (`beforeStep`) and by
     * the state on every arrival. Its refusals go to the safety trace, because
     * a torch not lit in a dark room is a decision somebody will ask about.
     */
    this.light = new AutoLight(automation.movement, automation.enabled, this.queue, {
      notice: (message) => this.sink.notice(message),
      decided: (decision) => this.noteSafety(decision),
      escaping: () => this.isRetreating()
    });
    /*
     * The errand. Its planner is the loop's own — the same route planner, the
     * same walker, the same "is a move outstanding" fact — with two more
     * questions the loop never asks: whether something else has the
     * character, and how to hold the loop while the errand runs.
     */
    this.supplies = new Supplies(
      automation.supplies,
      automation.enabled,
      this.queue,
      {
        here: () => {
          const here = this.tracker.current.room;
          return here.map === null || here.number === null ? null : roomId(here.map, here.number);
        },
        shopRoom: (item) => this.shopRoom(item),
        routeTo: (room) => this.planFromHere(room),
        walk: (route) =>
          this.walker.start(route, this.tracker.current, {
            quiet: true,
            // An errand is a walk automation chose: it waits to be well, and
            // it waits for a fight to be over — the loop's own answers.
            holdWhenHurt: true,
            resumeAfterFight: false,
            whileFighting: false,
            // And it is not owed back across a lost connection: `Supplies`
            // starts afresh from the next pack listing, which is the fact the
            // errand was ever about.
            resumeAfterLoss: false
          }),
        moveInFlight: () => this.tracker.pendingMoves > 0,
        walking: () => this.walker.walking,
        busy: () => this.isRetreating() || this.retreat !== null,
        hold: () => this.loops.noteErrand(),
        release: () => this.loops.noteErrandOver()
      },
      {
        notice: (message) => this.sink.notice(message),
        decided: (decision) => this.noteSafety(decision)
      }
    );
    // And its opposite number: what the loot hoarded, the drop list sheds.
    this.drop = new AutoDrop(automation.drop, automation.enabled, this.queue);
    this.search = new AutoSearch(automation.search, automation.enabled, this.queue);
    /*
     * And what neither should be carrying: the purse over the threshold, banked
     * at a counter. The counter is the *resolved* room's own shop — never the
     * room's name, because thirteen rooms can share one and a `deposit` typed
     * outside a bank is said out loud.
     */
    this.deposit = new AutoDeposit(automation.banking, automation.enabled, this.queue, (state) => {
      if (state.room.map === null || state.room.number === null) return false;
      const here = this.world?.byId(roomId(state.room.map, state.room.number));
      if (!here || here.shop === undefined) return false;
      return this.world?.shop(here.shop)?.kind === 'bank';
    });
    /*
     * The other half of running several characters at once: `@health` answered
     * over a telepath costs no command, where the party roster costs one and
     * gives a percentage. Off unless the options file says otherwise — it is a
     * channel by which somebody else's typing moves this character.
     */
    this.remotes = new Remotes(automation, this.queue, {
      notice: (message) => this.sink.notice(message),
      // What the character is doing, for `@status`, at the moment it is asked.
      progress: () => ({ walk: this.walker.progress, loop: this.loops.progress }),
      /*
       * A follower saying it cannot keep up. The loop is what would walk away
       * from them, so the loop is what *pauses* — and `@ok` is the same
       * follower saying it can again, which resumes it. It used to stop the
       * loop outright, which read the same in the moment and cost the whole
       * evening: `@ok` had nothing left to release, so one `@wait` ended the
       * lap for good and the leader stood at a stop until somebody noticed.
       * Paused keeps the loop and its place; resuming plans afresh from
       * wherever the character now stands, exactly as the Loop card's own
       * pause does — the leg being walked is ended here first, because the
       * runner never touches the walker.
       */
      pace: (who, ready) => {
        const follower = who.toLowerCase();
        if (!ready) {
          this.waitingFollowers.add(follower);
          if (this.loops.progress.status !== 'running') return;
          /*
           * Pause before ending the leg, not after: `walker.stop` reports
           * `ended` synchronously, and on a loop still *running* that is a
           * counted failure — "skipping the stop" and a fresh leg planned, for
           * a walk nothing went wrong with. Paused first, the runner reads the
           * ending as what it is: a leg the pause ended.
           */
          this.loops.pause();
          this.pausedForFollowers = true;
          this.walker.stop(t('session.loop.pausedForRemote', { who }));
          return;
        }
        this.waitingFollowers.delete(follower);
        if (this.waitingFollowers.size > 0) return;
        if (!this.pausedForFollowers || this.loops.progress.status !== 'paused') return;
        this.pausedForFollowers = false;
        const refused = this.loops.resume(this.tracker.current);
        // Said out loud: a loop that quietly failed to walk on is the same
        // stalled evening the resume exists to prevent.
        if (refused !== null) this.sink.notice(refused);
      },
      /*
       * Recorded on the player's own registry entry, which is what the Player
       * card reads. Published straight away rather than waiting for the next
       * state change: an attempt that changed nothing else about this character
       * would otherwise sit unpublished until something unrelated moved.
       */
      commanded: (from, raw, at) => {
        if (this.tracker.noteRemoteCall(from, raw, at)) {
          this.publishCharacter();
        }
      },
      // A blessed party member says the spell wore off; recast on the event.
      blessExpired: (from, spell) => this.blessings.onPeerExpired(from, spell)
    });
    /*
     * All four casters share one realm lookup, and it hands over the realm's
     * **row**, not a field off it.
     *
     * Three separate projections used to cross here — an abbreviation for the
     * cast word, an id for telling `bles` from `bless`, and nothing at all for
     * what a cast costs — so a module that needed a fact the wiring had not
     * anticipated could not ask for it. Read at the point of use, because
     * `this.world` arrives with `useRealm` and may not exist yet.
     */
    const realmSpell = (name: string): WorldSpell | null => this.world?.spellNamed(name) ?? null;
    this.heal = new AutoHeal(
      automation.spells,
      automation.enabled,
      this.queue,
      undefined,
      realmSpell
    );
    this.potions = new Potions(automation.health, automation.enabled, this.queue);
    this.cures = new Cures(
      automation.spells,
      automation.enabled,
      this.queue,
      undefined,
      realmSpell
    );
    this.blessings = new Blessings(
      automation.spells,
      automation.enabled,
      this.queue,
      undefined,
      /*
       * The measured duration of this character's own cast, read at the point
       * of use so the store that arrives with `useRealm` is the one answering.
       * Null before any measurement — the shipped watchdog covers that. The one
       * fact here that is not the realm's, which is why it is still its own.
       */
      (spell) => this.belongings.recallSpellDurations()[spell.trim().toLowerCase()] ?? null,
      realmSpell
    );
    // The party half of two modules that already exist: whom to swing at, and
    // when to sit down. Configured rather than constructed with it, so the
    // constructor arguments stay what every test builds.
    this.combat.configure(
      automation.combat,
      automation.enabled,
      automation.spells,
      automation.party
    );
    this.events = new Events(automation.events, automation.enabled, this.queue);
    /*
     * A loop is walked *by the walker*: it plans each leg with the same route
     * planner a person uses and hands it over, so every guard a walk has —
     * one verified step at a time, stop on a shut door, stop on a typed
     * command — holds for a loop too. What the loop adds is where to go next.
     */
    this.loops = new LoopRunner(
      {
        routeTo: (stop) => {
          const here = this.tracker.current.room;
          if (here.map === null || here.number === null) return t('session.loop.unknownRoom');
          const found = this.findStop(stop);
          if (typeof found === 'string') return found;
          return this.planFromHere(roomId(found.map, found.room));
        },
        /*
         * Quietly: the loop is what is happening, and the loop narrates it.
         *
         * A leg is one or two steps between two stops the player already
         * chose, and there are two of them a minute for as long as the loop
         * runs — so `Walking 1 step to …` and `Arrived at …` were two lines of
         * chrome between every pair of the game's own, saying nothing the Loop
         * card was not already showing. What the loop itself decides — which
         * stop, a stop skipped and why, a hold for health, the loop ending —
         * is still said out loud, because those are decisions rather than
         * progress. The walker's card is unaffected: `quiet` is about the
         * console only.
         */
        /*
         * `holdWhenHurt: false` because the loop already decides this: it
         * holds its lap off `restBelow`/`restTo` and reports it as a `health`
         * hold. Deciding it in the walker too is two halves of one gate in two
         * files, and `npm run smoke` caught it — its fixture runs a lap at
         * 98/400, and the leg was held here so the lap never took a step.
         *
         * `resumeAfterFight: false` is the same sentence about the other hold.
         * A fight is what the loop is *for*, and it is the loop that waits it
         * out — reading `ended` to know the leg is over, then planning the next
         * one from wherever the fight left the character. A leg that held
         * instead would never call `ended`, and the lap would stand in the room
         * it won and never take another step.
         */
        walk: (route) =>
          this.walker.start(route, this.tracker.current, {
            quiet: true,
            holdWhenHurt: false,
            resumeAfterFight: false,
            /*
             * And a leg is never started mid-fight. This is the refusal a
             * route the *player* asked for no longer gets: nobody chose to
             * leave the room, automation did, and automation can wait —
             * `LoopRunner.advance` reads the refusal by name to tell a lost
             * race with the wire from a stop that cannot be reached. Captured
             * live 2026-09-01: a lap started in a room with two monsters
             * swinging, sent its opening `n` mid-round, and walked out over
             * the coins its own kill dropped.
             */
            whileFighting: false,
            // A leg is the loop's to plan again, from wherever the character
            // is when it is back — the same recovery a fight gets.
            resumeAfterLoss: false
          }),
        moveInFlight: () => this.tracker.pendingMoves > 0,
        // Some other walk is running this character — a `safe-haven` retreat,
        // in practice, which is the one walk that runs while the loop is held.
        walking: () => this.walker.walking,
        here: (stop) => {
          const here = this.tracker.current.room;
          const found = this.findStop(stop);
          if (typeof found === 'string') return false;
          return here.map === found.map && here.number === found.room;
        },
        /*
         * Where a stop is, for the map to mark the places the lap still owes.
         *
         * The same resolution `routeTo` walks by, so the mark and the walk
         * cannot disagree about which of the thirteen Town Gates a stop means
         * — and a name the realm refuses to settle draws nothing rather than
         * putting a ring on the first candidate.
         */
        roomOf: (stop) => {
          const found = this.findStop(stop);
          return typeof found === 'string' ? null : roomId(found.map, found.room);
        }
      },
      {
        notice: (message) => this.sink.notice(message),
        progress: (progress) => {
          // A loop's walk engages: the loop was chosen for what lives on it.
          this.combat.noteLooping(progress.status === 'running');
          // However a follower-pause ended — resumed here, resumed by hand,
          // stopped — the claim is spent: `@ok` may only resume what `@wait`
          // paused. `pause()` publishes `paused`, so setting the flag after
          // the call survives this line.
          if (progress.status !== 'paused') this.pausedForFollowers = false;
          this.sink.loop?.(progress);
        },
        locate: () => {
          /*
           * `rm` answers with coordinates — the only exact statement of
           * position this server makes — and the tracker resolves the next
           * room off it.
           *
           * Only where the realm has the word. **MajorMUD does not**, and a
           * command this server family does not have is not refused quietly:
           * it is *said out loud in the room*. So the first `You say "rm"`
           * retires it for the session, and the loop falls back to what it
           * does anyway — waiting for the next room block and re-deriving.
           * That fallback is the whole client on a realm with no locate
           * command, which is why the reckoning above it had to be right
           * rather than merely recoverable.
           */
          if (this.locateWord === null) return;
          this.queue.enqueue({
            command: this.locateWord,
            priority: 'probe',
            coalesceKey: 'loop-locate',
            expiresAt: Date.now() + 10_000,
            reason: t('session.loop.locateReason')
          });
        }
      }
    );

    // Rules propose; the queue disposes. Nothing here reaches the socket.
    this.rules = new RuleEngine(this.queue, {
      notice: (message) => this.sink.notice(message)
    });
    this.rules.load(automation.rules);

    /*
     * Answering the login is on the *player's* behalf, so it goes through the
     * arbiter at `user` priority and outranks anything automated.
     */
    this.secret = login.password;
    this.login = new LoginAutomator(login, this.queue, {
      notice: (message) => this.sink.notice(message)
    });
    /*
     * Raw bytes first, and deliberately before `data`.
     *
     * The capture is what a disagreement about ordering gets settled from, so
     * what it records has to be the order the socket delivered — not the order
     * the decode and framing pipeline produced. Nothing else listens; this is a
     * recording tap, and it must never be given work that could delay a paint.
     */
    this.client.on('bytes', (payload) => this.sink.bytes?.(payload));

    this.client.on('data', (text) => {
      const at = Date.now();
      this.sink.decoded?.(text);
      /*
       * Framed first, painted second — and both in this call. The terminal is
       * fed lines now rather than the raw chunk, so that a line can be
       * withheld by what it is; what keeps the old guarantee is that every
       * line terminated in this chunk is emitted before this handler
       * returns, and the unterminated tail with it unless a quiet command is
       * being answered. A parser fault costs the line its type, never its
       * paint: `publishLine` guards the classifier.
       */
      for (const framed of this.tokenizer.push(text)) this.publishLine(framed, at);
      this.feed.partial(this.tokenizer.buffered);
      this.paint(at);
      this.armIdleFlush();
      /*
       * Deliberately *not* `routines.noteSent()`: the keep-alive counts this
       * client's own silence, and bytes arriving are not it. This realm
       * repaints its status line unprompted every thirty seconds, so counting
       * them reset a forty-five second clock forever — see `Routines.noteSent`
       * for the capture.
       */
    });

    this.client.on('telnet', (event) => {
      this.telnetLog.push(event);
      if (this.telnetLog.length > tuning().session.telnetLogLimit) this.telnetLog.shift();
      this.sink.telnet(event);
      // Negotiation changes what the state pane shows, so republish.
      this.patch({});
    });

    this.client.on('close', (graceful) => {
      this.flushPending();
      /*
       * Whether this close is a *loss*: nobody on this side asked for it.
       * `graceful` is the whole test of who asked, and `login.standDown` is
       * the latch that says the player typed their way out before the far end
       * hung up. They are the two facts `Reconnect.lost` reads first, so what
       * is carried here is never something that stood down there.
       *
       * The carry follows the **loss**, not the dial. Whether the character
       * is dialled back is `Reconnect`'s and the profile's — auto-reconnect
       * off, the ladder giving up, a realm that keeps dropping — and none of
       * that changes what was underway when the link went. A character
       * dialled back by hand an hour later gets the lap it was running, said
       * out loud on the way (`heldOffline`, then `walkingOnAfterReconnect`),
       * with the Loop card reading `offline` the whole time it is owed and
       * its Stop the way to say otherwise. Pressing Disconnect at the closed
       * socket does not put it down: that is *stop trying to dial*, which
       * `SessionHost` answers, and the socket it would close is already gone.
       */
      const lost = !graceful && this.login.standDown === null;
      /*
       * A lost socket does not end the lap, and a deliberate one does. The
       * character is still standing wherever the link went — on this server
       * family a disconnect is not a pause, and whatever was in the room is
       * still there — so the loop is *held* (`LoopRunner.noteOffline`), the
       * route the player was walking is remembered, and both are picked up
       * when the character is back in the realm and placed
       * (`pickUpAfterLoss`). Before this the loop was left nominally running
       * on a closed socket with the leg below booked against it as a failed
       * stop, and the next dial reset it to nothing: a character dialled back
       * in by `Reconnect` stood in a lair all night with the lap it had been
       * running gone from the card.
       *
       * A close this client asked for is the player ending the session —
       * Disconnect, the low-health hang-up, switching realms, quitting — and
       * the lap ends with it, said out loud like every other way one ends.
       * The loop before the walker, as `leftTheRealm` orders it: stopping a
       * walk reports `ended`, and a loop still running would book that as a
       * failed leg on its way out. The errand goes either way — `Supplies`
       * starts afresh from the next pack listing, and its walk is the one
       * below — and after the loop, so the loop hears the errand end silently
       * rather than announcing that it is walking on from a shop it never
       * reached.
       */
      if (lost) this.loops.noteOffline();
      else this.loops.stop(t('session.loop.stoppedDisconnected'));
      this.supplies.abandon(t('automation.supplies.abandonedConnectionClosed'));
      this.journey = lost ? this.walker.journey : null;
      /*
       * A walk cannot continue through a closed socket, and leaving it in
       * `walking` means the card reports progress for a route nothing is
       * walking until the step timeout eventually fires. Say so at once.
       *
       * The queue is cleared for the same reason: intents held for a session
       * that has ended would be sent into the *next* one.
       */
      this.walker.stop(t('session.walk.stoppedConnectionClosed'));
      this.queue.clear();
      /*
       * The character is no longer in the realm, and saying otherwise is a lie
       * the HUD acts on: it went on reporting vitals and a room for a character
       * whose socket had closed. Identity survives — the offline card and the
       * tab still have a name to show.
       */
      if (this.tracker.leaveRealm()) {
        this.publishCharacter();
        this.routines.onCharacter(this.tracker.current);
        this.rules.onState(this.tracker.current);
        this.walker.onCharacter(this.tracker.current);
      }
      const detail = graceful
        ? t('session.connection.disconnected')
        : t('session.connection.closedByRemote');
      this.patch({ phase: 'closed', connectedAt: null, detail });
      this.sink.notice(detail);
      /*
       * A socket that went without this client asking is a *loss*, and a loss
       * is the only thing anything dials back. `graceful` is the whole test:
       * the player's Disconnect, the low-health hang-up, dialling a second
       * realm and quitting all route through `TelnetClient.disconnect()` and
       * reach here as one.
       *
       * `login.standDown` is the other half. Somebody who typed their way out
       * to the menu and then logged off the BBS also arrives here ungracefully
       * — the far end hung up — and dialling them back would put them in the
       * realm they just walked out of, with their password if automatic login
       * is on. That latch already exists to stop the login sequence for
       * exactly this; it is read rather than copied.
       */
      if (!graceful) this.sink.dropped(this.login.standDown);
    });

    this.client.on('error', (error) => {
      this.patch({ phase: 'error', detail: error.message });
      this.sink.notice(t('session.connection.socketError', { message: error.message }));
    });
  }

  get state(): ConnectionState {
    return this.current;
  }

  get log(): TelnetEvent[] {
    return [...this.telnetLog];
  }

  get lines(): StreamLine[] {
    return [...this.lineLog];
  }

  get character(): CharacterState {
    return this.tracker.current;
  }

  /** The lapse the notice quotes, in whole seconds. Read, never captured. */
  private get staleMoveSeconds(): number {
    return Math.round(tuning().parse.staleMoveMs / 1000);
  }

  /** What this character has learned about the realm the data does not have. */
  get learned(): Discovery[] {
    return [...(this.memory?.all ?? [])];
  }

  /**
   * Writes down a way through the realm the realm data does not have, once.
   *
   * Said out loud the first time and never again, which is what the store's
   * de-duplication buys: walking a new corridor every day should not announce
   * it every day. It is worth saying at all because the alternative is a file
   * quietly filling up with observations nobody knows were made — and because
   * the client having *noticed* is the part a player would otherwise assume
   * had not happened.
   */
  private remember(discovery: Discovery): void {
    const fresh = this.memory?.learn(discovery);
    if (!fresh) return;
    this.sink.notice(t('session.memory.learned', { discovery: describeDiscovery(fresh) }));
    this.sink.learned?.(this.learned);
  }

  /**
   * Strikes an observation out because the player says it is wrong.
   *
   * The player's call, not the client's: nothing automatic can tell a
   * mistyped direction the server accepted from a genuine way through. Said
   * out loud like learning was, so the record and the terminal agree, and
   * republished so every window showing the card sees it go.
   */
  forget(discovery: Pick<Discovery, 'from' | 'command'>): boolean {
    const struck = this.memory?.forget(discoveryKey(discovery)) ?? false;
    if (!struck) return false;
    this.sink.notice(
      t('session.memory.forgot', { command: discovery.command, from: discovery.from })
    );
    this.sink.learned?.(this.learned);
    return true;
  }

  async connect(target: ConnectionTarget): Promise<ConnectionState> {
    this.telnetLog.length = 0;
    this.lineLog.length = 0;
    this.lineSeq = 0;
    this.tokenizer.reset();
    this.feed.reset();
    this.classifier.reset();
    this.tracker.reset();
    this.queue.clear();
    this.sentLog.length = 0;
    this.routines.reset();
    this.rules.reset();
    this.walker.reset();
    this.combat.reset();
    this.recovery.reset();
    // A refusal arriving before the new session's first prompt is nobody's.
    this.answering = null;
    this.loot.reset();
    this.drop.reset();
    this.search.reset();
    this.deposit.reset();
    this.light.reset();
    this.supplies.reset();
    this.remotes.reset();
    this.heal.reset();
    this.potions.reset();
    this.cures.reset();
    this.blessings.reset();
    /*
     * The loop and the player's route are the two things a new connection
     * does not put down — *when it is the same realm*. A loop is a list of
     * rooms in one realm and a journey ends in one, so a dial to a different
     * address puts both down and says so; `Reconnect` dials the address last
     * dialled, so a loss carried this far comes back to the realm it was
     * running on. `target` is the last address dialled, kept through `closed`.
     *
     * A loop that is not carried — stopped, idle, or running on a socket that
     * has not closed yet — is reset as before, and the followers' `@wait` with
     * it: a `@wait` from a session that ended must not hold a loop nobody
     * asked it to. With a carried loop the set stays, because the followers
     * who said it are still where they were and have not said `@ok`.
     */
    const sameRealm = this.current.target !== null && sameTarget(this.current.target, target);
    if (!sameRealm) {
      if (this.loops.carried) this.loops.stop(t('session.loop.stoppedRealmChanged'));
      if (this.journey !== null) {
        this.sink.notice(
          t('session.walk.notResumed', {
            destination: this.journey.name,
            reason: t('session.loop.stoppedRealmChanged')
          })
        );
        this.journey = null;
      }
    }
    if (!this.loops.carried) {
      this.loops.reset();
      this.waitingFollowers.clear();
    }
    this.events.reset();
    this.refusedEdges.clear();
    this.realmMismatchSaid = false;
    this.hangUp.reset();
    this.pvpSaid.clear();
    this.lastHangUpRefusal = null;
    this.lastAskedToEscape = 0;
    this.lastEscapeSent = 0;
    this.retreat = null;
    this.safetyLog.length = 0;
    this.engageLog.length = 0;
    this.login.reset();
    this.outbound = '';
    this.playerMove = null;
    this.phaseWas = 'unknown';
    this.saidWaitingToBePlaced = false;
    this.awaitingPassword = false;
    this.cancelIdleFlush();
    this.patch({ phase: 'connecting', target, detail: null, connectedAt: null });
    this.sink.notice(
      t('session.connection.connecting', {
        host: target.host,
        port: target.port,
        encoding: target.encoding
      })
    );

    try {
      await this.client.connect(target);
      // Report the geometry the renderer last measured, so the server sizes its
      // output correctly from the first screen rather than after a resize.
      this.client.resize(this.lastSize);
      this.patch({ phase: 'connected', connectedAt: Date.now(), detail: null });
      this.sink.notice(t('session.connection.connected', { host: target.host, port: target.port }));
    } catch (error) {
      const detail = errorMessage(error);
      this.patch({ phase: 'error', detail });
      this.sink.notice(t('session.connection.failed', { detail }));
    }

    return this.current;
  }

  disconnect(): ConnectionState {
    if (!this.client.connected) return this.current;
    this.patch({ phase: 'closing' });
    this.client.disconnect();
    return this.current;
  }

  send(data: string): void {
    /*
     * The shadow of the server's input line. Movement is the strongest
     * room-resolution signal there is, so the tracker needs to know what was
     * typed — and the queue needs to know whether a *partial* line is on the
     * wire, because anything automation sends while one is would be glued
     * onto it by the server. Erases are honoured for the same reason the
     * buffer exists at all: this must hold what the server's line editor
     * holds, or it answers the "is the line clear" question about a line the
     * player has already backspaced away. `editorInput` is the other half of
     * that rule: a control byte the server keeps nothing of must not leave a
     * line here that stands automation down for twenty seconds.
     */
    for (const ch of editorInput(data)) {
      if (ch === '\x7f' || ch === '\b') this.outbound = this.outbound.slice(0, -1);
      else this.outbound += ch;
    }

    // A chunk can carry a whole command and its terminator at once — a paste,
    // or a caller sending `who\r` in one go — so this loops rather than
    // assuming one keystroke per call.
    for (;;) {
      const newline = this.outbound.search(/[\r\n]/);
      if (newline === -1) break;
      const command = this.outbound.slice(0, newline).trim();
      this.outbound = this.outbound.slice(newline + 1).replace(/^\n/, '');
      if (command.length > 0) {
        /*
         * The tracker is the one thing here that knows the command table, the
         * walker's hint and this room's own text exits, so it is what says
         * whether this was a step — `go manhole` is a move and `gossip` is
         * not, and neither is decidable from the word.
         */
        if (this.tracker.observeCommand(command)) {
          this.playerMove = { where: this.whereWeStand(), at: Date.now() };
        }
        this.login.observeCommand(command);
        this.classifier.observeCommand(command);
        this.noteSent(command, 'user');
      } else {
        // The player pressing Return on an empty line reprints the room just
        // as the walker's nudge does, and the block it produces has to be
        // attributed to it for the same reason. Same gate, same door.
        this.tracker.observeReread();
      }
      this.sink.command?.(this.reportable(command), 'user');
      if (command.length > 0) {
        // Auto-combat listens for two of them: `break` stands it down, an
        // attack hands it the fight back. Every command, because both of those
        // are things the player *typed* rather than things that happened.
        this.combat.noteUserCommand(command);
      }
    }

    // A line this long is not a command; drop it rather than growing forever.
    if (this.outbound.length > tuning().session.outboundLineLimit) this.outbound = '';

    /*
     * The player's bytes go on the wire **before** the queue hears about
     * them. `noteTyping(false)` releases held commands synchronously, and
     * with this line below it the released command reached the socket ahead
     * of the very Enter that released it — the server read `dance` + the
     * automated attack as one line and said `dancepu thin carrion beast` out
     * loud in the room (captured live, 2026-08-26, 14:22 session). Writes on
     * one socket keep their order, so sending the keystroke first is the
     * whole fix.
     */
    this.client.send(data);

    // The player typing is this client sending, so the idle clock restarts.
    this.routines.noteSent();
    /*
     * A half-typed line stands automation down; a committed or erased one
     * hands the floor straight back. State, not a timer — the grace this
     * replaces released mid-word whenever the player paused, which is how an
     * automated `pu thin kobold thief` landed inside a half-typed `l` and the
     * server said `lpu thin kobold thief` out loud in the room.
     */
    this.queue.noteTyping(this.outbound.length > 0);
  }

  resize(size: TerminalSize): void {
    this.lastSize = size;
    this.client.resize(size);
  }

  /**
   * Where the character is standing, in whatever terms are available.
   *
   * The resolved room where the realm data has placed one, and the room's own
   * name where it has not — a corridor of namesakes resolves by id and an
   * unplaced room still changes name, and this is only ever compared against
   * itself. Null in a room nothing has described, which is a comparison that
   * says nothing and is treated as saying nothing.
   */
  private whereWeStand(): string | null {
    const { map, number, name } = this.tracker.current.room;
    if (map !== null && number !== null) return roomId(map, number);
    return name;
  }

  /**
   * The player's own direction landed, so the walk and the loop stand down.
   *
   * The stop belongs to the *arrival* rather than to the keystroke: a typed
   * `n` that the server refuses moves nobody, and a lap ended by a wall is a
   * lap ended by nothing. What says it landed is the room changing — every
   * other outcome of a direction leaves the character where it was.
   *
   * Written off after `tuning.session.playerMoveWindowMs`. Not every failure
   * is a `direction-failed` this can hear (a refused command is *said out
   * loud*, and a realm this client has never met may word a wall differently),
   * and an arm left standing would eventually be answered by a walk step's own
   * arrival and blame the player for stopping it.
   */
  private notePlayerSteering(state: CharacterState): void {
    const armed = this.playerMove;
    if (armed === null) return;
    if (Date.now() - armed.at > tuning().session.playerMoveWindowMs) {
      this.playerMove = null;
      return;
    }
    const { map, number, name } = state.room;
    const here = map !== null && number !== null ? roomId(map, number) : name;
    if (here === null || here === armed.where) return;
    this.playerMove = null;
    this.walker.notePlayerMoved();
    this.loops.notePlayerMoved();
    // And the errand, which is a walk automation chose: the player steering is
    // the one thing it may never argue with.
    this.supplies.notePlayerMoved();
  }

  /**
   * Watches the one phase change that means a character has gone.
   *
   * `in-game` to anything else, on a connection that is still up, is the menu:
   * `quit` from inside the realm, and the prompt that follows it. It is the
   * transition rather than the state because a menu is also where a session
   * *starts*, and standing every module down through a login would be a
   * client that turned itself off on the way in.
   *
   * The socket closing is not this. It publishes outside the block path
   * (`client.on('close')`), tears its own half down, and `connect` resets
   * everything before the next session — which is also what re-arms this,
   * so a reconnect's own `authenticating` is not read as somebody leaving.
   */
  private noteRealmPhase(state: CharacterState): void {
    const was = this.phaseWas;
    this.phaseWas = state.phase;
    if (was === 'in-game' && state.phase !== 'in-game') this.leftTheRealm();
  }

  /**
   * Picks up what a lost connection left owed, once the character is back.
   *
   * Two things are carried across a loss and nothing else: a running or
   * paused loop (`LoopRunner.carried`) and the route the player was walking
   * (`journey`). Everything else automated re-derives its decision from the
   * state on every line and needs nothing carried — resting, healing,
   * auto-combat, the errand from the next pack listing.
   *
   * **Back in the realm *and placed*, not merely back.** The realm prints the
   * room on the way in and the entry probe's `rm` states its coordinates a
   * round trip later, and both loop and route are planned *from* that room:
   * a route replanned before it is known is refused for want of a start, and
   * a loop would spend its bounded locate budget asking a question the entry
   * probe has already asked. So this waits for the room, which in the
   * ordinary case is one status line after `in-game`, and says once at the
   * transition what it is waiting for — the loop's chip reads `offline` the
   * while, and a card that says so is the difference between a hold and a
   * broken client.
   *
   * The route first, then the loop, because that is the order the two would
   * have had before the loss: a loop's leg supersedes a route the walker was
   * walking, silently, and picking them up the other way round would drop the
   * leg for the route instead.
   */
  private pickUpAfterLoss(state: CharacterState): void {
    const journey = this.journey;
    if (journey === null && !this.loops.carried) return;
    if (state.phase !== 'in-game') return;
    if (state.room.map === null || state.room.number === null) {
      // Said once and not on every line: the entry probe is what asks where
      // the character is, and this is only ever waiting for the answer. And
      // only when something will in fact walk on — a paused lap is carried
      // paused, and a promise that it walks on is one the client cannot keep.
      const walksOn = journey !== null || this.loops.progress.status === 'running';
      if (walksOn && !this.saidWaitingToBePlaced) {
        this.saidWaitingToBePlaced = true;
        this.sink.notice(t('session.reconnect.waitingToBePlaced'));
      }
      return;
    }
    if (journey !== null) {
      this.journey = null;
      const route = this.planFromHere(journey.to);
      const refused =
        typeof route === 'string' ? route : this.walker.start(route, this.tracker.current);
      if (refused !== null) {
        this.sink.notice(
          t('session.walk.notResumed', { destination: journey.name, reason: refused })
        );
      } else {
        this.sink.notice(t('session.walk.resumed', { destination: journey.name }));
      }
    }
    // Lets the hold go; `loops.onCharacter`, later on this same line, plans
    // the leg from the room that just placed the character.
    this.loops.noteOnline();
  }

  /**
   * The character walked out to the menu, so everything about it is put down.
   *
   * `CharacterTracker.forgetCharacter` forgets the *facts*; this forgets the
   * *decisions taken from them*, and the two have to happen together. The half
   * that was missing was the third one: `Routines` had already fired its
   * realm-entry probe for this connection and would not fire it again, so a
   * character rerolled at the menu and walked back in kept the old one's name
   * on every card — with `st` and `i`, the two commands that would have
   * corrected it, sitting in `onEnterRealm` and never sent (2026-08-31).
   *
   * The queue is cleared for the reason the socket-close path clears it:
   * intents raised for a character standing in the realm must not be sent into
   * a menu, or into whoever logs in next.
   *
   * `LoginAutomator` is deliberately **not** reset. It stands down on
   * `user-exits-realm` on purpose, and re-arming it here would answer the
   * character-selection menu with the credentials of a login already made.
   */
  private leftTheRealm(): void {
    this.sink.notice(t('session.realm.left'));
    this.queue.clear();
    this.playerMove = null;
    // A journey owed across a loss is owed to a character standing in the
    // realm; one who walked out to the menu has ended it.
    this.journey = null;

    // The loop before the walker: stopping a walk calls `ended`, and a loop
    // still running would book that as a failed leg on its way out.
    this.loops.stop(t('session.loop.stoppedLeftRealm'));
    this.walker.stop(t('session.walk.stoppedLeftRealm'));
    this.loops.reset();
    this.walker.reset();

    // Everything else that decides on this character's behalf, in the order
    // `connect` resets it, so the two lists can be read against each other.
    this.routines.reset();
    this.rules.reset();
    this.combat.reset();
    this.recovery.reset();
    // A refusal arriving before the new session's first prompt is nobody's.
    this.answering = null;
    this.loot.reset();
    this.drop.reset();
    this.search.reset();
    this.deposit.reset();
    this.light.reset();
    this.supplies.reset();
    this.remotes.reset();
    this.heal.reset();
    this.potions.reset();
    this.cures.reset();
    this.blessings.reset();
    this.events.reset();
    this.hangUp.reset();
    this.pvpSaid.clear();
    this.lastHangUpRefusal = null;
    this.lastAskedToEscape = 0;
    this.lastEscapeSent = 0;
    this.retreat = null;
    /*
     * An edge the realm refused was refused for *this* character — a door it
     * could not open, an exit its class may not use — so the blacklist goes
     * with it rather than costing the next character corridors it can walk.
     */
    this.refusedEdges.clear();
    this.realmMismatchSaid = false;
    /*
     * The traces stay. They are the record of what was decided just before the
     * character left, and leaving the realm is very often what a player does
     * straight after the thing they want to read about.
     */
    this.publishAutomation();
  }

  /** Applies a config reload to the arbiter and the standing routines. */
  /**
   * Tells the terminal feed a command went out — only in the realm.
   *
   * The feed keeps a FIFO of sent commands and pops one per status line, and
   * that arithmetic only holds where every command gets a status line. A
   * login answer does not: the username, the password and the menu picks go
   * out through the same queue before any prompt exists, and with them in the
   * FIFO the first quiet command never reached its head — captured by the
   * smoke run, whose fake host answered `rm` and watched the console show it.
   */
  private noteSent(command: string, from: 'user' | 'automation'): void {
    if (this.tracker.current.phase !== 'in-game') return;
    this.feed.sent(command, from);
  }

  /**
   * A probe asked for from a card, proposed to the arbiter like any other.
   *
   * Through the queue and not `send`, deliberately: that is what makes it an
   * automation command — paced by the prompt, held while the player is
   * typing, and quiet in the console when `internal.yaml` names it.
   */
  ask(command: string): boolean {
    return this.queue.enqueue({
      command,
      priority: 'probe',
      coalesceKey: `ask:${command}`,
      reason: t('session.probe.askedFromCard')
    });
  }

  /**
   * Asks another player's client something, on this character's behalf.
   *
   * The same telepath `Remotes` sends when a party forms, offered from
   * the palette so it is a thing a person can do on purpose. Only in the
   * realm: a telepath typed at a menu is a menu answer.
   */
  askRemote(who: string, name: RemoteName): boolean {
    if (this.tracker.current.phase !== 'in-game') return false;
    // The arbiter's answer, not this one's: a repeat of a question still
    // waiting to go is coalesced into it, and the caller is told so.
    return this.remotes.ask(who, name);
  }

  /** The client's own settings — which of its commands are quiet. Hot-reloaded. */
  configureInternal(internal: InternalConfig): void {
    this.internal = internal;
  }

  configure(automation: AutomationConfig, login: LoginConfig): void {
    this.automationConfig = automation;
    this.queue.configure(automation);
    this.routines.configure(automation);
    this.walker.configure(automation);
    this.combat.configure(
      automation.combat,
      automation.enabled,
      automation.spells,
      automation.party
    );
    this.recovery.configure(automation.health, automation.enabled, automation.party);
    this.loot.configure(automation.loot, automation.enabled);
    this.drop.configure(automation.drop, automation.enabled);
    this.search.configure(automation.search, automation.enabled);
    this.deposit.configure(automation.banking, automation.enabled);
    this.light.configure(automation.movement, automation.enabled);
    this.supplies.configure(automation.supplies, automation.enabled);
    this.remotes.configure(automation);
    this.heal.configure(automation.spells, automation.enabled);
    this.potions.configure(automation.health, automation.enabled);
    this.cures.configure(automation.spells, automation.enabled);
    this.blessings.configure(automation.spells, automation.enabled);
    this.events.configure(automation.events, automation.enabled);
    this.loops.configure(automation.health);
    this.rules.load(automation.rules);
    this.login.configure(login);
    this.secret = login.password;
  }

  /**
   * What the realm about to be dialled knows about its players.
   *
   * The host calls this with the *dialled* address before `connect`, because a
   * character can be dialled at a saved realm other than its own and what it
   * learns there is that realm's. The previous realm is unsubscribed first, so
   * a session never absorbs two realms' players at once.
   *
   * What another character on this realm learns about a player — a look, a
   * gang listing — lands here and is republished, so the flyout on this tab
   * says what the realm knows and not what this socket happened to see.
   * Nothing else is told: no rule reads the registry, and a fact absorbed is
   * not a fact this character observed.
   */
  useRealm(players: RealmPlayers, belongings: BelongingsSink = NO_BELONGINGS): void {
    this.forgetPlayers();
    // A different realm may have the word this one refused. See `locateWord`.
    this.locateWord = 'rm';
    this.tracker.useRealm(players);
    // A vault and a kit are the server's, so they are re-keyed with the roster
    // and not with the character. See `SessionHostOptions.belongingsAt`.
    this.tracker.useBelongings(belongings);
    this.belongings = belongings;
    this.forgetPlayers = players.subscribe((batch) => {
      if (this.tracker.absorbPlayers(batch)) this.publishCharacter();
    });
  }

  /**
   * The clock behind the modules that decide on a number and own no clock.
   *
   * Everything automated in this class hangs off a *state change*, and a state
   * change needs a status line — which a standing, idle character gets only
   * when the server's own regeneration moves a vital, once every thirty
   * seconds. So a module that declined for a reason with a deadline behind it
   * (a heal's cooldown, a potion's, a cure's retry) was not asked again when
   * the deadline lapsed: it was asked whenever the game next happened to
   * speak, or whenever the player pressed Enter, which is what reads as *it
   * only does things when I type*. Measured 2026-09-02: a cast came off its
   * six-second cooldown at 97.6s and went out at 120.5s, on the player's own
   * keystroke.
   *
   * See `reconsider` for what this drives and what it deliberately does not,
   * and the constructor for why it is armed there and nowhere else.
   */
  private reconsiderTimer: NodeJS.Timeout | null = null;

  dispose(): void {
    this.cancelIdleFlush();
    this.forgetPlayers();
    this.feed.dispose();
    if (this.reconsiderTimer) clearInterval(this.reconsiderTimer);
    this.reconsiderTimer = null;
    if (this.automationTimer) clearTimeout(this.automationTimer);
    this.automationTimer = null;
    this.queue.dispose();
    this.routines.dispose();
    this.rules.dispose();
    this.walker.dispose();
    this.blessings.dispose();
    // The errand's own deadline on the counter answering: an owned timer, so
    // it is cleared here like every other one rather than left to fire against
    // a disposed session.
    this.supplies.dispose();
    this.combat.dispose();
    this.client.disconnect();
    this.client.removeAllListeners();
  }

  /** Restarts the quiet-period timer that releases a trailing prompt. */
  private armIdleFlush(): void {
    this.cancelIdleFlush();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.flushPending();
    }, IDLE_FLUSH_MS);
    // Never the reason a process stays alive.
    this.idleTimer.unref?.();
  }

  private cancelIdleFlush(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private flushPending(): void {
    this.cancelIdleFlush();
    const at = Date.now();
    for (const framed of this.tokenizer.flush()) this.publishLine(framed, at);
    this.paint(at);
  }

  /** Pushes whatever the feed decided the terminal sees, if anything. */
  private paint(at: number): void {
    const emitted = this.feed.take();
    if (emitted.text.length === 0) return;
    this.seq += 1;
    this.sink.data({
      seq: this.seq,
      at,
      text: emitted.text,
      ...(emitted.marks.length > 0 ? { marks: emitted.marks } : {})
    });
  }

  /**
   * Stamps a framed line with identity, publishes it, feeds the terminal, and
   * only then acts on what it was.
   *
   * **The feed sees the line before anything acts on it**, and that order is
   * load-bearing. Acting on a status line is what sends the next queued
   * command — the entry probe's `rm` goes out from inside the handling of the
   * prompt that acknowledged the realm — and a command sent *before* the
   * feed has seen that prompt is popped by it, as though the prompt had
   * answered it. It had not; it preceded it. Classify, feed, then act.
   *
   * A classifier fault costs the line its type and never its paint, and is
   * reported once: a parser defect must not cost a paint or the raw stream.
   */
  private publishLine(
    framed: { text: string; terminator: StreamLine['terminator'] },
    at: number
  ): void {
    this.lineSeq += 1;
    const line: StreamLine = {
      seq: this.lineSeq,
      at,
      text: framed.text,
      plain: plainText(framed),
      terminator: framed.terminator
    };

    this.lineLog.push(line);
    if (this.lineLog.length > tuning().session.lineLogLimit) this.lineLog.shift();
    this.sink.line(line);

    let classified: ReturnType<Classifier['classify']> | null = null;
    try {
      classified = this.classifier.classify(line);
    } catch (error) {
      this.reportParserFault(error);
    }

    this.feed.line(
      line.text,
      line.terminator,
      line.plain,
      classified?.block.type ?? null,
      classified ? this.markFor(classified.block) : undefined
    );
    if (!classified) return;

    try {
      this.act(classified.block, classified.batch);
      /*
       * One framed line, several facts: the server printed a sentence after
       * the prompt without a repaint between them (`tailAfterPrompt`). They
       * are acted on *after* the prompt, in the order the server wrote them,
       * because the prompt is what releases the next queued command and a fact
       * arriving before its own acknowledgement would be attributed to the
       * command ahead of it.
       */
      for (const tail of classified.tails ?? []) this.act(tail, undefined);
    } catch (error) {
      this.reportParserFault(error);
    }
  }

  /** Reported once per session: the terminal keeps painting either way. */
  private parserFaultReported = false;

  private reportParserFault(error: unknown): void {
    if (this.parserFaultReported) return;
    this.parserFaultReported = true;
    this.sink.notice(t('session.parser.fault', { message: errorMessage(error) }));
  }

  /** Everything that happens because of what a line was. */
  private act(block: Block, batch: ReturnType<Classifier['classify']>['batch']): void {
    this.sink.block(block);
    if (batch) this.sink.block(batch);
    /*
     * Armed *before* the automator sees the block, because it answers the
     * prompt synchronously from inside that call. Arming afterwards redacts the
     * command after the password -- the menu selection -- and writes the
     * password itself down verbatim, which is the exact opposite of the intent
     * and looks correct at a glance.
     *
     * Every prompt that asks for a password arms it, not only the login's. The
     * account-creation path prints `Please enter the password you would like
     * to use:` and then `Please confirm your new password:`, the server echoes
     * `*` for each keystroke at both, and a capture from 2026-08-26 held both
     * answers verbatim because only the login prompt was keyed on here.
     */
    if (block.type === 'prompt-password' || block.type === 'prompt-new-password') {
      this.awaitingPassword = true;
    }

    this.login.onBlock(block);
    /*
     * An unrecognised command is not refused by this server — it is *said out
     * loud*. Captured live: `exits`, `time`, `stats` and `gold` all came back
     * as `You say "..."`.
     *
     * That fact is worth having and it is **not printed here**. It used to be
     * echoed into the stream as a notice, one line under the line it was about
     * — the server had already said the words, in the room, in full, and the
     * client repeated them back with a frame around them. `command-not-
     * understood` is `warning` in `NOTABLE`, so the Alerts card raises it,
     * keeps it, and lets it be gone back to; a notice in the console says the
     * same thing louder, in the one place the design forbids chrome, and
     * scrolls away regardless.
     *
     * One thing *is* acted on, and it is the automation's own word rather
     * than the player's: a realm with no locate command has just said so, in
     * front of everybody in the room. Asking again would say it again. Told
     * out loud once, because a client that quietly stops asking where it is
     * looks exactly like one that has stopped needing to.
     */
    if (
      block.type === 'command-not-understood' &&
      this.locateWord !== null &&
      block.groups['message'] === this.locateWord
    ) {
      this.sink.notice(t('session.loop.locateUnavailable', { command: this.locateWord }));
      this.locateWord = null;
    }

    /*
     * The player's own direction was refused, so nobody moved and nobody took
     * the wheel. Disarmed before the walker sees the block, because the walker
     * may be about to answer the same refusal with an `open` and a step of its
     * own — and the room that follows *that* is the walk's, not the player's.
     *
     * Any `direction-failed` disarms it, even one that belongs to a walk step
     * rather than to the typed move. Both are refusals of a direction with the
     * player's own among the outstanding ones, and this cannot tell which
     * (`Walker.refusalIsOurs` is the same problem, answered the same
     * conservative way). Being wrong here costs a walk that goes on running
     * while somebody steers, which is the direction this whole change moves
     * in; being wrong the other way ends a lap for a wall.
     */
    if (block.type === 'direction-failed') this.playerMove = null;

    /*
     * A death is a teleport, so everything that was on its way somewhere stops.
     *
     * Before the walker, for the reason `leftTheRealm` states: stopping a walk
     * calls `ended`, and a loop still running books that as a failed leg,
     * skips the stop it could not reach and plans the *next* one — out of the
     * temple, back towards whatever killed the character, with nothing on
     * screen saying a death was what happened. The walker stops itself on this
     * same block, which is right: a plain walk has to end on a death whether
     * anything else is watching or not.
     */
    if (block.type === 'user-dies') this.stopGoingAnywhere();

    this.noticeRealmMismatch(block);
    this.rules.onBlock(block);
    this.walker.onBlock(block);
    /*
     * A `rm` used to go out on every `*Combat Off*` while a loop ran, on the
     * reading that combat is where dead reckoning breaks. **Measured, and it
     * is not.** Replaying all 113 recorded sessions through the real tracker
     * — 2,159 rooms, 5,842 commands, no re-anchoring at all after the opening
     * fix — the client's own reckoning agreed with every single `Location:`
     * the server ever stated. Not one wrong room, in either direction.
     *
     * The one position it ever lost was not combat either: it was a refused
     * command leaving a move queued that no room was coming for, which
     * `command-not-understood` now takes back where it is handled. And the
     * courtesy reprint this guarded against fires on 4 of 574 live `*Combat
     * Off*`s, while the guard fired on all 574.
     *
     * So the ask is gone, and what is left is `LoopRunner`'s bounded locate,
     * which asks only when the client actually cannot tell — the shape every
     * other command in this client follows. It also had to go for a reason no
     * measurement was needed for: **MajorMUD has no `rm`**, so on that realm
     * every one of those was the client saying "rm" out loud to everybody in
     * the room, once per fight, all evening.
     */
    this.combat.onBlock(block);
    this.loot.onBlock(block, this.tracker.current);
    this.light.onBlock(block, this.tracker.current);
    this.supplies.onBlock(block, this.tracker.current);
    this.remotes.onBlock(block, this.tracker.current);
    /*
     * The spellbook ask correcting itself: a wrong-book refusal names the
     * right listing, and a level-up invalidates the one on file.
     */
    this.routines.onBlock(block);
    /*
     * Before `tracker.apply`, deliberately: a wear-off is about to take the
     * buff off the list, and the entry — with the caster's name on it — is
     * the only record of whom to notify.
     */
    this.blessings.onBlock(block, this.tracker.current);
    /*
     * A party forming or breaking up is the moment its roster becomes worth
     * having — and the moment it is emptiest, because nothing has asked.
     */
    if (
      block.type === 'party-joined' ||
      block.type === 'party-left' ||
      block.type === 'party-rank-changed'
    ) {
      this.routines.onPartyChanged();
      // And the numbers behind the percentages, from the members' own clients.
      this.remotes.askParty(this.tracker.current);
    }
    /*
     * Somebody was noticed with no listing to say what they are — entering the
     * realm, or walking into this room without already being on the roster at
     * all (a character connecting mid-session never saw *their* entry). Both
     * are read against the roster as it stands **before** this block is
     * applied: `player-arrives-room` needs to know whether the name is already
     * known, and `tracker.apply` is what would add it.
     *
     * `Routines` decides what to do about it: one `who`, at most once a
     * minute, sent on the arrival itself and drained on the idle tick or the
     * next state change when the arrival landed inside that window.
     */
    if (block.type === 'player-enters') {
      this.routines.onRosterUnknown();
    } else if (block.type === 'player-arrives-room') {
      const player = block.groups['player'];
      if (player && !this.tracker.current.online.some((entry) => entry.name === player)) {
        this.routines.onRosterUnknown();
      }
    } else if (batch?.type === 'who-list') {
      this.routines.onWhoListing();
    }

    /*
     * Anybody standing in this room, offered to the look routine — which does
     * nothing at all unless `automation.talk.lookAtPlayers` is on.
     *
     * Read from the room **after** the block was applied, unlike the roster
     * catch-up above: this wants who is in the room *now*, and the occupant
     * list is what the block just replaced. Players only, and never this
     * character — looking at yourself is a different command with a different
     * answer, and it is not what the setting asks for.
     */
    for (const occupant of this.tracker.current.room.occupants) {
      if (occupant.kind !== 'player') continue;
      if (occupant.name === this.tracker.current.name) continue;
      this.routines.onPlayerSeen(occupant.name);
    }
    // Evidence about whether hanging up would be penalised: who hit whom, and
    // whether they are a player. Fed the roster as it stands *before* this
    // block is applied, which is right — a name arrives in the roster from a
    // listing or a broadcast, never from a blow.
    this.hangUp.observe(block, this.tracker.current.online);
    this.publishAutomation();

    // Both are applied, deliberately not short-circuited: `||` would skip the
    // batch whenever the line that completed it also changed state — and the
    // line that completes a stat sheet is the status line, which always does.
    const lineChanged = this.tracker.apply(block);
    const batchChanged = batch ? this.tracker.apply(batch, batch.rows) : false;
    const changed = lineChanged || batchChanged;

    /*
     * Any prompt is an acknowledgement: the server has finished with the last
     * command and is waiting for input. Acking only on the *in-game* status
     * line meant the login sequence had nothing to ack it at all, so after
     * `window` answers the queue sat on the 3s timeout — the whole reason
     * logging in took four and a half seconds.
     */
    if (block.type === 'status-line' || block.domain === 'session') this.queue.notePrompt();
    /*
     * Which command the next answer is about: the status line's own echo.
     *
     * The server prints the command it is answering after the prompt —
     * `[HP=334/KAI=0]:med` — and everything up to the next prompt is that
     * command's answer. So `Your command had no effect.` is attributed to the
     * echo before it, never to the queue's bookkeeping, which counts prompts
     * and cannot tell the player's `l` from automation's `med` sent in the
     * same breath. Read here because the refusal is a fact about the wire; a
     * module that proposes a verb is told and decides for itself.
     */
    if (block.type === 'status-line') this.answering = echoedCommand(block.text);
    /*
     * A command typed ahead of the prompt is echoed on a bare line instead —
     * `captures/009:141`: `hid` at the prompt, `bs k` on its own line, then
     * the refusal, which is the second command's. The classifier already
     * knows an echo of something this client sent, so it moves the answer
     * along with it.
     */ else if (block.type === 'command-echo') this.answering = block.text.trim();
    else if (block.type === 'command-no-effect') this.recovery.noteNoEffect(this.answering);
    /*
     * **What the server still owes this client is a fact about the wire, so it
     * is read off every line rather than off the ones that moved the HUD.**
     *
     * Both halves of it used to sit inside the `if (changed)` below, among the
     * things that *decide* — and the answer to a step is not a decision. A
     * refusal (`There is no exit in that direction!`) answers a move and
     * changes nothing else, so the client learned the step had landed only on
     * whatever line happened to change something next.
     *
     * `expireStaleClaims` is the other half, and it is the one the report was
     * actually about. A step nothing ever answers used to stay outstanding for
     * the rest of the session, and six things gate on that: running away,
     * `Walker.start`, a loop's next leg, the walk home and auto-combat. Exactly
     * one of them — auto-combat — had a clock, so it recovered after eight
     * seconds, said so, and left the character unable to run, walk or loop for
     * the whole evening with nothing further said. The bound moved to the claim
     * itself so they all recover together, and this is where it is said out
     * loud: once, naming the command, because "a step went unanswered" is a
     * sentence a player can only agree with.
     */
    for (const lost of this.tracker.expireStaleClaims(Date.now())) {
      const seconds = this.staleMoveSeconds;
      /*
       * Four literal keys rather than one composed sentence, because
       * `i18n-coverage.test.ts` reads the key straight after `t(` — and
       * because only a **move** held anything. `pendingMoves` counts moves
       * alone, so a lapsed peek or bare Enter gated neither the escape nor the
       * walker nor a loop, and saying it had was a sentence that was false
       * about once a session (a bare Enter goes unanswered about once in three
       * thousand).
       */
      if (lost.moved) {
        this.sink.notice(
          lost.command.length === 0
            ? t('session.walk.claimLapsedUntyped', { seconds })
            : t('session.walk.claimLapsed', { command: lost.command, seconds })
        );
      } else {
        this.sink.notice(
          lost.command.length === 0
            ? t('session.walk.readLapsedUntyped', { seconds })
            : t('session.walk.readLapsed', { command: lost.command, seconds })
        );
      }
    }
    this.combat.noteMovePending(this.tracker.pendingMoves > 0);
    // Republish only on a real change: during a combat burst most lines say
    // nothing new, and a HUD re-render per line is exactly the stall the
    // architecture exists to prevent.
    if (changed) {
      const state = this.tracker.current;
      this.publishCharacter();
      /*
       * Walking out to the menu is a character *leaving*, and everything
       * automated is about the one that was here. Before the modules below
       * read the new state, because half of them would otherwise act once on
       * a character that has gone.
       */
      this.noteRealmPhase(state);
      /*
       * Before anything automated reads the new state: a walk or a loop the
       * player has just steered out from under stands down *now*, so the
       * walker reports "you moved the character yourself" rather than the
       * wrong-room stop it would reach a line later, which describes the
       * symptom instead of what happened.
       */
      this.notePlayerSteering(state);
      /*
       * And what a lost connection left owed, before anything automated reads
       * the state: the route is handed back to the walker and the loop's hold
       * is let go here, so `walker.onCharacter` and `loops.onCharacter` below
       * decide on the leg from the same line that placed the character.
       */
      this.pickUpAfterLoss(state);
      this.routines.onCharacter(state);
      this.rules.observe({ hangUpClean: this.hangUp.assess(state, Date.now()).clean });
      this.rules.onState(state);
      this.walker.onCharacter(state);
      this.loops.onCharacter(state);
      // A dark arrival, or a lit room to put the torch out in. Told whether
      // the walker has the character, because a torch is never put out
      // mid-route: the next step may be dark again.
      this.light.onCharacter(state, this.walker.walking);
      this.events.onCharacter(state);
      // Telling a party leader this character has sat down, and that it is up
      // again. A fact about this character, so it goes out with the others.
      this.remotes.onCharacter(state);
      // Running away is tried *first*, because it is the escape that works and
      // the one that costs nothing: an unclean disconnect is penalised on this
      // server family and can kill outright.
      this.considerEscape(state);
      // And the walk home a `safe-haven` escape armed, once the fight is over.
      this.walkHomeIfDue(state);
      // Shopping, which yields to every one of the above: not while running
      // away, not while walking home, not while anything else has the
      // character. See `Supplies.consider`.
      this.supplies.onCharacter(state);
      this.considerHangingUp(state);
      /*
       * And fighting is considered *last*, after both escapes have had their
       * say. The order is the whole safety argument: a client that opened a
       * fight in the same tick it decided to run would have spent the escape
       * and stayed in the fight. `retreating` holds for the escape's own
       * cooldown, which is how long the attempt has to work in.
       */
      this.combat.noteRetreating(this.isRetreating());
      // A step still waiting for its room stands auto-combat down: a fight
      // opened now lands in the room being left. Observed above, off every
      // line, because it is a fact about the wire rather than about the state.
      this.combat.onCharacter(state);
      /*
       * And sitting down last of all, which is where it belongs rather than
       * beside the retreat it looks like: it is the thing to do when none of
       * the above found anything to do. It refuses in combat by itself, so this
       * needs no guard of its own — but it does need to come after, because a
       * character that has just been told to run is not one to rest.
       */
      // A blessing marked prioritizeOverHeal goes ahead of the heal: the
      // shield a caster dies without outranks the number that is already bad.
      if (!this.isRetreating()) this.blessings.urgent(state);
      // Healing before resting: a number a spell can fix now is not one to sit down over.
      if (!this.isRetreating()) this.heal.onCharacter(state);
      // And a potion beside the spell, under the same guard: nothing is drunk
      // on the way out of a room, because a move in flight is the escape.
      if (!this.isRetreating()) this.potions.onCharacter(state);
      // A cure is a heal chosen by a sentence rather than a number; a buff is
      // the least urgent thing here and refuses combat by itself. Neither on
      // the way out of a room, for the reason above.
      if (!this.isRetreating()) {
        this.cures.onCharacter(state);
        this.blessings.onCharacter(state);
        // Shedding named junk reads the same maintained pack listing the loot
        // fills, and refuses combat and rest for itself.
        this.drop.onCharacter(state);
        /*
         * And looking for what the room did not print. After the shedding and
         * before the banking for no reason but the reading order of the block;
         * it is `probe` band and refuses combat and rest for itself, so
         * nothing here depends on where in the list it sits.
         */
        this.search.onCharacter(state);
        // And banking the purse at a counter, which refuses combat and an
        // unread purse for itself.
        this.deposit.onCharacter(state);
      }
      /*
       * And not while a route is being walked.
       *
       * Nothing told `Recovery` a walk was running, so a character walking at
       * low health was sat down by it and stood straight back up by the
       * walker's next step — which is what moving does to a rest — and sat down
       * again on the tick after: two subsystems spending commands undoing each
       * other out of the budget the walk itself is spent from. Still true now
       * that nothing sends a stand-up command, because the *step* is what
       * breaks the rest and the steps keep coming. A character being walked
       * somewhere is not one to sit down; when the walk ends, resting is
       * considered again on the very next tick.
       */
      if (this.mayRest()) this.recovery.onCharacter(state);
    }
  }

  /**
   * Whether sitting this character down is the client's to propose at all.
   *
   * One statement of the gate, read by the block path and by the tick, because
   * two halves of one gate in two files agree until one of them is edited —
   * which is exactly what `AutoCombat.quarry` was pulled together to stop.
   *
   * Three refusals, and every one of them is *somebody else is already moving
   * this character*:
   *
   * - **An escape in flight.** A character on its way out of a room is not one
   *   to sit down in it.
   * - **A walk in progress.** Nothing told `Recovery` a walk was running, so a
   *   character walking at low health was sat down by it and stood straight
   *   back up by the walker's next step — two subsystems spending commands
   *   undoing each other out of the budget the walk itself is spent from.
   * - **A loop between legs.** `Walker.walking` is false during the dwell a
   *   loop takes at each stop, so the same undoing came back one rung up: sit
   *   down at the stop, stand up on the next leg, once per stop for as long as
   *   the lap runs. A loop that *should* stop for health has a pair of
   *   thresholds of its own (`restBelow`/`restTo`) and reports it as
   *   a `health` hold — so a held loop is exactly when resting is right, and a
   *   marching one is exactly when it is not. This became worth stating when
   *   `restTo` widened the band: before it, only a character under
   *   `restBelow` was affected.
   */
  private mayRest(): boolean {
    if (this.isRetreating()) return false;
    /*
     * A walk that is *marching* refuses, and a walk that is standing still for
     * health does not — those were one condition until a route learned to wait
     * (`Walker.holdForHealth`, 2026-09-02). Marching and resting undo each
     * other; a held walk is standing still precisely so this can happen, and
     * refusing there would recreate the reported bug from the other side, with
     * the walk waiting for a rest that was waiting for the walk.
     */
    if (this.walker.walking && this.walker.holding === null) return false;
    const loop = this.loops.progress;
    return loop.status !== 'running' || loop.hold !== null;
  }

  /**
   * Re-decide, with nothing new to decide from.
   *
   * The four modules here are the ones whose answer can change while the wire
   * says nothing at all — because what changed is a **clock of their own**: a
   * heal or a potion coming off its cooldown, a cure's thirty seconds while
   * the affliction is still stated, a `rest` whose in-flight window has
   * lapsed. Every one of them re-derives its whole decision from the state it
   * is handed and refuses for itself, so a tick on which nothing has moved
   * proposes nothing; they are idempotent by construction, which is what makes
   * a second caller safe at all.
   *
   * What is **not** driven from here, and why:
   *
   * - **`Blessings`** already owns this exact clock for this exact reason, and
   *   two things ticking one module would recast a buff twice as often as its
   *   interval says.
   * - **The walker, the loop, the rules, auto-combat and both escapes.** Every
   *   one of those decides from a fact the wire delivers — a room, a blow, a
   *   roster — and a fact that has not arrived has not changed. Re-running
   *   them against a stale state is how a client acts twice on one event.
   * - **Shedding, searching and banking**, which are driven by a pack or a
   *   room listing rather than by a number on a clock.
   *
   * The order is the block path's order with the clockless modules removed,
   * and the priority argument that puts `blessings.urgent` ahead of the heal
   * is meaningless here for the reason `Blessings` states about its own tick:
   * on a tick where nothing else is being decided there is nothing to be ahead
   * of.
   */
  private reconsider(): void {
    const state = this.tracker.current;
    if (state.phase !== 'in-game') return;
    if (this.isRetreating()) return;
    this.heal.onCharacter(state);
    this.potions.onCharacter(state);
    this.cures.onCharacter(state);
    if (this.mayRest()) this.recovery.onCharacter(state);
  }

  /**
   * A glyph for a line that names a place: a bank's name gets a bank.
   *
   * Only a room's name line, and only when every room bearing that name is the
   * same kind of place — `placeNamed` refuses otherwise, because a glyph is a
   * claim and the name line arrives before the room resolves. Off entirely
   * when the internal file says the console is not to be decorated.
   */
  /** Said once per connection; a second `rm` in the same wrong realm adds nothing. */
  private realmMismatchSaid = false;

  /**
   * The realm said where the character is, and the realm *data* has no such
   * room: the wrong map is loaded for this server.
   *
   * Found by playing: a profile named a Paradigm database while the server
   * ran stock GreaterMUD, `rm` answered `Location: 1,289`, the data had no
   * room 1/289, and every route from there failed with nothing to say why.
   * Said out loud, because "the wrong map" beats "no map" only when it is
   * announced (CLAUDE.md, "A character can name its own realm").
   */
  private noticeRealmMismatch(block: Block): void {
    if (block.type !== 'user-profile' || this.realmMismatchSaid || !this.world) return;
    const map = block.groups['map'];
    const room = block.groups['room'];
    if (map === undefined || room === undefined) return;
    if (this.world.byId(`${map}/${room}`)) return;
    this.realmMismatchSaid = true;
    this.sink.notice(t('session.world.realmMismatch', { map, room }));
  }

  /**
   * What the character has to see by — realm data crossed with the pack.
   *
   * The realm's item table is what says a `glowing pearl` is a light at all
   * (`kind: 'light'`); the `i` listing is what says how many charges are left,
   * and the server treats a spent one as absent — `use glowing pearl` answers
   * `You don't have glowing pearl.` for a pearl reading `(Readied/0)`, measured
   * live 2026-08-27. Neither half answers alone.
   *
   * **A spent light beats a full one** in the answer, because the point of
   * asking is the warning: a character carrying a dead pearl and a live torch
   * is fine, so `carried` wins the moment anything usable is found, and `spent`
   * is only reported when nothing usable was.
   *
   * Nothing is claimed about whether a carried light is *burning*. Nothing on
   * the wire says so.
   */
  private lightSource(state: CharacterState): {
    state: 'spent' | 'carried' | 'none';
    name: string | null;
  } {
    if (!this.world) return { state: 'none', name: null };
    const named = this.world.itemsNamed(state.inventory.items.map((item) => item.name));
    let spent: string | null = null;
    for (const item of state.inventory.items) {
      if (named[item.name]?.kind !== 'light') continue;
      // Charges unstated is not zero: the listing simply did not count, and a
      // warning fired on an unknown would cry wolf on every torch.
      if (item.charges !== 0) return { state: 'carried', name: item.name };
      spent ??= item.name;
    }
    return spent === null ? { state: 'none', name: null } : { state: 'spent', name: spent };
  }

  /** The loops this character's options define, by name. */
  loopNamed(name: string): Loop | undefined {
    return this.automationConfig.loops.find((entry) => entry.name === name);
  }

  /** Every loop this character can run, for the palette. */
  get loopNames(): string[] {
    return this.automationConfig.loops.map((entry) => entry.name);
  }

  /** The palette's view: each loop by name, with how many stops it visits. */
  get loopList(): Array<{ name: string; stops: number }> {
    return this.automationConfig.loops.map((entry) => ({
      name: entry.name,
      stops: entry.stops.length
    }));
  }

  /**
   * A route from where this character is standing to `to`, or the reason
   * there is none.
   *
   * The one statement of what this character costs to move: its level, what
   * it can force or pick, and **the purse**, because a toll gate is priced and
   * a route planned without it walks a penniless character up to one, over and
   * over. `refusedEdges` goes with it, so a corridor the server has already
   * said does not exist is not planned through twice in one session.
   *
   * Shared by the loop's next leg and by a route picking itself back up after
   * a fight, because those two answering the question differently is the
   * "two halves of one gate in two files" failure this codebase keeps
   * relearning — and the purse is exactly the argument it was left out of
   * once already.
   */
  private planFromHere(to: RoomId): Route | string {
    const state = this.tracker.current;
    const here = state.room;
    if (here.map === null || here.number === null) return t('session.loop.unknownRoom');
    return (
      this.world?.route(roomId(here.map, here.number), to, {
        level: state.progress.level ?? null,
        strength: state.progress.strength ?? null,
        pickSkill: state.progress.picklocks ?? undefined,
        wealth: state.inventory.wealth,
        refused: this.refusedEdges
      }) ?? t('session.loop.noRealmData')
    );
  }

  /** Where a loop's stop is, by name and optional coordinates. */
  private findStop(stop: {
    name: string;
    at: { map: number; room: number } | null;
  }): { map: number; room: number } | string {
    if (stop.at) return stop.at;
    const found = this.world?.findByName(stop.name) ?? [];
    if (found.length === 0) return t('session.loop.unknownStopName', { name: stop.name });
    // Thirteen rooms are called Town Gates; a loop that guessed which would
    // walk somewhere the player did not mean.
    if (found.length > 1) {
      return t('session.loop.ambiguousStopName', {
        count: found.length,
        name: stop.name,
        map: found[0]!.map,
        room: found[0]!.room
      });
    }
    return { map: found[0]!.map, room: found[0]!.room };
  }

  /**
   * What the console draws beside a room's name: the glyph for the kind of
   * place it is, and the buttons for what can be done there.
   *
   * Asked on the *name* line, which is before `Obvious exits:` has completed
   * the room and resolved which of the thirteen Town Gates this is — so both
   * halves are answered from the name and both refuse a name whose rooms
   * disagree (`placeNamed`, `exitCommandsNamed`). Guessing here would put a
   * button on screen that sends a command the room does not take, and an
   * unrecognised command on this server is *said out loud* to everybody
   * standing in it.
   *
   * A room with actions and no shop is still worth marking: `go manhole` is a
   * plain room whose only way onward is a command nobody can see. The glyph
   * falls back to `shop` there, because a mark must name an icon and the
   * buttons beside it are already saying what the place offers.
   *
   * **A peeked room gets the glyph and no buttons.** `l n` prints the
   * neighbour in full and nothing in it says the character is not standing
   * there — the settled decision the expectation queue exists for. A glyph
   * against a peeked room is a label and was always tolerable; a *button* is
   * not, because pressing it sends the neighbour's command into the room the
   * character is actually in, and `go manhole` typed where there is no manhole
   * is said out loud to everybody present.
   */
  private markFor(block: Block): TerminalMark | undefined {
    if (!this.internal.terminal.enrich || block.type !== 'room-name') return undefined;
    const name = block.text.trim();
    const place = this.world?.placeNamed(name);
    const kind = place && place.kind !== 'tavern' ? place.kind : undefined;
    /*
     * The vault standing in front of the character, by the name the realm data
     * gives its shop and then by the room's own name — both through `bankKey`,
     * because the bank's header and the realm file need not agree on an
     * article (`The Bank of Godfrey` against `Bank of Godfrey`). A vault that
     * matches neither has not been asked, and offers no withdrawal.
     */
    const banks = this.tracker.current.banks;
    const vault =
      (place?.shop === undefined
        ? undefined
        : banks.find((held) => bankKey(held.name) === bankKey(place.shop))) ??
      banks.find((held) => bankKey(held.name) === bankKey(name));
    const actions = this.tracker.nextRoomIsPeek
      ? []
      : actionsFor(
          kind,
          this.world?.exitCommandsNamed(name) ?? [],
          this.tracker.current.inventory.wealth,
          vault?.copper ?? null
        );
    if (!kind && actions.length === 0) return undefined;
    const mark: TerminalMark = {
      icon: kind ?? 'shop',
      label: place?.shop ?? name
    };
    if (actions.length > 0) mark.actions = actions;
    return mark;
  }

  /**
   * How hurt the character is, as a fraction of maximum, for both safety nets.
   *
   * Unknown is not zero: a maximum that has not arrived yet must never trip a
   * safety net, for the same reason it must never paint a bar red — so an
   * unknown number is `null`, never a fraction that looks dire.
   */
  private healthFraction(state: CharacterState): number | null {
    return state.vitals.hp !== null && state.vitals.hpMax
      ? state.vitals.hp / state.vitals.hpMax
      : null;
  }

  /** The rounded percentage a safety notice reports, e.g. `43%`. */
  private percentText(fraction: number | null): string {
    return `${Math.round((fraction ?? 0) * 100)}%`;
  }

  /**
   * A player opened on this character — MegaMUD's NotifyGang moment, from the
   * evidence the client already reads: `<Name> moves to attack you!` and a
   * player's blow both put the attacker in `attackers` and start the
   * five-minute clock, and `HangUpWatch.observe` is the one place that
   * discriminates a player's blow from a monster's, so it is the one place
   * this is fired from.
   *
   * Both halves are off by default and both are said out loud when they act.
   * The broadcast rides the `combat` band — urgent, and still under the
   * escape: a message must never go out ahead of the way out. The retreat is
   * the pvp block's *own* trigger, whatever `retreat.enabled` says — a PvP
   * opener is not a health threshold — through the same emergency band,
   * coalesced with any other escape, under the same cooldown so a blow per
   * round is one move.
   */
  private onPvpBlow(attacker: string, at: number): void {
    const pvp = this.automationConfig.safety.pvp;
    if (!this.automationConfig.enabled) return;
    const state = this.tracker.current;
    if (state.phase !== 'in-game') return;

    if (pvp.notifyGang) {
      const key = attacker.toLowerCase();
      const said = this.pvpSaid.get(key);
      if (said === undefined || at - said >= PVP_WINDOW_MS) {
        this.pvpSaid.set(key, at);
        /*
         * Off a gang, `bg` has nobody to reach: the server refuses and a
         * record claiming the gang was told would be a claimed action that
         * did not happen. The roster carries this character's own gang on its
         * own `who` row; a row positively showing none is a refusal said out
         * loud and written down. **Unknown still sends** — no row, or a row
         * with nothing read yet, is nobody having said, and withholding a
         * safety broadcast on an unread fact costs more than one refused
         * command.
         */
        const own = state.name
          ? state.online.find((entry) => entry.name.toLowerCase() === state.name?.toLowerCase())
          : undefined;
        if (own !== undefined && (own.gang === null || own.gang.length === 0)) {
          this.sink.notice(t('session.safety.pvpNoGang', { attacker }));
          this.noteSafety({
            at,
            action: 'pvp-alert',
            because: t('session.safety.whyPvp', { attacker }),
            acted: false,
            refused: t('session.safety.pvpNoGangReason')
          });
        } else {
          // Realm-facing words, composed here rather than in the dictionary:
          // this is a line spoken to the gang over the wire, not chrome copy.
          const parts = [`attacked by ${attacker}`];
          if (state.room.name) parts.push(`at ${state.room.name}`);
          const { hp, hpMax } = state.vitals;
          if (hp !== null) parts.push(hpMax !== null ? `[HP=${hp}/${hpMax}]` : `[HP=${hp}]`);
          this.sink.notice(t('session.safety.pvpAlerted', { attacker }));
          this.noteSafety({
            at,
            action: 'pvp-alert',
            because: t('session.safety.whyPvp', { attacker }),
            acted: true
          });
          this.queue.enqueue({
            command: `bg ${parts.join(' ')}`,
            priority: 'combat',
            coalesceKey: 'pvp-gang-alert',
            reason: t('session.safety.pvpAlertReason', { attacker })
          });
        }
      }
    }

    if (pvp.action === 'retreat') {
      const now = Date.now();
      if (now - this.lastAskedToEscape < this.automationConfig.safety.retreat.cooldownMs) return;
      this.lastAskedToEscape = now;
      // The shared escape, so the exit ladder and the configured strategy are
      // honoured here exactly as at the health floor.
      this.escape(state, t('session.safety.whyPvp', { attacker }), now);
    }
  }

  private considerEscape(state: CharacterState): void {
    const safety = this.automationConfig.safety.retreat;
    if (!safety.enabled || !this.automationConfig.enabled) return;
    if (state.phase !== 'in-game') return;
    // Nothing to run from. An escape out of combat is a wasted move that puts
    // the character in a room it did not choose — and it is also the moment the
    // rooms this character ran out of stop being rooms it must not go back to.
    if (!state.inCombat && state.combat.attackers.length === 0) {
      this.ranFrom = [];
      return;
    }

    const now = Date.now();
    if (now - this.lastAskedToEscape < safety.cooldownMs) return;
    /*
     * And not across an outstanding move, which the escape only started having
     * to care about when it became one.
     *
     * `Walker.start` refuses on this fact, `LoopRunner.advance` waits on it and
     * `walkHomeIfDue` waits on it: a route planned while a move is unanswered
     * has that move as its first step and sends it twice. The escape has the
     * same problem in one command — `wayOut` reads `state.room`, and with a
     * step in flight that is the room the character is *leaving*, so the exit
     * it picks is an exit of somewhere else. `cooldownMs` floors at 1,000ms and
     * this realm's movement round measured 1,239ms, so the second attempt lands
     * inside the first's answer by default rather than in a corner.
     *
     * Waited on, not counted: `lastAskedToEscape` is not armed here, so the
     * next status line — which is what the answer arrives with — asks again.
     */
    if (this.tracker.pendingMoves > 0) return;

    const fraction = this.healthFraction(state);
    const hurt = fraction !== null && fraction <= safety.belowHealth;
    const outnumbered =
      safety.whenOutnumbered > 0 && state.combat.attackers.length >= safety.whenOutnumbered;
    if (!hurt && !outnumbered) return;

    this.lastAskedToEscape = now;
    const why = hurt
      ? t('session.safety.whyHealth', { percent: this.percentText(fraction) })
      : t('session.safety.whyAttackers', { count: state.combat.attackers.length });
    this.escape(state, why, now);
  }

  /**
   * Which way out, and how well the client knows it.
   *
   * Four rungs, tried in order, every one of them a **direction** — there is no
   * command for running away on this server family, and the eleven refusals
   * that settled that are written up in `NOT_COMMANDS` (`shared/commands.ts`).
   * The ladder is not configurable because each rung is strictly better than
   * the one under it and nobody would knowingly choose a worse one; what *is*
   * configurable is how far to go afterwards (`RetreatConfig.strategy`).
   *
   * 1. **`retrace`** — the opposite of the last confirmed move, when the
   *    character still stands where it landed. The only rung that names a room
   *    this character was *alive* in moments ago, which is why it is first.
   * 2. **`doubles-back`** — an exit of this room that the realm data says leads
   *    to a room further back along the trail. The same claim one link looser,
   *    and it is what answers a retreat that has already run once: after one
   *    escape the newest step no longer ends here, so rung 1 goes quiet exactly
   *    when a second escape is needed.
   * 3. **`known`** — an exit the realm can place. Somewhere, rather than
   *    somewhere the character has been.
   * 4. **`printed`** — an exit the server listed in the room block and the
   *    realm cannot place. The weakest, and still an exit that certainly
   *    exists, because the server printed it thirty seconds ago.
   *
   * Null is a real refusal and is reported as one: a room that named no compass
   * exit at all, with nothing behind it on the trail. Sending a guess there is
   * how the word `flee` survived four phases — an escape that fails silently is
   * indistinguishable from one that was never configured.
   *
   * **Doors and requirements sort, they do not disqualify.** A `closed gate` is
   * one refusal away from being an exit and every rung below is somewhere the
   * character has never been, so a plain exit is preferred within each rung and
   * a noted one is still taken over nothing. Rung 1 ignores the sort entirely:
   * the character came through that passage, whatever the realm says it wants.
   */
  private wayOut(state: CharacterState): { direction: Direction; how: EscapeRung } | null {
    const here =
      state.room.map !== null && state.room.number !== null
        ? roomId(state.room.map, state.room.number)
        : null;

    /*
     * Every compass exit this room has, plainest first. A text exit
     * (`go manhole`) is deliberately absent: it is not one word, the server
     * answers an unrunnable one by saying it **out loud in the room**, and an
     * escape is the worst moment to announce anything.
     */
    const exits = state.room.exits
      .flatMap((exit) => {
        const direction = asDirection(exit.direction);
        return direction === null ? [] : [{ ...exit, direction }];
      })
      .sort((a, b) => Number(encumbered(a)) - Number(encumbered(b)));

    /** A room this character has just run out of is not a way out of anywhere. */
    const forbidden = new Set(this.ranFrom);

    if (here !== null) {
      const back = this.tracker.wayBackFrom(here);
      if (back !== null && !forbidden.has(back.from)) {
        const way = OPPOSITE[back.direction];
        /*
         * Answered by *any* source that knows this room has that exit — the
         * printed list, or the realm's own row, which is what carries a
         * `Hidden/Searchable` passage the server never prints. Both silent is
         * only a refusal when there is something to be silent about: a dark
         * room prints no exits and places nothing, and there the way the
         * character came in is the single thing it does know.
         */
        const printed = exits.some((exit) => exit.direction === way);
        const known = this.world?.byId(here)?.exits.some((exit) => exit.direction === way) ?? false;
        const saidNothing = exits.length === 0 && this.world?.byId(here) === undefined;
        if (printed || known || saidNothing) return { direction: way, how: 'retrace' };
      }
    }

    /*
     * Everywhere the trail has been, minus where the character is standing. A
     * step contributes both ends: the room it left *and* the room it reached,
     * because a trail two steps old ends somewhere worth going back to just as
     * much as it starts there.
     */
    const behind = new Set<RoomId>();
    for (const step of this.tracker.trail) {
      behind.add(step.from);
      behind.add(step.to);
    }
    if (here !== null) behind.delete(here);
    // Every room run out of is on the trail by construction — the escape's own
    // move put it there — so it has to come back out of the set the same way.
    for (const room of forbidden) behind.delete(room);

    const placed = (exit: (typeof exits)[number]): RoomId | null =>
      exit.targetMap !== null && exit.targetRoom !== null
        ? roomId(exit.targetMap, exit.targetRoom)
        : null;

    /*
     * The bottom three rungs, over the exits that do not lead back into
     * something this character has already run out of. A `printed` exit whose
     * destination is unknown cannot be excluded — nothing says where it goes —
     * which is the honest limit of the weakest rung.
     */
    const away = exits.filter((exit) => {
      const to = placed(exit);
      return to === null || !forbidden.has(to);
    });

    const doublesBack = away.find((exit) => {
      const to = placed(exit);
      return to !== null && behind.has(to);
    });
    if (doublesBack !== undefined) return { direction: doublesBack.direction, how: 'doubles-back' };

    const known = away.find((exit) => placed(exit) !== null);
    if (known !== undefined) return { direction: known.direction, how: 'known' };

    const printed = away[0];
    return printed === undefined ? null : { direction: printed.direction, how: 'printed' };
  }

  /**
   * The escape itself, shared by everything that triggers one — the health and
   * outnumbered thresholds above, and a player opening on this character
   * (`onPvpBlow`). One path, so the configured strategy cannot be honoured by
   * one trigger and silently skipped by another.
   *
   * **It sends a direction or it sends nothing.** `wayOut` above picks which
   * and says how confident it is; `safe-haven` then arms the walk home, which
   * `walkHomeIfDue` takes up once the fight is over and the character is
   * placed — the walker refuses to walk into a fight, so a route can never be
   * the escape itself.
   */
  private escape(state: CharacterState, why: string, now: number): void {
    const safety = this.automationConfig.safety.retreat;
    const here =
      state.room.map !== null && state.room.number !== null
        ? roomId(state.room.map, state.room.number)
        : null;

    const out = this.wayOut(state);
    if (out === null) {
      /*
       * Nothing to send, so nothing is sent, and it says so. This is the whole
       * lesson of the word this replaced: for seventy seconds the client
       * reported *Fleeing: health at 50%* eleven times while sending a command
       * that did nothing, and the notice read exactly as it would have if the
       * escape were working. A refusal is a decision and a decision nobody can
       * read did not happen.
       */
      this.sink.notice(t('session.safety.escapeNoExit', { why }));
      this.noteSafety({
        at: now,
        action: 'retreat',
        because: why,
        acted: false,
        refused: t('session.safety.escapeNoExitReason')
      });
      return;
    }

    /*
     * The room being run out of, so nothing walks back into it while the fight
     * that emptied it is still going. See `ranFrom`.
     */
    if (here !== null && !this.ranFrom.includes(here)) {
      this.ranFrom.push(here);
      if (this.ranFrom.length > tuning().walk.recentSteps) this.ranFrom.shift();
    }
    /*
     * And *now* a move is in flight, which is a different fact from having
     * asked. Everything that keeps a character alive stands down on this one.
     */
    this.lastEscapeSent = now;

    if (safety.strategy === 'safe-haven' && safety.safeHavenRoom.length > 0) {
      this.retreat = { room: safety.safeHavenRoom, armedAt: now, from: here };
    }
    /*
     * **And the loop is held, whichever way out was taken — held, not ended.**
     *
     * The lap must not walk on immediately: it plans its next leg from wherever
     * the character landed, and the room it ran out of is one room away.
     * Measured (`logs/2026-09-02_09-58-25_festus.mudcap.jsonl`): an escape sent
     * `e`, and two seconds after `*Combat Off*` the loop sent `w` — back into
     * the room with the cave worm in it. Three times, 51 HP down to 15, and
     * what ended it was the player typing a direction by hand. Nothing rests
     * while a loop is marching (`mayRest`), so those two seconds were also the
     * whole window in which the character could have sat down, and it never
     * did.
     *
     * That was first answered by **stopping** the loop, and stopping it was
     * wrong: a lap runs until the player stops it, the character dies, or its
     * stops fail wholesale, and running away is none of those. Observed on
     * festus, 2026-09-02 — the escape was right, the rest that followed was
     * right, and then the lap simply never came back, so an unattended
     * character stood in a corridor at full health. `LoopRunner.noteEscaped`
     * holds it instead: out of combat, back above `restTo`, and
     * `tuning.loop.escapeSettleMs` past the escape, and then it walks on. The
     * hold is also what lets `Recovery` sit the character down where it landed
     * — `mayRest` allows a held loop and refuses a marching one.
     *
     * `walkHomeIfDue` no longer stops it either: the same hold covers the haven
     * walk, and the runner waits for that walk to finish (`walking()`) before
     * it plans anything of its own.
     */
    this.loops.noteEscaped();
    /*
     * And the same for a route the player asked for, which now survives the
     * fight it ran from (`Walker.holdForFight`) and would otherwise plan its
     * way onward from where the escape landed — whose shortest path very often
     * begins with the reverse of the move that just got away. The lap's own
     * measurement, applied to the other walk that can outlive a fight.
     */
    this.walker.noteEscaped();

    this.sink.notice(escapeNotice(out.how, out.direction, why));
    this.noteSafety({
      at: now,
      action: 'retreat',
      because: `${why} — ${out.direction} (${out.how})`,
      acted: true
    });
    this.queue.enqueue({
      command: out.direction,
      priority: 'emergency',
      coalesceKey: 'escape',
      reason: t('session.safety.escapeReason', { why })
    });
  }

  /**
   * The second half of `safe-haven`: once out of combat and placed, walk home.
   *
   * Armed by the escape and spent once. The walker plans from wherever the
   * character actually landed rather than from where the escape aimed it — one
   * move can be refused, and a route planned from a room the character is not
   * in is a route into a wall. The loop is already held by the escape itself
   * (`escape`), which is what keeps it from re-planning its leg out of the
   * haven and back into the lair, and the runner will not plan while this walk
   * is running. Every outcome is said: a route, a refusal, or a room that never
   * resolved within `tuning.session.retreatPatienceMs`, which is how long a
   * move and one look take.
   */
  private walkHomeIfDue(state: CharacterState): void {
    const retreat = this.retreat;
    if (retreat === null) return;
    if (state.phase !== 'in-game') {
      this.retreat = null;
      return;
    }
    const now = Date.now();
    if (state.inCombat) {
      if (now - retreat.armedAt > tuning().session.retreatPatienceMs) {
        this.retreat = null;
        this.sink.notice(t('session.safety.retreatGaveUp', { room: retreat.room }));
      }
      return;
    }
    if (state.room.map === null || state.room.number === null) {
      if (now - retreat.armedAt > tuning().session.retreatPatienceMs) {
        this.retreat = null;
        this.sink.notice(t('session.safety.retreatUnplaced', { room: retreat.room }));
      }
      return;
    }
    /*
     * `*Combat Off*` lands before the room the escape moved into does, so at
     * the first out-of-combat state the room on record is still the one the
     * escape was sent from — and a route planned from there is a route from a
     * room the character has left. Wait for the room to change. A move the
     * server refused — a shut door on the only rung that had one — leaves the
     * character where it was with the fight over some other way, so after
     * `tuning.session.retreatSettleMs` the room on record is taken as the
     * truth.
     */
    const here = roomId(state.room.map, state.room.number);
    if (here === retreat.from && now - retreat.armedAt < tuning().session.retreatSettleMs) return;
    /*
     * And not while a move is still unanswered, which since the escape became a
     * **move** is the ordinary case rather than a corner: the `Location:` line
     * the server prints ahead of a room block is a state change, and the room
     * that answers the step out arrives after it. `Walker.start` refuses on
     * exactly this fact — a route planned across an outstanding move has the
     * move already in flight as its first step — so asking it here only to be
     * refused would be the same question asked a beat too early.
     *
     * **Waited on rather than counted.** The refusal below spends `this.retreat`
     * before it reports, so a transient answer of *no* would drop the walk home
     * for good; the room that is already arriving is what makes the answer yes.
     * `LoopRunner.advance` waits on this fact for the same reason. Bounded by
     * the same patience as the two waits above, so a move the server swallowed
     * cannot hold the haven open all evening.
     */
    if (this.tracker.pendingMoves > 0) {
      if (now - retreat.armedAt > tuning().session.retreatPatienceMs) {
        this.retreat = null;
        this.sink.notice(t('session.safety.retreatUnplaced', { room: retreat.room }));
      }
      return;
    }
    this.retreat = null;
    const found = this.findStop(splitStop({ room: retreat.room }));
    if (typeof found === 'string') {
      this.sink.notice(t('session.safety.retreatRefused', { room: retreat.room, reason: found }));
      return;
    }
    const route = this.world?.route(
      roomId(state.room.map, state.room.number),
      roomId(found.map, found.room),
      {
        level: state.progress.level ?? null,
        strength: state.progress.strength ?? null,
        pickSkill: state.progress.picklocks ?? undefined,
        // Retreating through a gate this character cannot pay is not a retreat.
        wealth: state.inventory.wealth,
        refused: this.refusedEdges
      }
    );
    if (route === undefined) {
      this.sink.notice(
        t('session.safety.retreatRefused', {
          room: retreat.room,
          reason: t('session.loop.noRealmData')
        })
      );
      return;
    }
    /*
     * Never held for health: this walk exists *because* the character is hurt,
     * and waiting to be better leaves it bleeding beside the lair it just
     * fled. Nor for a fight, which is the same sentence about the other
     * threshold — a retreat that stood still until the fight was over is a
     * retreat that never happened.
     */
    const refused = this.walker.start(route, state, {
      holdWhenHurt: false,
      resumeAfterFight: false,
      /*
       * Nor picked back up after a lost connection. It exists for a fight,
       * and a socket dropping ends whatever fight there was the way a death
       * does; a walk home resumed through the player's own defaults would
       * hold for health on the way, which is the "bleeding beside the lair"
       * the two options above refuse. The health and the retreat thresholds
       * decide afresh from wherever the character is standing when it is
       * back, which is what they do on every line anyway.
       */
      resumeAfterLoss: false
    });
    if (refused !== null) {
      this.sink.notice(t('session.safety.retreatRefused', { room: retreat.room, reason: refused }));
      return;
    }
    this.sink.notice(
      t('session.safety.retreatPlanned', { room: retreat.room, stepCount: route.steps.length })
    );
    this.noteSafety({
      at: now,
      action: 'retreat',
      because: t('session.safety.retreatBecause', { room: retreat.room }),
      acted: true
    });
  }

  /**
   * A death moves the character, and nothing may go on moving it afterwards.
   *
   * The realm puts a dead character in its area's temple. That is a room
   * nobody chose, several maps from wherever the route, the loop or the
   * retreat was planned — so every one of those is now a plan about a place
   * the character is not, and carrying on with it walks a one-life-lighter
   * character back towards what killed it. **Nothing here is a setting.** The
   * loop is stopped, not unconfigured; auto-combat, resting and the rest are
   * untouched, because standing in a temple deciding to heal is exactly right.
   *
   * Two things go, and they are the two that hold a *destination*:
   *
   * - **A running or paused loop.** Paused as well as running: a pause keeps
   *   the loop's place, and `resume` plans afresh from wherever the character
   *   is — which after this is the temple.
   * - **An armed safe-haven retreat.** It is spent when the fight ends, and a
   *   death *is* the fight ending: without this the next status line plans a
   *   route from the temple to a haven chosen for a fight that is already
   *   over. Said out loud, like every other retreat outcome.
   *
   * The walk is the walker's own to end, on the same block — see its
   * `user-dies` case, which stops on the sentence rather than two lines later
   * on the temple's room block, and cancels every queued movement intent with
   * it. What has already reached the wire cannot be recalled; the queue is
   * where the decision is still revisable.
   */
  private stopGoingAnywhere(): void {
    const retreat = this.retreat;
    if (retreat !== null) {
      this.retreat = null;
      this.sink.notice(t('session.safety.retreatDropped', { room: retreat.room }));
    }
    const status = this.loops.progress.status;
    if (status === 'running' || status === 'paused') {
      this.loops.stop(t('session.loop.stoppedDied'));
    }
    // And an errand: the shop it was walking to is several maps away now.
    this.supplies.abandon(t('session.supplies.abandonedDied'));
    /*
     * And a route still owed from a lost connection — the third holder of a
     * destination, and the one with the narrowest window: dialled back into
     * the lair it was standing in and killed before the entry probe placed
     * it, the character would otherwise be walked out of the temple towards
     * the destination it was heading for before the link went.
     */
    const journey = this.journey;
    if (journey !== null) {
      this.journey = null;
      this.sink.notice(
        t('session.walk.notResumed', {
          destination: journey.name,
          reason: t('session.loop.stoppedDied')
        })
      );
    }
  }

  /**
   * Where a supply's shop is, settled the way a loop's stop is.
   *
   * The room the list states first — six rooms are called General Store and
   * the one the player chose is the one that counts — and the shop's name
   * through `shopPlace` where it states none, refused where the name is in
   * several rooms or none. A resolved room whose realm row holds no shop is
   * refused too: the list may have been written against a different realm.
   */
  private shopRoom(item: SupplyItem): { room: RoomId; name: string } | string {
    const world = this.world;
    if (world === undefined) return t('session.loop.noRealmData');
    if (item.at !== null) {
      const placed = world.get(item.at.map, item.at.room);
      if (placed === undefined || placed.shop === undefined) {
        return t('session.supplies.noShopAt', { map: item.at.map, room: item.at.room });
      }
      const shop = world.shop(placed.shop);
      return { room: roomId(item.at.map, item.at.room), name: shop?.name ?? placed.name };
    }
    if (item.shop.trim().length === 0) return t('session.supplies.noShopNamed');
    const place = world.shopPlace(item.shop);
    if (place === undefined) return t('session.supplies.shopUnplaced', { shop: item.shop });
    if (place.at === 'several') {
      return t('session.supplies.shopAmbiguous', { shop: item.shop, count: place.count });
    }
    return { room: roomId(place.map, place.room), name: item.shop };
  }

  /**
   * Whether an escape is still in flight.
   *
   * The retreat cooldown is the window an attempt has to work in — it is a
   * floor on retrying, not a rate limit — so it is also the window in which
   * starting a fight would undo it. Read from the same two numbers the escape
   * itself uses rather than kept as a second flag, because a flag and a
   * timestamp are two things that can disagree about whether a character is
   * running away.
   */
  private isRetreating(): boolean {
    if (this.lastEscapeSent === 0) return false;
    /*
     * Not gated on `retreat.enabled`, and that is the point of reading the
     * *sent* clock rather than the asked one. `onPvpBlow` runs the escape
     * whatever the switch says — a player opening on this character is not a
     * health threshold — so a character with the retreat switched off and
     * `pvp.action: retreat` on had a real move going out in the `emergency`
     * band while this reported *nothing is running away*, which let auto-combat
     * queue an attack on the same status line and both go out inside the 350ms
     * gap. That is the client running from a room and swinging on the way out,
     * in the one situation where the five-minute window makes it most
     * expensive.
     */
    return Date.now() - this.lastEscapeSent < this.automationConfig.safety.retreat.cooldownMs;
  }

  /**
   * The panic button, and why it mostly refuses to be pressed.
   *
   * Every MegaMUD-era client offers "disconnect when health is low". On this
   * server family an unclean disconnect costs a percentage of **maximum** HP —
   * fatal at low health, and recorded as `DisconnectPenalty` — or drops random
   * items, and the five conditions that make it unclean are precisely the ones
   * that co-occur with wanting to press it. See docs/greatermud/combat.md.
   *
   * So the default is off, and switched on the default is to refuse while the
   * client can see a reason. Refusing is *said out loud* rather than done
   * quietly: somebody who turned this on is relying on it, and a safety feature
   * that silently declines is worse than one that was never offered.
   */
  private considerHangingUp(state: CharacterState): void {
    const safety = this.automationConfig.safety.hangUp;
    if (!safety.enabled || !this.automationConfig.enabled) return;
    if (state.phase !== 'in-game' || !this.client.connected) return;

    const fraction = this.healthFraction(state);
    const hurt = fraction !== null && fraction <= safety.belowHealth;
    const company = safety.onPlayerInRoom && playersHere(state).length > 0;
    if (!hurt && !company) return;

    const why = hurt
      ? t('session.safety.whyHealth', { percent: this.percentText(fraction) })
      : t('session.safety.whyCompany');
    const assessment = this.hangUp.assess(state, Date.now());

    if (safety.onlyWhenClean && !assessment.clean) {
      // Once per reason-set, not once per status line: at low health this runs
      // several times a second and a repeated warning is a warning nobody reads.
      const key = assessment.reasons.join('|');
      if (key !== this.lastHangUpRefusal) {
        this.lastHangUpRefusal = key;
        this.sink.notice(
          t('session.safety.hangUpRefused', { why, reasons: assessment.reasons.join('; ') })
        );
        this.noteSafety({
          at: Date.now(),
          action: 'hang up',
          because: why,
          acted: false,
          refused: assessment.reasons.join('; ')
        });
      }
      return;
    }

    this.lastHangUpRefusal = null;
    this.sink.notice(
      assessment.clean
        ? t('session.safety.hangingUpClean', { why })
        : t('session.safety.hangingUp', { why, reasons: assessment.reasons.join('; ') })
    );
    this.noteSafety({
      at: Date.now(),
      action: 'hang up',
      because: why,
      acted: true,
      ...(assessment.clean
        ? {}
        : {
            refused: t('session.safety.penaltyLikely', { reasons: assessment.reasons.join('; ') })
          })
    });
    // Through the same path the player's own disconnect takes, so the phase,
    // the walker, the queue and the roster are all torn down identically.
    this.disconnect();
  }

  /**
   * Records one safety decision, bounded.
   *
   * Capped like every other log here: this is a diagnostic somebody reads
   * backwards from whatever just happened, and a session that runs all evening
   * must not grow one.
   */
  private noteSafety(decision: SafetyDecision): void {
    this.safetyLog.push(decision);
    if (this.safetyLog.length > tuning().session.safetyLogLimit) this.safetyLog.shift();
    this.publishAutomation();
  }

  /** The decision trace, for a renderer that mounted mid-session. */
  get automation(): AutomationSnapshot {
    return {
      enabled: this.automationConfig.enabled,
      queue: this.queue.snapshot,
      // Newest first: a trace is read backwards from whatever just happened.
      sent: [...this.sentLog].reverse(),
      firings: this.rules.firings.reverse(),
      safety: [...this.safetyLog].reverse(),
      engagements: [...this.engageLog].reverse()
    };
  }

  /**
   * What a command may be written down as.
   *
   * Everything that persists an outbound command goes through here: the session
   * capture, and the decision trace the renderer draws. The command itself
   * still reaches the socket unchanged — this is about the record, not the
   * wire.
   */
  private reportable(command: string): string {
    const isSecret = this.secret.length > 0 && command.trim() === this.secret;
    if (!this.awaitingPassword && !isSecret) return command;
    this.awaitingPassword = false;
    // Fixed width, so the length is not recorded either.
    return '••••••••';
  }

  private recordSent(entry: SentCommand): void {
    this.sentLog.push(entry);
    if (this.sentLog.length > tuning().session.sentLogLimit) this.sentLog.shift();
    this.publishAutomation();
  }

  /**
   * Publishes the trace at most every `tuning.session.automationPublishMs`.
   *
   * Leading edge, so the first change after a quiet spell is immediate — a
   * trace you have to wait a beat for is a worse trace — and trailing, so the
   * last change in a burst is not lost.
   */
  private publishAutomation(): void {
    if (!this.sink.automation) return;
    if (this.automationTimer) return;
    this.sink.automation(this.automation);
    this.automationTimer = setTimeout(() => {
      this.automationTimer = null;
      this.sink.automation?.(this.automation);
    }, tuning().session.automationPublishMs);
    this.automationTimer.unref?.();
  }

  /**
   * Publishes the character, per change and deliberately *not* coalesced.
   *
   * It was coalesced once, the day the trace was (2026-08-31), and reverted
   * the same day: the renderer derives alerts from **consecutive** states — a
   * vital crossing its threshold, a name joining the roster — and collapsing
   * two states into one erased exactly the transition an alert is. The smoke
   * run caught it: the Party card said somebody was hurt and the Alerts card
   * never heard. The window's own flush (`chromeFlushMs`) is what bounds the
   * render cost, and it batches *renders* while applying every state in
   * order, which is the half a publisher on this side cannot do.
   */
  private publishCharacter(): void {
    this.sink.character(this.tracker.current);
  }

  /** Applies a partial state update, refreshes negotiation, and publishes. */
  private patch(next: Partial<Omit<ConnectionState, 'negotiated'>>): void {
    this.current = {
      ...this.current,
      ...next,
      negotiated: this.client.negotiated
    };
    this.sink.state(this.current);
  }
}

/**
 * Phases in which a connect attempt should be refused as already in progress.
 *
 * `connected` is deliberately *not* one of them, despite being busy: dialling
 * while connected is how you switch servers, and the palette offers exactly
 * that. What must be refused is a second attempt arriving while the first is
 * still in flight — `connect` tears down whatever is open before it dials, so
 * that would kill a connection seconds from succeeding.
 */
export const BUSY_PHASES: ReadonlySet<ConnectionPhase> = new Set([
  'resolving',
  'connecting',
  'negotiating'
]);

/**
 * The command a status line echoed after its colon, or null for a bare prompt.
 *
 * `[HP=334/KAI=0]:med` is the server's own statement of what it is about to
 * answer. Read off the plain text past the prompt pattern's match, so a
 * `(Resting)` flag the pattern already consumed is never mistaken for a word
 * somebody typed.
 */
export function echoedCommand(plain: string): string | null {
  const match = STATUS_LINE.exec(plain);
  if (!match) return null;
  const echo = plain.slice(match[0].length).trim();
  return echo.length > 0 ? echo : null;
}
