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
import { AutoStealth } from '../automation/AutoStealth';
import { GearRecovery } from '../automation/GearRecovery';
import { StatScreen } from '../automation/StatScreen';
import { RestAway } from '../automation/RestAway';
import { AutoKeys, type KeyedWay } from '../automation/AutoKeys';
import { Supplies } from '../automation/Supplies';
import { Remotes } from '../automation/Remotes';
import { Afk } from '../automation/Afk';
import type { RemoteName } from '../../shared/remotes';
import { AutoHeal } from '../automation/AutoHeal';
import { AutoInvoke } from '../automation/AutoInvoke';
import { Blessings } from '../automation/Blessings';
import { Cures } from '../automation/Cures';
import { Potions } from '../automation/Potions';
import { LoopRunner } from '../automation/LoopRunner';
import type { LoopProgress } from '../../shared/loops';
import { movementOf, type Movement, type MovementStart } from '../../shared/movement';
import { Events } from '../automation/Events';
import type { Loop } from '../../shared/loops';
import { splitStop } from '../../shared/loops';
import {
  OPPOSITE,
  asDirection,
  hazardAvoided,
  parseLair,
  roomId,
  type WorldRoom,
  type Direction,
  type RoomId,
  type Route,
  type WorldSpell
} from '../../shared/world';
import { actionsFor } from './actions';
import { CharacterTracker } from '../parse/CharacterTracker';
import { Classifier } from '../parse/Classifier';
import { LineTokenizer, plainText, stripAnsi } from '../net/LineTokenizer';
import { TelnetClient } from '../net/TelnetClient';
import { LinkWatch } from './LinkWatch';
import { isPrompt, type Block } from '../../shared/blocks';
import {
  bankKey,
  ownAlignment,
  type CharacterState,
  type RealmFamily as RealmWord,
  type SessionPhase
} from '../../shared/character';
import { wireItem } from '../../shared/entities';
import type { Traveller, WorldGraph } from '../world/WorldGraph';
import type { Wearer } from '../../shared/gear';
import { preferredEdges } from '../world/loopDraft';

/** No preferred corridors: one value, so a session with none re-renders nothing. */
const NO_EDGES: ReadonlySet<string> = new Set();
import { NO_LORE, type MobLore } from '../../shared/lore';
import { NO_SPELL_LORE, type SpellLore } from '../../shared/spell-messages';
import { NO_REALM_PLAYERS, type RealmPlayers } from '../../shared/players';
import { NO_BELONGINGS, type BelongingsSink } from '../../shared/belongings';
import { NO_FIGHTS, type FightSink } from '../../shared/fights';
import { describeDiscovery, discoveryKey, type Discovery } from '../../shared/memory';
import { findKey, type Find } from '../../shared/finds';
import { stepSaid } from '../../shared/quests';
import {
  identityOf,
  resetSignals,
  type CharacterIdentity,
  type ResetSignal
} from '../../shared/reset';
import { DEFAULT_INTERNAL, type InternalConfig } from '../../shared/internal';
import {
  familiesDisagree,
  familyToldBy,
  REALM_FAMILY_LABEL,
  type RealmFamilies,
  type RealmFamily
} from '../../shared/realm';
import { SHIPPED_WORLD_LABEL, worldOfRealm } from '../../shared/worlds';
import {
  commandOf,
  GREATERMUD_ONLY,
  opensStatScreen,
  type CommandName
} from '../../shared/commands';
import { STATUS_LINE } from '../parse/patterns';
import {
  figuresOf,
  isFullStatline,
  statlineMatcher,
  STATLINE_MAX_CELLS,
  withReading
} from '../../shared/statline';
import { toAnsi } from '../../shared/template';
import { promptOpened, TerminalFeed } from './TerminalFeed';
import { Rewriter } from './Rewriter';
import {
  DEFAULT_CONFIG,
  type AutomationConfig,
  type LoginConfig,
  type SupplyItem,
  type RewritesUiConfig
} from '../../shared/config';
import { errorMessage } from '../../shared/values';
import { sameTarget } from '../../shared/types';
import { t } from '../app/i18n';
import type {
  ConnectionEnd,
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
import {
  appraiseRoom,
  EMPTY_ROOM_VERDICT,
  lairPassage,
  prowessSheetOf,
  roomVerdictKey,
  weighVerdicts,
  wieldedWeapon,
  type RoomVerdict,
  type Verdict
} from '../../shared/verdict';
import { LairCosts } from '../world/LairCosts';
import { attacksOnSight } from '../../shared/mobs';
import { regeneration } from '../../shared/prowess';
import {
  compareSpots,
  estimateSpot,
  respawnSeconds,
  type HuntingAdvice,
  type HuntingConstants,
  type HuntingRoom,
  type HuntingSpot,
  type SpotMob
} from '../../shared/hunting';

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

/**
 * Where what a `search` turns up in this realm is written down.
 *
 * The same seam `RealmMemory` is, for the same reason: this is the session
 * layer, it says what was found, and the file handling belongs to whoever
 * decided where the file goes. The implementation is `FindBook`.
 *
 * Realm-keyed rather than character-keyed — a room hiding a rusty key is a fact
 * about the world, like a shop's stock — so one store answers for every
 * character on a realm. It is handed over at construction beside `memory`,
 * which is the record it most resembles and which keys the same way.
 */
export interface RealmFinds {
  /** Writes one down. Returns it only when this room had not held it before. */
  record(find: Omit<Find, 'seen'>): Find | null;
  /** Strikes one out by its `findKey`. Whether there was one to strike. */
  forget(key: string): boolean;
  readonly all: readonly Find[];
}

/** A realm nothing is written down for, which is what every test wants. */
const NO_FINDS: RealmFinds = {
  record: () => null,
  forget: () => false,
  all: []
};

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
   * Everything a `search` has turned up in this realm, after one turned up
   * something. The whole list, for the reason `learned` sends the whole list.
   */
  finds?(finds: Find[]): void;
  /**
   * The character in the realm may not be the character these records are
   * about. Reported, never acted on: see `SessionManager.watchForReset`.
   */
  reset?(notice: {
    signals: ResetSignal[];
    before: CharacterIdentity;
    after: CharacterIdentity;
  }): void;
  /**
   * The rank each quest has been seen to reach from what the player typed.
   * The whole map, for the reason `learned` sends the whole record.
   */
  questSaid?(progress: Record<number, number>): void;
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
  /**
   * The room appraised — every monster's verdict and what clearing the room
   * is expected to cost — on change. The same `Verdict` auto-combat ranks on.
   */
  verdict?(appraisal: RoomVerdict): void;
  /**
   * The realm named its own data — `[MAJORMUD]:`, `[PARADIGM]:` at its menu —
   * once per connection. A hook rather than a store, like `destination`: which
   * bundled world that word chooses for this address next time is written
   * down by whoever decided where the files go (`WorldBook`).
   */
  realmTold?(realm: RealmWord): void;
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
  /**
   * Which lineage's arithmetic *this server* runs, once the wire has said so.
   *
   * A second field beside the realm data's own family rather than a
   * reconciliation of the two, because they are two different facts and the
   * shipped configuration has them disagreeing legitimately: a Paradigm-built
   * world file is the map for a GreaterMUD default realm. Neither may overwrite
   * the other; a disagreement is said out loud and kept.
   *
   * Set once and never revised — the tells are positive statements about what
   * this server has, and a session does not change server mid-connection.
   * Cleared with the rest of the per-connection state on `reset`, because a
   * different realm may be a different family.
   */
  private serverFamily: RealmFamily | null = null;
  /** What the last pushed appraisal drew as, so a status line that moves no figure pushes nothing. */
  private lastVerdictKey = '';
  /** So the disagreement is stated once a session and not once a block. */
  private familyStated = false;
  /** The realm's own word for its data, once the menu has said it. See `noteRealmWord`. */
  private realmTold: RealmWord | null = null;
  /** What each room's lair costs this character, remembered per fitness. See `lairDanger`. */
  private readonly lairCosts = new LairCosts((room) => this.weighLair(room));
  private internal: InternalConfig = DEFAULT_INTERNAL;
  private readonly lineLog: StreamLine[] = [];
  private seq = 0;
  private lineSeq = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  /** When the tail now buffered first looked like a prompt still being written. */
  private promptOpenedAt: number | null = null;
  /**
   * Whether this realm writes its state after the prompt's colon
   * (`[HP=10/40]: (Resting)`). Then the colon is not where a prompt ends, and
   * `tailIsWholePrompt` may not frame one at it.
   */
  private promptTrails = false;
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
   * The escape whose answer has not come: the direction sent, by when, how
   * many times its door has been opened, and every direction tried from this
   * room. A declared postcondition, as `Walker` arms `expecting` — the escape
   * used to be complete the moment the byte left, and `The door is closed!`
   * was recorded as an escape (todo 06, 2026-09-12). See `settleEscape`.
   */
  private escapeAwaiting: {
    direction: Direction;
    how: EscapeRung;
    why: string;
    deadline: number;
    opened: number;
    tried: Set<Direction>;
  } | null = null;
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
   * A route the player asked for that a supply errand went shopping instead of.
   *
   * The errand's own reason for existing is that the character is about to go
   * somewhere, so it takes the character first and hands it back — the same
   * bargain `LoopRunner.noteErrand` strikes with a lap. Kept as the destination
   * rather than the route, because the character is somewhere else by the time
   * it is owed and the way back is planned from where it stands.
   *
   * Dropped by anything that supersedes it: another route asked for, a death
   * (`stopGoingAnywhere`), leaving the realm. Deliberately **not** dropped by
   * `WalkerEvents.destination` as `journey` is — the errand's own legs each
   * fire it, and clearing there would forget the route the moment it was owed.
   */
  private errandOwes: { to: RoomId; name: string } | null = null;
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

  /**
   * Who asked for the hang-up now in flight, latched by `disconnect`.
   *
   * Cleared by every dial, so a `client` left over from last night's
   * low-health hang-up cannot be read as the reason for tomorrow's loss.
   */
  private endedBy: ConnectionEnd | null = null;

  private current: ConnectionState = {
    phase: 'idle',
    target: null,
    connectedAt: null,
    detail: null,
    endedBy: null,
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
  /** Getting back into the shadows between fights. See `AutoStealth`. */
  private readonly stealth: AutoStealth;
  /** Going back for the kit after a death. See `GearRecovery`. */
  private readonly recoverGear: GearRecovery;
  /** Resting next door to a lair rather than in it. See `RestAway`. */
  private readonly restAway: RestAway;
  /** Spending character points on the stat screen. See `StatScreen`. */
  private readonly statScreen: StatScreen;
  /** Bending down for the key to the door in front of you. See `AutoKeys`. */
  private readonly keys: AutoKeys;
  /** Keeping the pack stocked. See `Supplies`. */
  private readonly supplies: Supplies;
  private readonly remotes: Remotes;
  private readonly afk: Afk;
  private readonly heal: AutoHeal;
  private readonly potions: Potions;
  private readonly cures: Cures;
  /** Blessings kept up by events on this character and the party. */
  private readonly blessings: Blessings;
  /** Asking a carried item for the blessing it can cast. See `AutoInvoke`. */
  private readonly invoke: AutoInvoke;
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
   * `@ok` may only resume what `@wait` stopped: a stop the player chose from
   * the Loop card is theirs to end, and a follower's `@ok` walking a
   * hand-stopped loop away would be somebody else's typing moving this
   * character. Cleared the moment the loop is seen in any state but `stopped`,
   * because however the hold ended — resumed here, resumed by hand, started
   * afresh, reset — the claim is spent.
   */
  private pausedForFollowers = false;
  /**
   * Whether the lap was running on the previous progress push.
   *
   * Only so the *edge* is caught: `progress` fires on every step of every leg,
   * and the line about a lap fighting through a switch that is off belongs at
   * the start of the lap, not once a stop.
   */
  private wasLooping = false;
  /**
   * Commands this realm does not have, so automation may not send them.
   *
   * An unrecognised command on this server family is **spoken aloud in the
   * room** rather than refused (docs/game-behaviour.md) — so asking twice is
   * not a wasted command, it is the client broadcasting to everybody standing
   * there, once per ask, for as long as whatever asks keeps asking. One
   * `You say "rm"` used to retire `rm` and nothing else; every other word the
   * realm spoke aloud was asked again on the next tick.
   *
   * Filled from two directions, and both are needed:
   *
   * - **The wire.** Any word the realm's own command table names
   *   (`commandOf`) that comes back as `command-not-understood` is put here.
   *   A word the table does *not* name says nothing and is left alone: a text
   *   exit is room data — `go manhole` is missing from every realm's command
   *   table by construction — and refusing one in this room is not a fact
   *   about the next.
   * - **The lineage.** Once a tell has said the server is MajorMUD, every
   *   `GREATERMUD_ONLY` command is unavailable *without being tried*, which is
   *   the whole point: the first try is the broadcast.
   *
   * Command **names**, so every spelling the server accepts is covered by one
   * entry — the server does no prefix matching and `rm`, `roo` and `room` are
   * one command to it.
   *
   * Per *connection*, cleared by `useRealm` — keyed on the address actually
   * dialled, the same reason the player book is. A character can be dialled at
   * a saved realm other than its own from the palette, so a word retired on a
   * MajorMUD board must not stay retired when the next connection is to
   * GreaterMUD. The cost of not knowing it is the same realm is one refusal
   * per connection, which is what `onEnterRealm` already pays.
   */
  private readonly unavailable = new Set<CommandName>();
  /** The words already spoken about, so a refusal is said once and not per ask. */
  private readonly saidUnavailable = new Set<CommandName>();

  /**
   * The command that asks this realm where the character is standing, or null
   * where the realm has no such word.
   *
   * Derived rather than stored: the fact lives in `unavailable` and two copies
   * of one fact agree until one of them is edited.
   */
  private get locateWord(): string | null {
    return this.unavailable.has('Room') ? null : 'rm';
  }

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
  /**
   * The refused edges that are **shut** rather than absent, and have not yet
   * been given back once.
   *
   * The bound on `unrefuseWhatTheRoomPrints`. `refusedEdges` used to be
   * monotonic and that was its bound; taking entries out again needs a new one
   * or a corridor that both prints and refuses cycles — refused, un-refused on
   * the next room block, replanned, refused — at a route search and a move per
   * turn. `There is no exit in that direction!` has four causes
   * (docs/greatermud/movement.md) and two of them are exits the server may
   * still list, so that is not hypothetical.
   *
   * An entry is deleted when it is given back, so each edge is given back at
   * most once per session: the server printing it is a fact worth one retry,
   * and a way that is refused *again* after the room listed it is one the room
   * is not the authority on.
   */
  private readonly shutEdges = new Set<string>();
  /** The corridors of this character's preferred routes; null until asked, and after the loops change. */
  private preferred: ReadonlySet<string> | null = null;
  /** Stops listening to the realm's player book. See `useRealm`. */
  private forgetPlayers: () => void = () => {};
  private readonly events: Events;
  private readonly routines: Routines;
  /**
   * Whether this session has already asked about a suspected reset.
   *
   * Once, and the remembered identity moves on either way: a prompt that came
   * back on the next status line is a dialog somebody dismisses without
   * reading, which is the same as no dialog at all.
   */
  private askedAboutReset = false;
  /**
   * The rank each quest's counter has been *seen* to reach, from what the
   * player typed. Per session: it is a record of this sitting's actions, and
   * the realm's own count replaces it whenever one arrives.
   */
  private questSaid: Record<number, number> = {};
  /**
   * Whether the far end is still answering. See `LinkWatch`.
   *
   * Owned here rather than by `Reconnect`, which never hears about a socket
   * that stays open: this is the piece that turns a link that died quietly into
   * the `close` event everything downstream already knows what to do with.
   */
  private readonly link: LinkWatch;

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
    players: RealmPlayers = NO_REALM_PLAYERS,
    /**
     * The realm's sentences for an effect landing and ending, shipped and
     * learned. Per realm like the lore beside it, and defaulting to none for
     * the same reason.
     */
    spellLore: SpellLore = NO_SPELL_LORE,
    /**
     * Where what a `search` turns up in this realm is written down.
     *
     * Keyed like `memory`'s shared half: what a room hides is the realm's, not
     * this character's. Last in the list on purpose — every argument above it
     * is passed positionally by the host and by two dozen tests — and
     * defaulting to a realm nothing is written down for, which is what those
     * tests want.
     */
    private readonly finds: RealmFinds = NO_FINDS
  ) {
    this.tracker = new CharacterTracker(
      world,
      lore,
      (discovery) => this.remember(discovery),
      fights,
      players,
      spellLore
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
    this.classifier = new Classifier(
      {
        present: () => this.tracker.current.room.occupants.map((who) => who.name),
        mob: (name) => world?.mob(name)
      },
      // And the spell message table, for the whole-line sentences no frame
      // reads; a lookup because what has been learned changes as the session runs.
      (text) => spellLore.match(text),
      // And how this realm's monsters die, learned the same way (todo 04).
      (text) => lore.deathOf?.(text) ?? null
    );
    this.world = world;
    // A different realm is a different set of corridors; the preferred ones
    // are derived again the next time a route is planned.
    this.preferred = null;
    this.feed = new TerminalFeed(
      {
        isQuiet: (word) =>
          this.internal.terminal.quiet.enabled &&
          this.internal.terminal.quiet.commands.includes(word),
        isStatus: (plain) => STATUS_LINE.test(plain),
        now: () => Date.now(),
        design: (plain) => this.designPrompt(plain),
        // Not while a refusal stands: holding a prompt for a line that will
        // not be drawn is a delay for nothing.
        designing: () => this.rewriter.promptDesign() !== null && !this.designTooWideSaid,
        // The listings the client draws itself, from the batch the classifier
        // assembled and what the tracker had published before it.
        rewrites: (type) => this.rewriter.wants(type),
        rewrite: (block) =>
          this.rewriter.render(block, {
            state: this.tracker.current,
            world: this.world,
            wearer: this.wearerNow()
          })
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
        /*
         * The arbiter's own `train stats` — the stat screen driver's proposal
         * — arms the hold a round trip early exactly as a typed one does
         * below, and for the same reason: the server answers it with no
         * prompt, and the next drain would otherwise send into the form. Safe
         * from inside this callback: one drain sends one command, and the
         * hold empties what it would have scheduled next.
         */
        if (opensStatScreen(command)) this.holdForStatScreen(t('session.stats.asked'));
        this.statScreen.noteSent(command, 'automation');
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
        // A command is on the wire, so an answer is owed and the dead-link
        // clock starts. Beside the idle clock rather than inside it: that one
        // counts what this client has sent, this one counts what the far end
        // has failed to say back.
        this.link.noteSent();
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
      clearTypedLine: () => this.send('\r'),
      unavailable: (command) => this.wordUnavailable(command)
    });

    this.routines = new Routines(automation, this.queue, {
      notice: (message) => this.sink.notice(message)
    });

    this.link = new LinkWatch({
      dead: (seconds) => {
        // Said before the socket goes, so the console reads in the order it
        // happened: this is why the connection dropped, then that it dropped.
        // A safety feature that acts without saying so is one nobody can tell
        // from a bug.
        this.sink.notice(t('session.connection.deadLink', { seconds }));
        // Hung up as a *loss*, not a disconnect: `close` reports `graceful`
        // false, so the loop is held rather than stopped and `Reconnect` dials
        // back if this character asked it to. Whether it does is not decided
        // here.
        this.client.abandon();
      }
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
        this.recoverGear.onWalkEnded(arrived, reason, this.tracker.current);
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
      refused: (from, direction, why) => {
        const edge = `${from}|${direction}`;
        this.refusedEdges.add(edge);
        // Only a way the realm records as *shut* can be opened by somebody
        // walking over and pulling its levers, so only that one is ever given
        // back. See `unrefuseWhatTheRoomPrints`.
        if (why === 'shut') this.shutEdges.add(edge);
        /*
         * **Two sentences, because they are two facts.** `The realm data
         * promised an exit that the realm refuses` is true of a corridor the
         * data invented, and was being said about a `Hidden/Needs 2 Actions`
         * exit — which is the realm data being exactly right and the way being
         * shut. Reported as todo 04 with the room in it (`1/1056`), whose
         * north exit is in the file with both its levers. Either way the edge
         * is avoided for the session; what changes is what the console claims,
         * and one of the two tells the player there is something to go and do.
         */
        this.sink.notice(
          why === 'shut'
            ? t('session.walk.exitShut', { direction })
            : t('session.walk.exitRefused', { direction })
        );
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
      /*
       * What the realm says opens a step the server refused, and where it is
       * pulled. Answered here for `replan`'s reason: it is an index over every
       * room in the realm, and the walker holds a route and a queue and
       * deliberately not the world.
       */
      leversFor: (from, direction) => this.world?.leversFor(from, direction) ?? [],
      /*
       * And a route between two rooms the character is standing in neither of,
       * for the one question `planFromHere` cannot answer: whether a set of
       * levers spread over several rooms can be walked at all. Priced by the
       * same traveller, so the check and the walk cannot disagree.
       */
      routeBetween: (from, to) =>
        this.world?.route(from, to, this.travellerNow(this.tracker.current)) ??
        t('session.loop.noRealmData'),
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
      keyToUse: (keyId) => this.keyToUse(keyId),
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
        // The choice found no book read: the routines ask once (todo 09).
        needBook: () => this.routines.askBook(this.tracker.current),
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
      (name) => this.world?.spellNamed(name) ?? null,
      /*
       * The character's own side of the combat arithmetic, read at the point
       * of use for the reason `realmSpell` above is: `this.world` arrives with
       * `useRealm` and the class is not known until a stat sheet has been read.
       *
       * `serverFamily` and not the realm data's, deliberately: this decides
       * which *formulas* run, and the formulas are the server's. The two can
       * legitimately differ — see `noteFamily` — and on the shipped
       * configuration they do.
       */
      () => this.realmClass()
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
    this.loot = new AutoLoot(
      automation.loot,
      automation.supplies,
      automation.enabled,
      this.queue,
      (name) => (this.world === undefined ? wireItem(name) : this.world.buildItemEntity(name)),
      (message) => this.sink.notice(message)
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
     * The shadows, asked for between fights. Told whether a lap or a route
     * has the character, because the answer is a different command: `sn` for
     * the step ahead, `hide` for standing still.
     */
    this.stealth = new AutoStealth(automation.combat, automation.enabled, this.queue, {
      notice: (message) => this.sink.notice(message),
      escaping: () => this.isRetreating(),
      moving: () => this.walker.walking || this.loops.progress.status === 'running',
      moveInFlight: () => this.tracker.pendingMoves > 0,
      openerRefused: () => this.combat.openerRefused()
    });
    /*
     * And the key to the door in front of the character, which is the other
     * thing a route cannot ask for itself: a keyed edge is pruned before any
     * step exists to be refused at. It reads the pack through the same
     * statement the router does (`packContents`), so the two cannot disagree
     * about whether the key is already held.
     */
    this.keys = new AutoKeys(
      automation.movement,
      automation.enabled,
      this.queue,
      {
        ways: (state) => this.keyedWaysHere(state),
        carried: (state) => this.packContents(state),
        idOf: (name) => this.world?.itemIdNamed(name) ?? null
      },
      {
        notice: (message) => this.sink.notice(message),
        escaping: () => this.isRetreating(),
        /*
         * Standing still, which here means two facts. A move on the wire makes
         * `state.room` the room being *left*, so its floor belongs to
         * somewhere else — the refusal `Walker.start` and `LoopRunner.advance`
         * both make. A walk marching sends its step from the `movement` band,
         * which outranks the `probe` this proposes in, so a `get` behind it is
         * spent in the room after this one.
         */
        busy: () => this.tracker.pendingMoves > 0 || this.walker.walking
      }
    );
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
            asked: false,
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
        looping: () => this.loops.progress.status === 'running',
        hold: () => this.loops.noteErrand(),
        release: () => {
          this.loops.noteErrandOver();
          this.walkOnAfterErrand();
        }
      },
      {
        notice: (message) => this.sink.notice(message),
        decided: (decision) => this.noteSafety(decision)
      }
    );
    /*
     * The kit, after a death: a leg back to where the character died, taking
     * and dressing on arrival. The errand's planner, with the same refusals
     * (a move in flight, a walk running, an escape), and a leg's options:
     * holding when hurt, fighting nothing on the way, owed to nobody across
     * a lost connection.
     */
    this.recoverGear = new GearRecovery(
      automation.movement,
      automation.enabled,
      this.queue,
      {
        here: () => {
          const here = this.tracker.current.room;
          return here.map === null || here.number === null ? null : roomId(here.map, here.number);
        },
        routeTo: (room) => this.planFromHere(room),
        walk: (route) =>
          this.walker.start(route, this.tracker.current, {
            quiet: false,
            asked: false,
            holdWhenHurt: true,
            resumeAfterFight: true,
            whileFighting: false,
            resumeAfterLoss: false
          }),
        moveInFlight: () => this.tracker.pendingMoves > 0,
        walking: () => this.walker.walking,
        busy: () => this.isRetreating() || this.retreat !== null || this.escapeAwaiting !== null
      },
      {
        notice: (message) => this.sink.notice(message),
        decided: (decision) => this.noteSafety(decision)
      }
    );
    /*
     * And where a rest is taken: not in a room that makes monsters on a short
     * clock, when a neighbour the realm holds no lair in can be looked into
     * and found empty. The clock is the realm's own (`Rooms.Delay`, read the
     * way `huntingGrounds` reads it); the neighbours are the room's exits
     * into rooms with no lair and no resident, plain exits first.
     */
    this.restAway = new RestAway(
      automation.health,
      automation.enabled,
      this.queue,
      {
        here: () => {
          const here = this.tracker.current.room;
          return here.map === null || here.number === null ? null : roomId(here.map, here.number);
        },
        lairClock: (room) => {
          const found = this.world?.byId(room);
          if (!found?.lair) return null;
          const { greatermudRespawnOffsetSeconds } = tuning().hunting;
          return respawnSeconds(found.delay ?? null, this.serverFamily, {
            greatermudRespawnOffsetSeconds
          });
        },
        neighbours: (room) => {
          const found = this.world?.byId(room);
          if (!found) return [];
          return found.exits
            .flatMap((exit) => {
              const to = roomId(exit.map, exit.room);
              const next = this.world?.byId(to);
              if (!next || next.lair !== undefined || next.npcId !== undefined) return [];
              const direction = asDirection(exit.direction);
              if (direction === null) return [];
              return [{ direction, to, name: next.name, plain: exit.requirement === null }];
            })
            .sort((a, b) => Number(b.plain) - Number(a.plain))
            .map(({ direction, to, name }) => ({ direction, to, name }));
        },
        moveInFlight: () => this.tracker.pendingMoves > 0,
        walking: () => this.walker.walking && this.walker.holding === null,
        looping: () => this.loops.progress.status === 'running',
        busy: () => this.isRetreating() || this.retreat !== null || this.escapeAwaiting !== null
      },
      {
        notice: (message) => this.sink.notice(message),
        decided: (decision) => this.noteSafety(decision)
      }
    );
    /*
     * And the character points, on the one screen the queue stands down for.
     * The driver is handed a write past the queue because the hold refuses
     * every intent while the form is up, and the form is what it is typing
     * into; its keystrokes are reported as the arbiter's are, so the capture
     * shows them. Whether the room is a trainer's is the resolved room's own
     * shop, as the bank's is below.
     */
    this.statScreen = new StatScreen(
      automation.train,
      automation.enabled,
      this.queue,
      {
        atTrainer: () => {
          const here = this.tracker.current.room;
          if (here.map === null || here.number === null) return false;
          const room = this.world?.byId(roomId(here.map, here.number));
          if (!room || room.shop === undefined) return false;
          return this.world?.shop(room.shop)?.kind === 'trainer';
        },
        write: (bytes) => {
          this.client.send(bytes);
          this.sink.command?.(bytes.replace(/\r?\n$/, ''), 'automation');
        }
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
    this.deposit = new AutoDeposit(
      automation.banking,
      automation.enabled,
      this.queue,
      (state) => {
        if (state.room.map === null || state.room.number === null) return false;
        const here = this.world?.byId(roomId(state.room.map, state.room.number));
        if (!here || here.shop === undefined) return false;
        return this.world?.shop(here.shop)?.kind === 'bank';
      },
      // A press that banks nothing has to say why, or it is indistinguishable
      // from a button that does not work — which is what it was.
      { notice: (message) => this.sink.notice(message) }
    );
    /*
     * The other half of running several characters at once: `@health` answered
     * over a telepath costs no command, where the party roster costs one and
     * gives a percentage. Off unless the options file says otherwise — it is a
     * channel by which somebody else's typing moves this character.
     */
    /*
     * Answering for an absent player: a telepath that arrives after nothing
     * has been typed here for a while is told so. Reads the same keystrokes
     * the queue's hold does, and nothing automation sends.
     */
    this.afk = new Afk(automation.afk, automation.enabled, this.queue, {
      notice: (message) => this.sink.notice(message)
    });
    this.remotes = new Remotes(automation, this.queue, {
      notice: (message) => this.sink.notice(message),
      // What the character is doing, for `@status`, at the moment it is asked.
      progress: () => ({ walk: this.walker.progress, loop: this.loops.progress }),
      /*
       * A follower saying it cannot keep up. The loop is what would walk away
       * from them, so the loop is what stops — and `@ok` is the same follower
       * saying it can again, which resumes it. Stopping keeps the loop and its
       * place, so the resume plans afresh from wherever the character now
       * stands; the leg being walked is ended here too, because the runner
       * never touches the walker.
       */
      pace: (who, ready) => {
        const follower = who.toLowerCase();
        if (!ready) {
          this.waitingFollowers.add(follower);
          if (this.loops.progress.status !== 'running') return;
          /*
           * The lap before the leg, not after: `walker.stop` reports `ended`
           * synchronously, and on a loop still *running* that is a counted
           * failure — "skipping the stop" and a fresh leg planned, for a walk
           * nothing went wrong with. Stopped first, the runner reads the
           * ending as what it is: a leg the stop ended.
           */
          this.loops.stop(t('session.loop.pausedForRemote', { who }));
          this.pausedForFollowers = true;
          this.walker.stop(t('session.loop.pausedForRemote', { who }));
          return;
        }
        this.waitingFollowers.delete(follower);
        if (this.waitingFollowers.size > 0) return;
        if (!this.pausedForFollowers || this.loops.progress.status !== 'stopped') return;
        this.pausedForFollowers = false;
        /*
         * Through `startMoving`, not straight at the runner: this is a second
         * door onto the resume, and the wander check exists precisely because
         * a stop keeps its place while the character does not. A follower's
         * `@ok` is not somebody who can answer a question, so a lap that is
         * now a journey away is **reported and left stopped** — the player
         * presses play, having read how far.
         */
        const answer = this.startMoving(null, null);
        // Said out loud: a loop that quietly failed to walk on is the same
        // stalled evening the resume exists to prevent.
        if ('refused' in answer) this.sink.notice(answer.refused);
        if ('confirm' in answer) {
          this.sink.notice(
            t('session.move.tooFarForRemote', {
              who,
              name: answer.confirm.name,
              stepCount: answer.confirm.steps
            })
          );
        }
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
      blessExpired: (from, spell) => this.blessings.onPeerExpired(from, spell),
      /*
       * Which client another player runs — the fact the extended vocabulary
       * turns on. On the registry with everything else known about them, and
       * published for the same reason `commanded` is: nothing else about this
       * character changed, so it would otherwise wait for something unrelated.
       */
      clientNamed: (from, client, extended) => {
        const facts =
          client === undefined
            ? { extendedRemotes: extended }
            : { client, extendedRemotes: extended };
        if (this.tracker.noteRemoteClient(from, Date.now(), facts)) this.publishCharacter();
      },
      /*
       * `@where-room`'s answer: where a peer is standing, as the realm
       * addresses it. Written to their registry entry as a **sighting**, the
       * same field a room's occupant list writes — the registry keeps a room
       * number and no map, which is the shape it has always had, so the
       * address is reported in full and the number is what is kept.
       */
      placed: (from, map, room, name) => {
        this.sink.notice(
          t('session.remotes.peerPlaced', {
            who: from,
            address: `${map}/${room}`,
            room: name ?? t('session.remotes.peerPlacedUnnamed')
          })
        );
        if (this.tracker.noteRemoteRoom(from, room, name, Date.now())) this.publishCharacter();
      },
      /*
       * `@comeback-room`: walk to the address the sender stated.
       *
       * Through `walkRoute` and not `Walker.start`, so it is one movement at a
       * time like every other door onto a route — a running lap is stopped for
       * it, and the supply errand gets its say. Returns whether a walk really
       * started, which is what decides the `{ok}`.
       */
      comeBack: (from, map, room) => {
        const plan = this.planFromHere(roomId(map, room));
        if (typeof plan === 'string') {
          this.sink.notice(t('session.remotes.comebackRefused', { who: from, reason: plan }));
          return false;
        }
        const refused = this.walkRoute(plan);
        if (refused !== null) {
          this.sink.notice(t('session.remotes.comebackRefused', { who: from, reason: refused }));
          return false;
        }
        this.sink.notice(
          t('session.remotes.comebackWalking', {
            who: from,
            stepCount: plan.steps.length,
            address: `${map}/${room}`
          })
        );
        return true;
      }
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
      realmSpell,
      { notice: (message) => this.sink.notice(message) }
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
    /*
     * And the blessing a carried item can give, which is not a cast at all:
     * the realm names a spell on the item and the server lets an unlimited one
     * be used for ever, so a warrior with the right weapon has a bless for
     * free. See `AutoInvoke`; it reads the realm rather than a configured
     * list, because the realm already states every part of it.
     */
    this.invoke = new AutoInvoke(automation.enabled && automation.spells.invokeItems, this.queue, {
      itemNamed: (name) => this.world?.itemsNamed([name])[name] ?? null,
      spellById: (id) => this.world?.spellById(id) ?? null,
      spellNamed: realmSpell
    });
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
            asked: false,
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
        // Where would earn more, for the low-experience stop (todo 05).
        betterSpot: () => this.betterHuntingWords(),
        notice: (message) => this.sink.notice(message),
        progress: (progress) => {
          // A loop's walk engages: the loop was chosen for what lives on it.
          const running = progress.status === 'running';
          /*
           * And it **fights**, whatever the switch says — todo 03. Said once
           * as the lap starts, because a client that attacks while the
           * toolbar's own switch reads off is two surfaces disagreeing in
           * silence; it is scoped to the loop, so stopping the lap is how you
           * answer it, and nothing is written into the player's own file.
           */
          if (running && !this.wasLooping && this.combat.fightingBecauseLooping) {
            this.sink.notice(t('automation.loops.fightingForTheLap'));
          }
          this.wasLooping = running;
          this.combat.noteLooping(running);
          // However a follower-pause ended — resumed here, resumed by hand,
          // started again — the claim is spent: `@ok` may only resume what
          // `@wait` stopped. `stop()` publishes `stopped`, so setting the flag
          // after the call survives this line.
          if (progress.status !== 'stopped') this.pausedForFollowers = false;
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
      // Whatever was owed has been answered. Every byte counts here, unlike
      // the keep-alive's clock below: this asks whether anything is on the
      // other end of the socket, and an unprompted status-line repaint is as
      // good an answer to that as a reply to a command.
      this.link.noteReceived();
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
      /*
       * A prompt the server has finished writing is framed now, not after
       * the quiet period: it carries the vitals and credits the next queued
       * command, and nothing follows a finished `]:` on the wire but this
       * client's own echo (`mudengine-wire` § Line framing, 2026-09-11).
       */
      if (this.tailIsWholePrompt()) this.flushPending();
      else this.armIdleFlush();
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
      // Nothing is owed across a closed socket, and a deadline left armed
      // would hang up the *next* connection this session opens.
      this.link.reset();
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
      /*
       * Who ended it, for the window. `lost` is already the whole test of
       * whether anybody here asked; what it does not say is *which* of the two
       * here asked, and the latch does. Somebody who typed their way out to the
       * BBS menu arrives ungracefully and is still the player.
       */
      const endedBy: ConnectionEnd = lost ? 'realm' : (this.endedBy ?? 'player');
      this.endedBy = null;
      this.patch({ phase: 'closed', connectedAt: null, detail, endedBy });
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

  /**
   * Writes down what the last search turned up here, and says so once a find.
   *
   * Silent about a repeat, which is what `FindBook.record` returning null buys:
   * a lair searched every lap should not announce the same key every lap. The
   * row still moves — its `at` and its count — because the record changed even
   * though the news did not.
   *
   * A room the client cannot place is **not** written down. A find whose room
   * is a guess is a row nobody can walk back to, and the map cannot mark it;
   * refusing rather than guessing is the standing rule, and the search is still
   * on screen where the player can see it.
   */
  private recordFinds(): void {
    const state = this.tracker.current;
    const { room } = state;
    if (room.map === null || room.number === null) return;
    const where = roomId(room.map, room.number);
    /*
     * The realm's name for the room where the wire has not printed one, and the
     * id where neither has. A row has to read without the database open beside
     * it, and `1/2150` is a worse answer than `Bank of Godfrey` but a far
     * better one than an empty cell.
     */
    const roomName = room.name ?? this.world?.byId(where)?.name ?? where;
    const at = Date.now();
    const fresh: Find[] = [];

    for (const item of room.hidden) {
      const found = this.finds.record({
        room: where,
        roomName,
        name: item.name,
        // Absent is *not one*: the server counts stacks and says nothing about
        // a single thing. See `Find.quantity`.
        quantity: item.count ?? null,
        copper: null,
        at
      });
      if (found) fresh.push(found);
    }

    const cash = room.hiddenCash;
    if (cash !== null) {
      const found = this.finds.record({
        room: where,
        roomName,
        // The server's own phrase where it printed one, so a row reads as the
        // line did: `4 copper farthings`, not a reconstruction of it.
        name: cash.rawText ?? t('session.finds.coins'),
        quantity: null,
        copper: cash.totalCopper,
        at
      });
      if (found) fresh.push(found);
    }

    if (fresh.length === 0) return;
    for (const find of fresh) {
      this.sink.notice(
        t('session.finds.found', { what: find.name, room: find.roomName, id: find.room })
      );
    }
    this.sink.finds?.([...this.finds.all]);
  }

  /**
   * Strikes a find out because the player says it is wrong.
   *
   * The player's call for the reason `forget` above is theirs: the client
   * cannot tell a room it mis-resolved from one that really hides a thing, and
   * a record that cannot be corrected is one that stops being read.
   */
  forgetFind(find: Pick<Find, 'room' | 'name'>): boolean {
    if (!this.finds.forget(findKey(find))) return false;
    this.sink.notice(t('session.finds.forgot', { what: find.name, room: find.room }));
    this.sink.finds?.([...this.finds.all]);
    return true;
  }

  /**
   * A typed line that reaches a quest step, so the book moves as the character
   * plays rather than only when somebody spends an `abil`.
   *
   * Reported 2026-09-07: `ask markus letter` advanced the quest and the card
   * said nothing until an `abil` was typed. Nothing on the wire announces a
   * counter moving — that is the whole reason `abil` exists — so the only fact
   * available at the moment it happens is the **player's own action**, and this
   * is that fact and no more. It never touches `CharacterState.abilities`,
   * which is the realm's own count and stays the realm's: what crosses is a
   * separate reading the card ranks *under* it.
   *
   * The step must name its asker and the line must carry both the asker and one
   * of the words that reach the step — see `stepSaid` for why the pair, and why
   * this does not claim the ask succeeded.
   */
  private noteQuestSaid(command: string): void {
    const quests = this.world?.quests();
    if (quests === undefined || quests.length === 0) return;
    const said = stepSaid(quests, command);
    if (said === null || said.step.to === undefined) return;

    // Only ever forward. A keyword answered again at a later rank must not walk
    // the book backwards, and `giveability` is upward-only on the server too.
    const known = this.questSaid[said.quest.id];
    if (known !== undefined && known >= said.step.to) return;
    this.questSaid = { ...this.questSaid, [said.quest.id]: said.step.to };
    this.sink.questSaid?.(this.questSaid);
  }

  /** What the player has been seen to do about each quest. See `noteQuestSaid`. */
  get questProgress(): Readonly<Record<number, number>> {
    return this.questSaid;
  }

  /** Everything a search has turned up in this realm. See `RealmFinds`. */
  get foundHere(): Find[] {
    return [...this.finds.all];
  }

  async connect(target: ConnectionTarget): Promise<ConnectionState> {
    this.telnetLog.length = 0;
    this.lineLog.length = 0;
    this.lineSeq = 0;
    this.tokenizer.reset();
    this.promptTrails = false;
    this.feed.reset();
    this.promptOpenedAt = null;
    this.classifier.reset();
    this.tracker.reset();
    this.statlineSaid = { reported: null, exact: null };
    this.queue.clear();
    this.sentLog.length = 0;
    this.link.reset();
    this.askedAboutReset = false;
    // A new session's own actions, not the last one's.
    this.questSaid = {};
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
    this.stealth.reset();
    this.recoverGear.reset();
    this.restAway.reset();
    this.statScreen.reset();
    this.keys.reset();
    this.supplies.reset();
    this.remotes.reset();
    this.afk.reset();
    this.heal.reset();
    this.potions.reset();
    this.cures.reset();
    this.blessings.reset();
    this.invoke.reset();
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
      /*
       * **A different realm drops the lap whatever state it is in.** Its stops
       * are room ids in a world this character is no longer in, and its place
       * round them means nothing there.
       *
       * This used to read `if (carried) stop(...)`, which worked while a
       * *stopped* lap was one nothing carried. Since a stop keeps its place
       * (`src/shared/movement.ts`) a stopped lap is carried too, and `stop()`
       * early-returns on one — so the guard neither said anything nor cleared
       * `offline`, `carried` stayed true, and the `reset()` below was skipped:
       * the old realm's lap survived into the new one with the old world's
       * rooms in it, and the card offered play on it.
       */
      if (this.loops.progress.status !== 'idle') {
        this.loops.stop(t('session.loop.stoppedRealmChanged'));
        this.loops.reset();
        this.waitingFollowers.clear();
        this.pausedForFollowers = false;
        this.sink.notice(
          t('automation.loops.stopped', { reason: t('session.loop.stoppedRealmChanged') })
        );
      }
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
    this.shutEdges.clear();
    this.realmMismatchSaid = false;
    this.hangUp.reset();
    this.pvpSaid.clear();
    this.lastHangUpRefusal = null;
    this.lastAskedToEscape = 0;
    this.lastEscapeSent = 0;
    this.escapeAwaiting = null;
    this.retreat = null;
    this.safetyLog.length = 0;
    this.engageLog.length = 0;
    this.login.reset();
    this.outbound = '';
    this.playerMove = null;
    this.phaseWas = 'unknown';
    this.realmTold = null;
    this.saidWaitingToBePlaced = false;
    this.awaitingPassword = false;
    this.cancelIdleFlush();
    this.endedBy = null;
    this.patch({ phase: 'connecting', target, detail: null, connectedAt: null, endedBy: null });
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

  /**
   * Hang up on purpose, and record who asked.
   *
   * `by` reaches the window as `ConnectionState.endedBy`, because the three
   * ways a connection ends are three different facts to somebody who is not at
   * the keyboard: they pressed Disconnect, the client hung up for them, or the
   * realm went. Only the socket's own `close` knows whether it was graceful,
   * so this latches the answer and the handler reads it.
   */
  disconnect(by: ConnectionEnd = 'player'): ConnectionState {
    if (!this.client.connected) return this.current;
    this.endedBy = by;
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

    /*
     * Whether a whole line went out, rather than a keystroke on the way to
     * one. Only a line arms the dead-link clock: a half-typed one produces no
     * answer at all while the server is doing its own echo, so arming on a
     * keystroke would hang up on somebody who started typing and went to make
     * tea. A bare Enter counts — it is what the keep-alive sends.
     */
    let committed = false;

    // A chunk can carry a whole command and its terminator at once — a paste,
    // or a caller sending `who\r` in one go — so this loops rather than
    // assuming one keystroke per call.
    for (;;) {
      const newline = this.outbound.search(/[\r\n]/);
      if (newline === -1) break;
      const command = this.outbound.slice(0, newline).trim();
      this.outbound = this.outbound.slice(newline + 1).replace(/^\n/, '');
      committed = true;
      /*
       * While the stat screen has the keyboard a committed line is a field's
       * contents, not a command: nothing here is a step, a re-read or a word
       * the classifier should pair an echo with. Ten bare Enters walking that
       * form to SAVE were each filed as a re-read of the room, and each was
       * reported unanswered eight seconds later — nine notices about nothing
       * (live, 2026-09-12, todo 10). The hold is the one fact that says so.
       */
      if (this.queue.holding !== null) {
        // Nothing to observe; the bytes still go out below.
      } else if (command.length > 0) {
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
        /*
         * The earliest moment the client can know the command prompt is about
         * to go away, and it is a whole round trip earlier than the screen
         * itself. That margin is the point: the server answers `train stats`
         * with no prompt at all, so the acknowledgement window the queue paces
         * on is already open and the next drain would send into the form.
         *
         * Armed off what the player *typed*, so it is armed before the bytes
         * this call is about reach the socket. A `train stats` the realm
         * refuses (not at a trainer, wrong case) is answered with a prompt,
         * which releases it — so being wrong here costs one round trip of
         * automation and says so.
         */
        if (opensStatScreen(command)) this.holdForStatScreen(t('session.stats.asked'));
        this.statScreen.noteSent(command, 'user');
        this.noteSent(command, 'user');
        this.noteQuestSaid(command);
        // A person is at the keyboard: the away clock starts over.
        this.afk.noteAttended();
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

    if (committed) this.link.noteSent();
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
    // Entering the realm starts the away clock: a character autoconnected and
    // never touched is away after the timeout like any other.
    if (was !== 'in-game' && state.phase === 'in-game') this.afk.noteAttended();
    this.noteRealmWord(state);
  }

  /**
   * The realm has said which data it runs, and whether this session is
   * walking it.
   *
   * `CharacterState.realm` is the menu prompt's own word, and it is the one
   * place the wire says which of the two bundled worlds this is
   * (`shared/worlds.ts`). Told to the sink once per connection so the address
   * is remembered; and compared with the world this session was built on,
   * because that was chosen before anything was dialled. A disagreement is
   * said once and not resolved here — the world is bound for the session's
   * life — so the sentence says what to do about it. A player's own database
   * names no bundled world and is theirs: nothing is said about it.
   */
  private noteRealmWord(state: CharacterState): void {
    if (state.realm === null || state.realm === this.realmTold) return;
    this.realmTold = state.realm;
    this.sink.realmTold?.(state.realm);
    const wanted = worldOfRealm(state.realm);
    const loaded = this.world?.info.world ?? null;
    if (wanted === null || loaded === null || wanted === loaded) return;
    this.sink.notice(
      t('session.realm.worldDisagrees', {
        realm: SHIPPED_WORLD_LABEL[wanted],
        world: SHIPPED_WORLD_LABEL[loaded]
      })
    );
  }

  /**
   * Picks up what a lost connection left owed, once the character is back.
   *
   * Two things are carried across a loss and nothing else: a running or
   * stopped loop (`LoopRunner.carried`) and the route the player was walking
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
      // only when something will in fact walk on — a stopped lap is carried
      // stopped, and a promise that it walks on is one the client cannot keep.
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
    // realm; one who walked out to the menu has ended it. So is a route a
    // supply errand is shopping on behalf of.
    this.journey = null;
    this.errandOwes = null;

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
    this.stealth.reset();
    this.recoverGear.reset();
    this.restAway.reset();
    this.statScreen.reset();
    this.keys.reset();
    this.supplies.reset();
    this.remotes.reset();
    this.afk.reset();
    this.heal.reset();
    this.potions.reset();
    this.cures.reset();
    this.blessings.reset();
    this.invoke.reset();
    this.events.reset();
    this.hangUp.reset();
    this.pvpSaid.clear();
    this.lastHangUpRefusal = null;
    this.lastAskedToEscape = 0;
    this.lastEscapeSent = 0;
    this.escapeAwaiting = null;
    this.retreat = null;
    /*
     * An edge the realm refused was refused for *this* character — a door it
     * could not open, an exit its class may not use — so the blacklist goes
     * with it rather than costing the next character corridors it can walk.
     */
    this.refusedEdges.clear();
    this.shutEdges.clear();
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
   * The console's `Deposit All`, pressed.
   *
   * Nothing crosses from the renderer but the name of the action: the purse,
   * the realm's word on what is a bank, and the verb the wire has been seen to
   * take all live here, and the figure is not known until the `i` this sends
   * has been answered. `AutoDeposit` owns the whole sequence — see its header
   * for why the old three-command button could not work.
   *
   * The `user` band because a person pressed it: it outranks housekeeping and
   * is not silenced by the automation master switch, which is off for anybody
   * who only wants the button.
   */
  depositAll(): boolean {
    return this.deposit.request(0, 'user', this.tracker.current);
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
    return this.remotes.ask(who, name, this.tracker.current);
  }

  /** The client's own settings — which of its commands are quiet. Hot-reloaded. */
  configureInternal(internal: InternalConfig): void {
    this.internal = internal;
  }

  configure(
    automation: AutomationConfig,
    login: LoginConfig,
    rewrites: RewritesUiConfig = DEFAULT_CONFIG.ui.rewrites
  ): void {
    this.automationConfig = automation;
    this.rewriter.configure(rewrites);
    // A new design gets to be refused once, out loud, if it is too wide. By
    // value: every reload resolves a fresh object for an unchanged file.
    const template = this.rewriter.promptDesign()?.template ?? null;
    if (template !== this.promptTemplate) this.designTooWideSaid = false;
    this.promptTemplate = template;
    // The loops may have changed, and with them the routes this character
    // prefers; derived again the next time a route is planned.
    this.preferred = null;
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
    this.loot.configure(automation.loot, automation.supplies, automation.enabled);
    this.drop.configure(automation.drop, automation.enabled);
    this.search.configure(automation.search, automation.enabled);
    this.deposit.configure(automation.banking, automation.enabled);
    this.light.configure(automation.movement, automation.enabled);
    this.stealth.configure(automation.combat, automation.enabled);
    this.recoverGear.configure(automation.movement, automation.enabled);
    this.restAway.configure(automation.health, automation.enabled);
    this.statScreen.configure(automation.train, automation.enabled);
    this.keys.configure(automation.movement, automation.enabled);
    this.supplies.configure(automation.supplies, automation.enabled);
    this.remotes.configure(automation);
    this.afk.configure(automation.afk, automation.enabled);
    this.heal.configure(automation.spells, automation.enabled);
    this.potions.configure(automation.health, automation.enabled);
    this.cures.configure(automation.spells, automation.enabled);
    this.blessings.configure(automation.spells, automation.enabled);
    this.invoke.configure(automation.enabled && automation.spells.invokeItems);
    this.events.configure(automation.events, automation.enabled);
    this.loops.configure(automation.health, automation.movement, automation.walk);
    this.rules.load(automation.rules);
    this.login.configure(login);
    this.secret = login.password;
  }

  /**
   * The realm said a word out loud, so it does not have it.
   *
   * `You say "<command>"` is this server family's answer to a word its
   * dispatch table has no entry for — speech in the room, seen by everybody
   * standing there — so the fact is worth keeping and worth acting on. It
   * used to be kept for `rm` alone; every other word the realm spoke was
   * asked again on the next tick and said again, out loud, all evening.
   *
   * **Only words the realm's own table names.** `commandOf` is the filter,
   * and it is the whole discrimination: a word the table does not have is
   * either a text exit (`go manhole`, which is room data and is *supposed* to
   * be absent from every command table) or the player's typo, and neither is
   * a fact about this realm's vocabulary. Retiring `go manhole` would take a
   * real way through the realm away from every room that has one.
   *
   * Said once per command and never per ask, because the refusal is a decision
   * somebody who turned a feature on needs to be able to read — and a line per
   * probe is the console talking over the room.
   */
  private noteWordMissing(spoken: string | undefined): void {
    const name = commandOf(spoken ?? '');
    if (name === null || this.unavailable.has(name)) return;
    this.unavailable.add(name);
    this.sayUnavailable(name, spoken ?? name);
  }

  /**
   * `Your command had no effect.` — the MajorMUD lineage's answer to a word it
   * does not have.
   *
   * Measured on `bbs.bearfather.net` 2026-09-05 (majorMUD v1.11p-WG3NT): `rm`
   * at the prompt, that sentence back, privately, twice. It is **not** what
   * docs/game-behaviour.md said MajorMUD does — that document read
   * GreaterMUD's `You say "<command>"` onto the other lineage, and a reading is
   * not a capture. So the whole learned half of `unavailable` was keyed on a
   * sentence the realm this client most needs it for never sends.
   *
   * **Only a `GREATERMUD_ONLY` word, and that limit is the point.** The same
   * sentence answers a word the realm *does* have that did nothing — `med` for
   * a class with no mana, which `Recovery.noteNoEffect` exists for — so it
   * cannot retire an arbitrary command the way `command-not-understood` can.
   * For a command whose absence is what separates the two lineages it is
   * decisive; for anything else it says only that this attempt did nothing.
   *
   * The sentence names nothing, so the command is the status line's own echo
   * (`answering`), which is the slot `Recovery` already reads for exactly this.
   */
  private noteNoEffectMissing(spoken: string | null): void {
    const name = commandOf(spoken ?? '');
    if (name === null || !GREATERMUD_ONLY.has(name)) return;
    if (this.unavailable.has(name)) return;
    this.unavailable.add(name);
    this.sayUnavailable(name, spoken ?? name);
  }

  /**
   * Whether automation may not send this command here — `CommandQueue`'s
   * `unavailable`.
   *
   * Two sources, and the second is the one that saves the broadcast: a word
   * the realm has already spoken aloud, and — once a tell has said this server
   * is MajorMUD — every `GREATERMUD_ONLY` command, refused **before** it is
   * tried. The first try is the broadcast, so a client that has been told
   * which lineage it is talking to must not spend it.
   *
   * A word the realm's table does not name is never refused here. It is a text
   * exit or a typo, and `Walker` and the errand both legitimately send phrases
   * this table has no entry for.
   */
  private wordUnavailable(command: string): boolean {
    const name = commandOf(command);
    if (name === null) return false;
    if (this.unavailable.has(name)) return true;
    if (this.serverFamily !== 'majormud' || !GREATERMUD_ONLY.has(name)) return false;
    this.unavailable.add(name);
    this.sayUnavailable(name, command);
    return true;
  }

  /**
   * Says a word is not available here, once.
   *
   * The locate keeps its own sentence, because it is the one whose absence
   * changes what the client can do rather than merely what it will send: a
   * realm with no `rm` is one where the whole of knowing where the character
   * stands is dead reckoning, and somebody watching a loop needs to be told
   * that rather than left to infer it from a missing command.
   */
  private sayUnavailable(name: CommandName, spoken: string): void {
    if (this.saidUnavailable.has(name)) return;
    this.saidUnavailable.add(name);
    this.sink.notice(
      name === 'Room'
        ? t('session.loop.locateUnavailable', { command: spoken })
        : t('session.realm.commandUnavailable', { command: spoken })
    );
  }

  /**
   * Which lineage this server belongs to, from a block already being read.
   *
   * Free: `exp` and `rm` are both commands the client already sends, and the
   * three tells `familyToldBy` reads are positive statements — *this server
   * has `rm`*, *this server printed a level table* — so nothing is concluded
   * from an absence. See `shared/realm.ts` for why that matters: an `exp`
   * summary with no table yet is not evidence of GreaterMUD, and a fold that
   * counted absences would answer confidently on the first prompt of every
   * session.
   *
   * Said out loud, once, and only when it is **news**: a server whose family
   * matches the realm data's is the ordinary case and needs no sentence. A
   * disagreement does, because it is the shipped configuration today — a
   * Paradigm-built world file is the map for a GreaterMUD default realm — and
   * because everything computed downstream has to pick one of the two. The
   * client does not pick. It says which is which and lets both stand.
   */
  private noteFamily(block: Block, answering: string | null = null): void {
    if (this.serverFamily !== null) return;
    const reading = familyToldBy(block, answering);
    if (reading === null) return;
    this.serverFamily = reading.family;
    if (this.familyStated) return;

    const data = this.world?.info.family ?? null;
    const families: RealmFamilies = { data, server: reading.family };
    if (data === null || !familiesDisagree(families)) return;
    this.familyStated = true;
    this.sink.notice(
      t('session.realm.familyDisagrees', {
        server: REALM_FAMILY_LABEL[reading.family],
        data: REALM_FAMILY_LABEL[data],
        source: this.world?.info.source ?? ''
      })
    );
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
    // A different realm may have the words this one refused. See `unavailable`.
    this.unavailable.clear();
    this.saidUnavailable.clear();
    // And a different realm may be a different family. The tells are cheap and
    // arrive again; carrying the last realm's answer forward would not.
    this.serverFamily = null;
    this.familyStated = false;
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
    this.statScreen.dispose();
    this.routines.dispose();
    this.link.dispose();
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
    }, this.idleFlushDelay());
    // Never the reason a process stays alive.
    this.idleTimer.unref?.();
  }

  /**
   * How long the quiet period is, given what is buffered.
   *
   * A prompt is a line that ends because the server went quiet — but a
   * prompt that has opened its bracket and not closed it has not ended, and
   * the server has not gone quiet, whatever the clock says. The bearfather
   * BBS writes `[HP=40/40,…,S= (Resting)` and then ` ]:` about a tenth of a
   * second later, longer than `IDLE_FLUSH_MS` a quarter of the time, and a
   * flush between the two framed the halves as two lines neither of which
   * read as a status line: the vitals and the resting state on every such
   * prompt were lost. So an opened prompt waits `promptHoldMs` from when it
   * was first seen opening, which is the bound on a prompt the server never
   * finishes, and never less than the ordinary quiet period. A finished
   * prompt is released as it always was.
   */
  private idleFlushDelay(): number {
    const plain = stripAnsi(this.tokenizer.buffered).trimStart();
    if (!promptOpened(plain) || STATUS_LINE.test(plain)) {
      this.promptOpenedAt = null;
      return IDLE_FLUSH_MS;
    }
    const now = Date.now();
    this.promptOpenedAt ??= now;
    return Math.max(IDLE_FLUSH_MS, tuning().session.promptHoldMs - (now - this.promptOpenedAt));
  }

  /**
   * Whether the unterminated tail is a status line the server has finished:
   * the colon closes it and nothing follows. `STATUS_LINE` accepts `]` alone
   * and a state after the colon, and neither of those is a finished prompt.
   */
  private tailIsWholePrompt(): boolean {
    if (this.promptTrails) return false;
    const plain = stripAnsi(this.tokenizer.buffered).trimStart();
    const match = STATUS_LINE.exec(plain);
    return match !== null && match[0].endsWith(':') && match[0].length === plain.trimEnd().length;
  }

  private cancelIdleFlush(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private flushPending(): void {
    this.cancelIdleFlush();
    this.promptOpenedAt = null;
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
    // Whatever was opening has been framed; the next tail is a new one.
    this.promptOpenedAt = null;
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
    const batchWas = this.classifier.batchType;
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
      classified ? this.markFor(classified.block) : undefined,
      classified
        ? {
            block: classified.block,
            batchWas,
            batchNow: this.classifier.batchType,
            ...(classified.batch ? { closed: classified.batch } : {})
          }
        : undefined
    );
    if (!classified) return;
    if (classified.block.type === 'status-line' && !this.promptTrails) {
      this.promptTrails =
        STATUS_LINE.exec(line.plain.trimStart())?.groups?.['stateB'] !== undefined;
    }

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

    /*
     * The telnet field screen, and the way back out of it.
     *
     * Ahead of every module, because none of them may propose anything while
     * it is up and the queue is what stops them. The release is **any** prompt,
     * not the status line alone: `SAVE` comes back through `Player.Enters` to
     * the realm's own prompt and `QUIT` comes back to the character menu, and
     * both mean the same thing — there is a command line again.
     */
    if (block.type === 'user-stats-screen') this.holdForStatScreen(t('session.stats.screen'));
    else if (isPrompt(block.type)) this.releaseStatScreen();
    // The one thing that reads the screen, fed every block: the dump, each
    // keystroke's echo, and the sentence the server prints on SAVE alone.
    this.statScreen.onBlock(block);

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
    if (block.type === 'command-not-understood') this.noteWordMissing(block.groups['message']);

    this.noteFamily(block, this.answering);

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
    // A floor listing the server wrapped arrives as a batch, and the loot
    // reads the floor; without this a pile long enough to wrap — which is the
    // pile worth having — was one the loot was never told about (todo 03).
    if (batch) this.loot.onBlock(batch, this.tracker.current);
    this.light.onBlock(block, this.tracker.current);
    this.supplies.onBlock(block, this.tracker.current);
    this.remotes.onBlock(block, this.tracker.current);
    this.afk.onBlock(block, this.tracker.current);
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
     * Everybody standing in this room, handed to the look routine — which does
     * nothing at all unless `automation.talk.lookAtPlayers` is on.
     *
     * The **whole list**, not one name at a time, and that is the fix for a
     * look going out at somebody who had left minutes earlier: the routine
     * reconciles its queue against it, so a name that is no longer here is
     * dropped rather than owed for ever. A listing is authoritative.
     *
     * Read from the room **after** the block was applied, unlike the roster
     * catch-up above: this wants who is in the room *now*, and the occupant
     * list is what the block just replaced. Players only, and never this
     * character — looking at yourself is a different command with a different
     * answer, and it is not what the setting asks for.
     */
    this.routines.onPlayersHere(
      this.tracker.current.room.occupants
        .filter(
          (occupant) => occupant.kind === 'player' && occupant.name !== this.tracker.current.name
        )
        .map((occupant) => occupant.name)
    );
    // Evidence about whether hanging up would be penalised: who hit whom, and
    // whether they are a player. Fed the roster as it stands *before* this
    // block is applied, which is right — a name arrives in the roster from a
    // listing or a broadcast, never from a blow.
    this.hangUp.observe(block, this.tracker.current.online);
    this.publishAutomation();

    // Both are applied, deliberately not short-circuited: `||` would skip the
    // batch whenever the line that completed it also changed state — and the
    // line that completes a stat sheet is the status line, which always does.
    const roomBefore = this.tracker.current.room;
    const lineChanged = this.tracker.apply(block);
    const batchChanged = batch ? this.tracker.apply(batch, batch.rows) : false;
    // An escape in flight reads what the server said back (todo 06).
    if (this.escapeAwaiting !== null) this.settleEscape(block, roomBefore);
    const changed = lineChanged || batchChanged;
    // The tracker records that a stat sheet would settle a buff ending; the
    // routine is what asks for one. Facts fan out, actions funnel in.
    if (this.tracker.takeSheetRequest()) this.routines.askSheet();
    // Likewise a prompt that stopped fitting what `pro` said the line was.
    if (this.tracker.takeStatlineRequest()) this.routines.askProfile();
    /*
     * A pack listing is the fact a requested deposit is waiting on: it is what
     * restates the purse, and the figure the deposit names is composed from it
     * *here* rather than beside the `i` that asked for it. After `apply`, which
     * is what makes `current` the listing's own figure rather than the one the
     * client believed a moment ago — the whole of the bug this shape replaced.
     */
    if (batch?.type === 'user-inventory') this.deposit.onListing(this.tracker.current);

    /*
     * What the search turned up, written down against the room it was in.
     *
     * **After `apply`**, and that is the whole of why this is here rather than
     * beside `AutoLoot` in the `onBlock` fan-out above: `room.hidden` is set by
     * this very block, so the pre-apply state a module is handed still holds
     * the last room's answer. `CharacterTracker` has already done the parsing
     * — the item's name, its count, the coins normalised into copper — so this
     * reads the fact rather than splitting the line a second time.
     */
    if (block.type === 'room-hidden-items') this.recordFinds();

    /*
     * A prompt is an acknowledgement: the server has finished with the last
     * command and is waiting for input. Acking only on the *in-game* status
     * line meant the login sequence had nothing to ack it at all, so after
     * `window` answers the queue sat on the 3s timeout — the whole reason
     * logging in took four and a half seconds.
     *
     * **A prompt, not the whole `session` domain** (todo 07). The domain also
     * holds `command-echo`, which is the server repeating a command it has
     * not finished with — so every command handed back its own credit, the
     * window never closed, and fifteen went out between two prompts.
     * `GMUDInGameState.Process` queues fifteen and then says *Why don't you
     * slow down for a few seconds?*, which is exactly what the transcript
     * shows. See `isPrompt`.
     */
    if (isPrompt(block.type)) this.queue.notePrompt();
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
    else if (block.type === 'command-no-effect') {
      this.recovery.noteNoEffect(this.answering);
      this.noteNoEffectMissing(this.answering);
    } else if (block.type === 'command-fumbled') {
      /*
       * The server threw the command away before it looked at it — todo 02.
       *
       * Two things follow, and they are separate facts. **No room is coming**
       * for it, so the expectation it queued goes, exactly as a refused
       * `go manhole`'s does; leaving it is how dead reckoning is poisoned.
       * And **the decision that produced it is still the right decision**, so
       * the arbiter puts it back at the head, after the delay the server's own
       * fumble branch imposes.
       *
       * Both read `this.answering` — the status line's echo — because the
       * sentence names nothing, and it is what makes this apply to automation
       * and not to a person: the resend is refused unless the fumbled command
       * is the one the queue itself last sent.
       */
      this.tracker.noteFumbled(this.answering);
      if (this.queue.resendLast(this.answering)) {
        this.sink.notice(t('automation.queue.fumbledResend', { command: this.answering ?? '' }));
      }
    }
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
    const lapsed = this.tracker.expireStaleClaims(Date.now());
    // Several bare re-reads lapsing together are one sentence, not one each.
    const bareReads = lapsed.filter((lost) => !lost.moved && lost.command.length === 0).length;
    for (const lost of lapsed) {
      const seconds = this.staleMoveSeconds;
      /*
       * Five literal keys rather than one composed sentence, because
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
      } else if (lost.command.length > 0) {
        this.sink.notice(t('session.walk.readLapsed', { command: lost.command, seconds }));
      } else if (bareReads === 1) {
        this.sink.notice(t('session.walk.readLapsedUntyped', { seconds }));
      }
    }
    if (bareReads > 1) {
      this.sink.notice(
        t('session.walk.readLapsedSeveral', { count: bareReads, seconds: this.staleMoveSeconds })
      );
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
      this.unrefuseWhatTheRoomPrints(state);
      this.noteStatline(state);
      this.routines.onCharacter(state);
      this.rules.observe({ hangUpClean: this.hangUp.clean(state, Date.now()) });
      this.rules.onState(state);
      this.walker.onCharacter(state);
      this.loops.onCharacter(state);
      // A dark arrival, or a lit room to put the torch out in. Told whether
      // the walker has the character, because a torch is never put out
      // mid-route: the next step may be dark again.
      this.light.onCharacter(state, this.walker.walking);
      // And the key to a way out of this room, off this room's floor.
      this.keys.onCharacter(state);
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
      // And the kit after a death, on the same terms as the errand.
      this.recoverGear.onCharacter(state);
      // And the character points, at a trainer, under the switch.
      this.statScreen.onCharacter(state);
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
        // And the same question asked of the pack rather than the spellbook.
        // After the casts, because a bless this character can cast is the one
        // it configured; this is the one the realm happens to be carrying.
        this.invoke.consider(state);
        // Shedding named junk reads the same maintained pack listing the loot
        // fills, and refuses combat and rest for itself.
        this.drop.onCharacter(state);
        // And the purse's own half of the same list: the coins the player
        // asked to be rid of, read off the listing that states how many.
        this.loot.onCharacter(state);
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
      /*
       * The shadows before the rest: `hide` then `rest` is the order a
       * backstabber wants, since a class with `ShadowHome` keeps its stealth
       * through the rest and every other class has it broken by the `rest`
       * itself. Refuses a fight, a monster, a move in flight and a rest for
       * itself.
       */
      this.stealth.onCharacter(state);
      /*
       * And *where* the rest is taken, before whether (todo 08): a room that
       * makes monsters on a short clock is not a resting place while a
       * neighbour can be looked into and found empty. `took-over` is the rest
       * refused here and the step out in flight; `rest-here` is a lair with no
       * safe neighbour, where the rest goes ahead, said once.
       */
      const away = this.restAway.consider(state, this.recovery.wouldRest(state));
      if (away !== 'took-over' && this.mayRest()) this.restNow(state);
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
    // An escape whose answer has not come is a room the character may still
    // be standing in — the one it just tried to leave (todo 06).
    if (this.escapeAwaiting !== null) return false;
    /*
     * A walk that is *marching* refuses, and a walk that is standing still for
     * health does not — those were one condition until a route learned to wait
     * (`Walker.holdForHealth`, 2026-09-02). Marching and resting undo each
     * other; a held walk is standing still precisely so this can happen, and
     * refusing there would recreate the reported bug from the other side, with
     * the walk waiting for a rest that was waiting for the walk.
     */
    /*
     * And a held walk answers for the loop too: a leg standing still before a
     * trap (`Walker.holdForTrap`, 2026-09-10) is a lap that is not marching,
     * and the loop's own holds cannot see inside a leg — read the loop's
     * clause alone, the leg waited for a rest that this refused, for ever.
     */
    if (this.walker.walking) return this.walker.holding !== null;
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
    const away = this.restAway.consider(state, this.recovery.wouldRest(state));
    if (away !== 'took-over' && this.mayRest()) this.restNow(state);
  }

  /**
   * `Recovery`, told first what the walk is waiting for: a route standing
   * still before a trap names the health it wants (`Walker.restingFor`), and
   * that figure is above the resting floor, so the rest that ends the hold
   * has to be asked for by the module that owns resting.
   */
  private restNow(state: CharacterState): void {
    this.recovery.needAtLeast(this.walker.restingFor);
    this.recovery.onCharacter(state);
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
  /** What `noteStatline` last said about the prompt's shape, so each change is said once. */
  private statlineSaid: { reported: string | null; exact: boolean | null } = {
    reported: null,
    exact: null
  };
  /** The prompt row's template as last configured, so a too-wide refusal is said once per design. */
  private promptTemplate: string | null = null;
  private designTooWideSaid = false;
  /** The prompt row and the listings this player has the client draw itself (`ui.rewrites`). */
  private readonly rewriter = new Rewriter();

  /**
   * Who this character is, in the realm's own row ids — the join `wearerIn`
   * in `client.ts` makes for the pack card, made here for the console's
   * rewritten listing, through the same `WorldGraph` lookups so a Paladin
   * cannot be one class to the card and another to the console.
   */
  private wearerNow(): Wearer {
    const state = this.tracker.current;
    const world = this.world;
    return {
      classId: world && state.className ? world.classId(state.className) : null,
      raceId: world && state.race ? world.raceId(state.race) : null,
      level: state.progress.level,
      strength: state.progress.strength,
      classNames: world?.namedClasses() ?? {},
      raceNames: world?.namedRaces() ?? {}
    };
  }

  /**
   * The client's own status line in the prompt's place.
   *
   * Read from the prompt itself, through the reader the tracker uses, because
   * the tracker has not seen this prompt yet: the feed paints a tail the
   * moment it arrives, ahead of framing. What the prompt does not carry — a
   * maximum under `full`, the level, the room — is the last state's. A line
   * wider than the prompt row is refused and said once per design, since a
   * wrapped prompt leaves its first row behind on every repaint.
   */
  private designPrompt(plain: string): { rendered: string; from: number; to: number } | null {
    if (this.rewriter.promptDesign() === null) return null;
    const from = plain.length - plain.trimStart().length;
    const prompt = this.tracker.readPrompt(plain.slice(from));
    if (!prompt) return null;
    const drawn = this.rewriter.prompt(withReading(figuresOf(this.tracker.current), prompt.read));
    if (!drawn) return null;
    if (drawn.cells > STATLINE_MAX_CELLS) {
      if (!this.designTooWideSaid) {
        this.designTooWideSaid = true;
        this.sink.notice(
          t('session.statline.tooWide', { cells: drawn.cells, max: STATLINE_MAX_CELLS })
        );
      }
      return null;
    }
    return { rendered: toAnsi(drawn.segments), from, to: from + prompt.length };
  }

  /**
   * What the realm said the prompt is, said once per report, and a prompt
   * that stops fitting it, said once per lapse.
   *
   * The report names the pattern the prompt is read by from here on — the
   * exact matcher, or the tolerant pattern for `full` and for a template this
   * client cannot build from — because a silent fallback is the failure the
   * whole feature exists to remove. The first prompt to fit is confirmed once;
   * a prompt that stops fitting is the tracker's cue to ask `pro` again
   * (`takeStatlineRequest`, taken in `onBlock`).
   */
  private noteStatline(state: CharacterState): void {
    const now = state.statline;
    const said = this.statlineSaid;
    if (now.reported !== said.reported && now.reported !== null) {
      if (isFullStatline(now.reported)) this.sink.notice(t('session.statline.full'));
      else if (statlineMatcher(now.reported) === null) {
        this.sink.notice(t('session.statline.loose', { statline: now.reported }));
      } else this.sink.notice(t('session.statline.exact', { statline: now.reported }));
    }
    if (now.exact === true && said.exact === null) {
      this.sink.notice(t('session.statline.verified'));
    } else if (now.exact === false && said.exact !== false) {
      this.sink.notice(t('session.statline.mismatch'));
    }
    this.statlineSaid = now;
  }

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
   * Takes an edge back out of `refusedEdges` the moment the server prints it.
   *
   * `refusedEdges` is a *guess* — the server refused a step, so routes avoid
   * that corridor for the session — and nothing ever took an entry out of it
   * again. That is right for a corridor the realm data invented and wrong for
   * every other reason a step can be refused, of which the reported one is a
   * shut gate: the way opens the moment somebody pulls its levers by hand, and
   * every route went on avoiding it until the character reconnected (todo 04,
   * *"routes will avoid it"*).
   *
   * The room's own `Obvious exits:` line is the authority — the same source
   * `Walker.mustSearchFirst` reads to decide a hidden exit has been found —
   * and a fact printed by the server outranks a guess this client made. So an
   * exit the room lists is not refused, whatever was written down about it.
   *
   * Cheap: it runs only where the room prints something *and* something is
   * refused, which after a healthy session is never.
   */
  private unrefuseWhatTheRoomPrints(state: CharacterState): void {
    if (this.shutEdges.size === 0) return;
    const { map, number } = state.room;
    if (map === null || number === null) return;
    const here = roomId(map, number);
    for (const exit of state.room.exits) {
      const key = `${here}|${exit.direction}`;
      // Spent whether or not the edge was still refused, so the offer is made
      // once per edge per session and cannot become a cycle.
      if (!this.shutEdges.delete(key)) continue;
      if (!this.refusedEdges.delete(key)) continue;
      this.sink.notice(t('session.walk.exitBackOpen', { direction: exit.direction }));
    }
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
      this.world?.route(roomId(here.map, here.number), to, this.travellerNow(state)) ??
      t('session.loop.noRealmData')
    );
  }

  /**
   * What this character costs to move, as the router prices it.
   *
   * One statement, read by every route this session plans — the loop's leg,
   * a route picking itself up after a fight, the way home from a retreat —
   * and by the route panel through main. The stats off the sheet, the purse,
   * the corridors the server refused this session, and the corridors of the
   * routes this character prefers (`preferredEdges`), unless the caller is
   * the builder, whose drafts plan plainly so what is drawn is what the
   * reduction reproduces.
   */
  travellerNow(state: CharacterState, preferring = true): Traveller {
    const pack = this.packContents(state);
    return {
      level: state.progress.level ?? null,
      strength: state.progress.strength ?? null,
      pickSkill: state.progress.picklocks ?? undefined,
      wealth: state.inventory.wealth,
      /*
       * The join between the sheet's word and the realm's row id, made here
       * for the reason every other figure on this object is: one statement,
       * read by the loop's leg, the pick-up after a fight, the way home and
       * main's route panel alike. `wearerIn` in `main/index.ts` makes the same
       * join for what a character may *wear*; both go through
       * `WorldGraph.classId` so a Paladin cannot be one class to a helm and
       * another to a corridor.
       */
      classId: this.world && state.className ? this.world.classId(state.className) : null,
      // The same join one column across, for a race-gated exit.
      raceId: this.world && state.race ? this.world.raceId(state.race) : null,
      /*
       * The one fact here that is not off the stat sheet: the sheet carries no
       * standing, so the roster's own row for this character is the only place
       * it appears. Null for the first seconds of every session, which the
       * router treats as *nobody has said* and never as neutral.
       */
      alignment: ownAlignment(state),
      ...pack,
      refused: this.refusedEdges,
      ...(preferring ? { preferred: this.preferredEdges() } : {}),
      // What waits in each room, against this character as they stand now.
      danger: (room) => this.lairDanger(room, state),
      // And the same figure before the division, for the walker's rest
      // before a trap: a reserve in hit points, not a share of a bar that
      // was read at planning time.
      lairDamage: (room) => this.lairCost(room, state),
      /*
       * And what the room itself does to whoever stands in it — with the pack
       * resolved **once**, here, rather than per call: this runs for every room
       * the A* expands that casts anything, and `packContents` walks the whole
       * listing and normalises every name. `danger` is spared it because
       * `LairCosts` remembers per room; this has nothing to remember, so the
       * one thing it depends on is hoisted instead.
       */
      hazard: (room) => this.roomHazard(room, state, pack.keys)
    };
  }

  /**
   * What a room's own spell is expected to cost this character, as a share of
   * the health it has now (`Traveller.hazard`, todo 01).
   *
   * `lairDanger`'s shape, one column across, and simpler for one reason: the
   * damage is a figure the realm states rather than one this client computes,
   * so there is nothing to remember and no fitness string to invalidate. What
   * varies is the pack — a log raft turns eight hundred and forty-five rooms
   * of the Silver River from a wall into a corridor — and the bar, and both
   * are read at the call.
   */
  private roomHazard(room: WorldRoom, state: CharacterState, carrying?: number[]): number | null {
    if (!this.world) return null;
    const hazard = this.world.hazardOf(room);
    if (hazard === null) return null;
    // Carrying what stops it is not *unknown*, it is *free*: the room costs a
    // plain step, which is what it is for that character.
    if (hazardAvoided(hazard, carrying ?? this.packContents(state).keys)) return null;
    /*
     * **A room that moves you is a wall, exactly as an exit that casts one
     * is** (`edgePenalty`'s `spellEffect === 'relocates'`). The walker's next
     * command goes out from wherever the plan says it is standing, and a room
     * that puts it somewhere the exit table does not name breaks every step
     * after it. 1,557 rooms of the shipped realm cast one. `deadlyShare` and
     * not `wallCost` because this is a *share*, and `dangerPenalty` turns a
     * share at the wall into the wall — one place decides that number.
     */
    if (hazard.relocates === true) return tuning().world.deadlyShare;
    const health = state.vitals.hp ?? state.vitals.hpMax;
    if (health === null || !(health > 0)) return null;
    /*
     * A chain the reader could not follow prices as a *discouragement* rather
     * than as nothing: `graveyard summon` and `fire trigger` end in verbs this
     * client cannot evaluate, and walking such a room for free is exactly what
     * put a route down the Silver River. `unreadHazardShare` is what a step
     * through one is worth as a share of the bar — small, and never zero.
     */
    /*
     * The worse of the two, not one or the other: `unread` means the chain
     * carried on past what this reader could follow, so a spell that does a
     * readable ten and then something unreadable is *at least* the ten. Taking
     * the damage alone would let the unread half read as nothing.
     */
    const read = hazard.damage === undefined ? null : hazard.damage / health;
    // A chain that can put a monster in the room is priced on the same
    // discouragement: what it does is what a lair does, and how much is a
    // number this cannot weigh without knowing what turns up.
    const unread =
      hazard.unread === true || hazard.summons === true ? tuning().world.unreadHazardShare : null;
    if (read === null) return unread;
    return unread === null ? read : Math.max(read, unread);
  }

  /**
   * What a room's lair is expected to cost this character, as a share of
   * maximum health, for the router (`Traveller.danger`, `dangerPenalty`).
   *
   * Todo 13: a route was planned through whatever the shortest corridor held,
   * a boss included, because nothing priced the monsters. The arithmetic is
   * the room appraisal's (`appraiseRoom`), run on the lair's monsters instead
   * of the room's occupants, so the Room card and the router cannot disagree
   * about how hard a monster is. Remembered per room until the character's
   * own figures move — a level gained, a helm put on — which `fitness` says
   * (`LairCosts`). Null where nothing can be weighed, and the router prices
   * null as nothing: an unread sheet must not turn every lair into a wall.
   */
  private lairDanger(room: WorldRoom, state: CharacterState): number | null {
    if (!this.world || !room.lair) return null;
    /*
     * The damage is remembered per room; the share is taken against the
     * health the character has *now*, at every call, because that is the
     * number a pass is measured against — a route planned at a third of the
     * bar has to be three times as careful as one planned at the top of it,
     * and the loop plans every leg afresh. Unread health prices nothing.
     */
    const health = state.vitals.hp ?? state.vitals.hpMax;
    if (health === null || !(health > 0)) return null;
    const damage = this.lairCost(room, state);
    return damage === null ? null : damage / health;
  }

  /** What one pass through a room's lair is expected to take, in hit points, remembered. */
  private lairCost(room: WorldRoom, state: CharacterState): number | null {
    if (!this.world || !room.lair) return null;
    return this.lairCosts.at(this.fitness(state), roomId(room.map, room.room));
  }

  /**
   * The figures a lair's cost depends on, as one string, so a change to any
   * of them drops every remembered room. The sheet, the weapon in hand, the
   * class row, the standing (which decides who attacks on sight) and the
   * server's family; not the pack, the purse nor the health itself, which
   * move every room and change no blow.
   */
  private fitness(state: CharacterState): string {
    const { progress } = state;
    return [
      progress.level,
      ownAlignment(state),
      progress.armourClass,
      progress.damageResist,
      progress.magicRes,
      progress.agility,
      progress.intellect,
      progress.charm,
      progress.strength,
      state.className,
      JSON.stringify(wieldedWeapon(state.inventory.items)),
      this.serverFamily
    ].join('|');
  }

  /**
   * One room's lair, weighed: what one pass through it is expected to take,
   * in hit points. See `lairDanger` for what is remembered and why.
   *
   * Only what attacks on sight counts (`attacksOnSight`, against the
   * character's own standing): a passive monster is walked past, a hostile
   * one gets its round, and one whose disposition nobody has read is priced
   * as hostile — an unknown is never the reassuring answer.
   */
  private weighLair(id: RoomId): number | null {
    const world = this.world;
    if (!world) return null;
    const room = world.byId(id);
    if (!room) return null;
    const lair = world.lair(room);
    if (lair === null || lair.mobs.length === 0) return null;
    const state = this.tracker.current;
    const { combat, magery, family } = this.realmClass();
    /*
     * By the rows the lair names, never by name (todo 01, 2026-09-10): a name
     * folds every row sharing it and takes the worst, and the guard post on
     * the Hillside Path was priced as an 830-HP gnoll scout that swings four
     * times a round when the row it names is the 100-HP one that lands a blow
     * in twenty-five. See `WorldGraph.lairEntities`.
     */
    const entities = world.lairEntities(room);
    if (entities.length === 0) return null;
    const verdicts = weighVerdicts(
      entities,
      this.menacePlayer(state),
      tuning().menace,
      prowessSheetOf(state, { combat, magery }),
      wieldedWeapon(state.inventory.items),
      family
    );
    const standing = ownAlignment(state);
    return lairPassage(verdicts, lair.max, tuning().world.passRounds, (index) =>
      attacksOnSight(entities[index]?.disposition ?? null, standing)
    );
  }

  /**
   * Where this character should hunt, from where it stands (todo 05).
   *
   * Every lair within `radius` steps (`WorldGraph.withinSteps`, a plain sweep,
   * never a route per room) and every placed monster, grouped by what they
   * spawn, each group priced once with the arithmetic the Room card prices a
   * fight with (`weighVerdicts`) and the realm's own clock (`Rooms.Delay`,
   * a resident's `RegenTime`), through `estimateSpot`: kill, rest, walk,
   * wait. The loop a suggestion would walk is the nearest rooms of the group,
   * at most `tuning.hunting.maxLoopRooms`; its length is an estimate from the
   * sweep's distances, said as one. Best first; a deadly spot last; an
   * unknown rate never a high one. Nothing here is a prediction, and every
   * unknown is named on the spot rather than zeroed.
   */
  huntingGrounds(radius: number): HuntingAdvice {
    const state = this.tracker.current;
    const world = this.world;
    // Every figure the model runs on, named here so each has a reader.
    const {
      roundSeconds,
      restTickSeconds,
      passiveTickSeconds,
      killOverheadMs,
      stepMs,
      greatermudRespawnOffsetSeconds,
      backstabMultiplier,
      maxLoopRooms,
      maxSpots,
      betterSpotRadius
    } = tuning().hunting;
    const c: HuntingConstants = {
      roundSeconds,
      restTickSeconds,
      passiveTickSeconds,
      killOverheadMs,
      stepMs,
      greatermudRespawnOffsetSeconds,
      backstabMultiplier,
      maxLoopRooms,
      maxSpots,
      betterSpotRadius
    };
    const { combat, magery, family } = this.realmClass();
    const sheet = prowessSheetOf(state, { combat, magery });
    const regen = regeneration(sheet, null, family);
    const backstab = commandOf(this.automationConfig.combat.opener.trim()) === 'BackStab';
    const assumptions = {
      family,
      hpMax: state.vitals.hpMax,
      restingHealthPerTick: regen?.restingHealth.value ?? null,
      backstab,
      constants: c
    };
    const refused = (refusal: string): HuntingAdvice => ({
      from: null,
      radius,
      spots: [],
      assumptions,
      refusal
    });
    if (!world || world.size === 0) return refused(t('session.hunt.noRealmData'));
    const here = state.room;
    if (here.map === null || here.number === null) return refused(t('session.hunt.unknownRoom'));
    const from = roomId(here.map, here.number);
    const start = world.byId(from);
    if (!start) return refused(t('session.hunt.unknownRoom'));

    /*
     * Grouped by what spawns, not by name: two rooms naming the same rows at
     * the same cap are one hunting ground with two rooms in it, which is
     * what a loop is made of.
     */
    const groups = new Map<
      string,
      { rooms: HuntingRoom[]; sample: WorldRoom; via: 'lair' | 'resident'; spawns: number | null }
    >();
    for (const [id, steps] of world.withinSteps(from, radius)) {
      const room = world.byId(id);
      if (!room) continue;
      let key: string;
      let via: 'lair' | 'resident';
      let spawns: number | null = null;
      if (room.lair) {
        const lair = parseLair(room.lair);
        key = `lair:${lair.max ?? 1}:${[...lair.ids].sort((a, b) => a - b).join(',')}`;
        via = 'lair';
        spawns = lair.max;
      } else if (room.npcId !== undefined) {
        key = `resident:${room.npcId}`;
        via = 'resident';
      } else {
        continue;
      }
      const entry = groups.get(key) ?? { rooms: [], sample: room, via, spawns };
      entry.rooms.push({ id, map: room.map, room: room.room, name: room.name, steps });
      groups.set(key, entry);
    }

    const player = this.menacePlayer(state);
    const weapon = wieldedWeapon(state.inventory.items);
    const spots: HuntingSpot[] = [];
    for (const [key, group] of groups) {
      const entities =
        group.via === 'lair'
          ? world.lairEntities(group.sample)
          : world.residentEntities(group.sample);
      if (entities.length === 0) continue;
      const verdicts = weighVerdicts(entities, player, tuning().menace, sheet, weapon, family);
      const mobs: SpotMob[] = entities.map((entity, index) => ({
        name: entity.name,
        experience: entity.experience ?? null,
        rounds: verdicts[index]?.rounds?.value ?? null,
        perRound: verdicts[index]?.menace?.perRound ?? null
      }));
      const rooms = [...group.rooms].sort((a, b) => a.steps - b.steps);
      // A resident is one room and one clock; a lair is a loop of its rooms.
      const loop = group.via === 'lair' ? rooms.slice(0, c.maxLoopRooms) : rooms.slice(0, 1);
      /*
       * The loop's length, from the sweep's distances: out to the farthest
       * room and back, plus a step between neighbours. A route per leg would
       * be exact and cost the main thread a route per room per group; the
       * card's own *Loop it* plans the real legs.
       */
      const loopSteps =
        loop.length <= 1
          ? 0
          : 2 * (loop[loop.length - 1]!.steps - loop[0]!.steps) + 2 * (loop.length - 1);
      const clock: HuntingSpot['clock'] =
        group.via === 'lair'
          ? group.sample.delay === undefined
            ? null
            : 'delay'
          : (entities[0]?.regenHours ?? null) === null
            ? null
            : 'regenTime';
      const respawn =
        group.via === 'lair'
          ? respawnSeconds(group.sample.delay ?? null, family, c)
          : entities[0]?.regenHours === undefined
            ? null
            : entities[0].regenHours * 3600;
      const estimate = estimateSpot(
        {
          rooms: loop.length,
          spawns: group.spawns,
          mobs,
          respawnSeconds: respawn,
          loopSteps,
          character: {
            hpMax: state.vitals.hpMax,
            restingHealthPerTick: regen?.restingHealth.value ?? null,
            passiveHealthPerTick: regen?.health.value ?? null,
            backstab
          }
        },
        c
      );
      spots.push({
        key,
        mobs,
        clock,
        respawnSeconds: respawn,
        spawns: group.spawns,
        rooms: loop,
        roomCount: rooms.length,
        loopSteps,
        estimate
      });
    }
    spots.sort(compareSpots);
    return {
      from: { id: from, name: start.name },
      radius,
      spots: spots.slice(0, c.maxSpots),
      assumptions,
      refusal: null
    };
  }

  /**
   * The better lair, in a sentence, for the lap that stopped for earning too
   * little — or null when nothing within `tuning.hunting.betterSpotRadius`
   * has a known rate. The stop was already loud; this makes it useful.
   */
  private betterHuntingWords(): string | null {
    const { betterSpotRadius } = tuning().hunting;
    const advice = this.huntingGrounds(betterSpotRadius);
    const best = advice.spots.find((spot) => spot.estimate.expPerHour !== null);
    const first = best?.rooms[0];
    if (!best || !first || best.estimate.expPerHour === null) return null;
    return t('session.hunt.better', {
      mobs: best.mobs.map((mob) => mob.name).join(', '),
      room: `${first.name} ${first.map}/${first.room}`,
      steps: first.steps,
      rate: Math.round(best.estimate.expPerHour).toLocaleString()
    });
  }

  /**
   * What the pack holds, as `Items` row ids, for a keyed door and an item
   * gate — one question the server answers one way, so one field.
   *
   * **Both halves of the listing**, because the server prints them as two:
   * `You are carrying …` and `You have the following keys: bone key.` are
   * separate lines and separate fields, and a keyed door asked only about
   * the first would find no key in a pack that has one.
   *
   * Only the names the realm places, and only where a name resolves to a
   * single row: twenty of the shipped realm's item names are shared, four
   * of them keys, and a pack that guessed which `iron key` it was carrying
   * would open a door on a coin toss. The pack itself is the maintained
   * listing (`replayPack`), so this is as current as the last `i` plus
   * every pick-up since.
   *
   * `packKnown` says whether that list is an answer or a silence. `i` is in
   * the default `onEnterRealm`, so it is true within a second of entering the
   * realm on any ordinary configuration — but the probe list is the player's,
   * and a character told never to ask on the way in must not silently become
   * a character whose every keyed door is a wall.
   *
   * **Its own method because two things ask it** (2026-09-06): the router,
   * through `travellerNow`, and `AutoKeys`, which decides whether to pick a
   * key up off the floor. Those two reading the pack differently is the "two
   * halves of one gate in two files" failure at its worst — the client would
   * bend down for a key it already had, or stand on one it needed.
   */
  /**
   * The name to type for a key this character is actually carrying.
   *
   * Both halves are refusals rather than defaults, and each is the same
   * refusal something else in this file already makes:
   *
   * - **An unlisted pack is not an empty one, and it is not a full one
   *   either.** `packKnown` is the gate the router and `AutoKeys` both read,
   *   and it is what stops a `use` going out on the strength of a pack nobody
   *   has read — the answer would be `Your command had no effect.`, said for
   *   a key the character may well be holding.
   * - **A row the realm cannot name is not typed.** `use  n` is not a
   *   command, and inventing a name for the row would be a guess with a door
   *   on the end of it.
   *
   * The realm's own spelling is what goes out, not the pack listing's: the
   * two agree for a key, and the realm's is the one the row is keyed by.
   */
  private keyToUse(keyId: number): string | null {
    const state = this.tracker.current;
    const pack = this.packContents(state);
    if (!pack.packKnown || !pack.keys.includes(keyId)) return null;
    return this.world?.item(keyId)?.name ?? null;
  }

  private packContents(state: CharacterState): { keys: number[]; packKnown: boolean } {
    return {
      keys: this.world
        ? this.world.itemIdsCarried([
            ...state.inventory.items,
            ...state.inventory.keys.map((name) => ({ name }))
          ])
        : [],
      packKnown: state.inventory.listedAt !== null
    };
  }

  /**
   * What the realm says the exits of the room being stood in demand.
   *
   * The **realm's** exit list rather than the printed one, because that is
   * what the router plans through: it holds hidden exits the server never
   * prints, and a key picked up for a door the client has not found yet is
   * still the key the route will want. An unplaced room has no list, which is
   * the refusal every other realm lookup makes rather than guessing.
   */
  private keyedWaysHere(state: CharacterState): KeyedWay[] {
    const { map, number } = state.room;
    if (!this.world || map === null || number === null) return [];
    const room = this.world.get(map, number);
    if (room === undefined) return [];
    const ways: KeyedWay[] = [];
    for (const exit of room.exits) {
      const requirement = exit.requirement;
      if (requirement === null) continue;
      // Both instructions that name an item, because `edgeBlock` reads both
      // the same way: a `Key:` lock and an `Item:` gate ask *is this thing in
      // the pack*, and one of them bending down and the other not would be
      // one gate answered two ways.
      if (requirement.kind !== 'key' && requirement.kind !== 'item') continue;
      if (requirement.keyId === undefined) continue;
      // The realm's own name for the row travels with it, so `AutoKeys` can
      // tell *this floor holds nothing relevant* from *this floor holds
      // something of that name and the realm has three of them* — and say the
      // second one out loud instead of standing there.
      const named = this.world.item(requirement.keyId)?.name;
      ways.push({
        keyId: requirement.keyId,
        direction: exit.direction,
        ...(named === undefined ? {} : { itemName: named })
      });
    }
    return ways;
  }

  /**
   * The corridors of every route this character prefers, derived once from
   * its loops and kept until the loops or the realm change.
   *
   * Derived here rather than in the graph because a stop is resolved the way
   * a loop's stop is (`findStop`), and a route with a stop the realm cannot
   * settle is said out loud once — a preference that silently prefers
   * nothing is a setting somebody edits and then waits to see work.
   */
  preferredEdges(): ReadonlySet<string> {
    if (this.preferred !== null) return this.preferred;
    if (!this.world) return NO_EDGES;
    const found = preferredEdges(
      this.world,
      this.automationConfig.loops,
      (stop) => {
        const room = this.findStop(stop);
        return typeof room === 'string' ? null : roomId(room.map, room.room);
      },
      this.travellerNow(this.tracker.current, false)
    );
    for (const name of found.unresolved) {
      this.sink.notice(t('session.loop.preferUnresolved', { loopName: name }));
    }
    this.preferred = found.edges;
    return found.edges;
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
    /*
     * MegaMUD's `ManaRun%`: a caster with an empty pool is losing whatever the
     * health bar says. A null maximum — a class with no pool, or a sheet not
     * yet read — is never a low one, the rule every threshold here follows.
     */
    const { mana, manaMax } = state.vitals;
    const manaFraction = mana !== null && manaMax !== null && manaMax > 0 ? mana / manaMax : null;
    const drained =
      safety.belowMana > 0 && manaFraction !== null && manaFraction <= safety.belowMana;
    if (!hurt && !outnumbered && !drained) return;

    this.lastAskedToEscape = now;
    const why = hurt
      ? t('session.safety.whyHealth', { percent: this.percentText(fraction) })
      : drained
        ? t('session.safety.whyMana', { percent: this.percentText(manaFraction) })
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
  private wayOut(
    state: CharacterState,
    tried: ReadonlySet<Direction> = new Set()
  ): { direction: Direction; how: EscapeRung } | null {
    const here =
      state.room.map !== null && state.room.number !== null
        ? roomId(state.room.map, state.room.number)
        : null;

    /*
     * Every compass exit this room has, plainest first. A text exit
     * (`go manhole`) is deliberately absent: it is not one word, the server
     * answers an unrunnable one by saying it **out loud in the room**, and an
     * escape is the worst moment to announce anything. A direction the server
     * has already refused from this room (`tried`) is not an exit either.
     */
    const exits = state.room.exits
      .flatMap((exit) => {
        const direction = asDirection(exit.direction);
        return direction === null || tried.has(direction) ? [] : [{ ...exit, direction }];
      })
      .sort((a, b) => Number(encumbered(a)) - Number(encumbered(b)));

    /** A room this character has just run out of is not a way out of anywhere. */
    const forbidden = new Set(this.ranFrom);

    if (here !== null) {
      const back = this.tracker.wayBackFrom(here);
      if (back !== null && !forbidden.has(back.from) && !tried.has(OPPOSITE[back.direction])) {
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
  private escape(
    state: CharacterState,
    why: string,
    now: number,
    tried: ReadonlySet<Direction> = new Set()
  ): void {
    const safety = this.automationConfig.safety.retreat;
    const here =
      state.room.map !== null && state.room.number !== null
        ? roomId(state.room.map, state.room.number)
        : null;

    const out = this.wayOut(state, tried);
    if (out === null) {
      this.escapeAwaiting = null;
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
    /*
     * **Recorded on the outcome, not the send.** `acted: true` used to be
     * written here, at the moment the byte left — so `The door is closed!`
     * answering it was an escape the trace called successful, the character
     * rested in the lair it believed it had left, and three wererats found
     * it at 2% (todo 06). `settleEscape` writes the decision when the room
     * changes, or when the server refuses, or when nothing answers in time.
     */
    this.escapeAwaiting = {
      direction: out.direction,
      how: out.how,
      why,
      deadline: now + tuning().session.retreatPatienceMs,
      opened: 0,
      tried: new Set([...tried, out.direction])
    };
    this.queue.enqueue({
      command: out.direction,
      priority: 'emergency',
      coalesceKey: 'escape',
      reason: t('session.safety.escapeReason', { why })
    });
  }

  /**
   * What the server said back to the escape, read against the block that
   * just applied — the postcondition `escape` arms.
   *
   * Five answers. A room that is not the one the move was sent from is the
   * escape landing, and the decision is recorded `acted: true` only now. A
   * death is a teleport and not an escape. `direction-failed` naming a
   * barrier is a shut door, and `movement.openDoors` opens it — `open
   * <direction>` then the direction again, both in the `emergency` band,
   * bounded by `openTries`; the walker's own rung, without its bash, which
   * spends rounds the character does not have. Any other refusal drops to the
   * next rung of the ladder **now**, not after `cooldownMs`: a refusal is new
   * information and the ladder is already ranked. `command-refused` (mortally
   * wounded) refuses everything, and the deadline covers an answer that never
   * came. Every branch writes the decision it took.
   */
  private settleEscape(block: Block, before: CharacterState['room']): void {
    const waiting = this.escapeAwaiting;
    if (waiting === null) return;
    const now = Date.now();
    const state = this.tracker.current;
    const decision = `${waiting.why} — ${waiting.direction} (${waiting.how})`;
    const settle = (acted: boolean, refused?: string): void => {
      this.escapeAwaiting = null;
      this.noteSafety({
        at: now,
        action: 'retreat',
        because: decision,
        acted,
        ...(refused === undefined ? {} : { refused })
      });
    };

    if (block.type === 'user-dies') {
      settle(false, t('session.safety.escapeKilled'));
      return;
    }
    const moved =
      state.room.name !== before.name ||
      state.room.map !== before.map ||
      state.room.number !== before.number;
    if (moved && state.room.name !== null) {
      settle(true);
      return;
    }
    if (block.type === 'direction-failed') {
      const barrier = block.groups['barrier'];
      const doors = this.automationConfig.movement;
      if (barrier !== undefined && doors.openDoors && waiting.opened < doors.openTries) {
        waiting.opened += 1;
        waiting.deadline = now + tuning().session.retreatPatienceMs;
        this.lastEscapeSent = now;
        this.sink.notice(
          t('session.safety.escapeOpening', { barrier, direction: waiting.direction })
        );
        this.queue.enqueue({
          command: `open ${waiting.direction}`,
          priority: 'emergency',
          coalesceKey: 'escape:open',
          reason: t('session.safety.escapeReason', { why: waiting.why })
        });
        this.queue.enqueue({
          command: waiting.direction,
          priority: 'emergency',
          coalesceKey: 'escape',
          reason: t('session.safety.escapeReason', { why: waiting.why })
        });
        return;
      }
      const tried = waiting.tried;
      settle(false, block.text);
      // The next rung, now: the refusal is the new information the ladder was
      // waiting for, and `cooldownMs` exists to stop a spam of moves, not this.
      this.escape(state, waiting.why, now, tried);
      return;
    }
    if (block.type === 'command-refused') {
      settle(false, block.text);
      return;
    }
    if (now > waiting.deadline) settle(false, t('session.safety.escapeUnanswered'));
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
    // Priced as every other route is — retreating through a gate this
    // character cannot pay is not a retreat.
    const route = this.world?.route(
      roomId(state.room.map, state.room.number),
      roomId(found.map, found.room),
      this.travellerNow(state)
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
      // Announced — running away is exactly the thing that has to be said out
      // loud — and still nothing the player asked for.
      asked: false,
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
   * - **A running loop.** Stopped rather than forgotten, like every other
   *   stop: it keeps its place, and pressing play plans afresh from wherever
   *   the character is — which after this is the temple, and far enough from
   *   the lap that `startMoving` asks before walking it back.
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
  /**
   * A route the player asked for, with the supply list consulted first.
   *
   * The one path a person's own route takes (`Invoke.walkRoute`), and the
   * second of the two moments a supply errand may start — the first being a
   * running lap. Being about to travel is the whole reason the pack matters,
   * so the check happens here rather than on every status line: a character
   * standing still, freshly killed and stripped in the temple, is not about to
   * travel and has no business being walked to a shop.
   *
   * The errand takes precedence and the route is owed back, so the order is
   * shop, then go. Nothing is queued twice: the errand's walk is already out
   * by the time this returns, and the route is planned afresh from the shop
   * when the errand lets go (`walkOnAfterErrand`).
   */
  walkRoute(route: Route): string | null {
    /*
     * **One movement at a time.** A character is routing, looping or stopped
     * (`src/shared/movement.ts`), and a route asked for while a lap runs used
     * to start both: `Walker.start` supersedes the leg silently — it
     * deliberately raises no `ended` — so the lap sat waiting for a leg that
     * was never coming, then read the *route's* arrival as its own leg
     * landing and planned its next stop from wherever the player had gone.
     *
     * A **stopped** lap is left exactly where it is. It is the longer-lived of
     * the two memories and nothing about walking somewhere means giving it up:
     * stopping a lap to walk to a shop and pressing play on arrival is the
     * whole point of a stop being a pause.
     */
    if (this.loops.progress.status === 'running') {
      this.loops.stop(t('session.loop.stoppedForRoute'));
    }
    this.errandOwes = null;
    const errand = this.supplies.considerBeforeRoute(this.tracker.current);
    if (errand === null) return this.walker.start(route, this.tracker.current);
    const last = route.steps.at(-1);
    if (last !== undefined) this.errandOwes = { to: last.to, name: last.name };
    this.sink.notice(
      t('session.supplies.beforeRoute', {
        item: errand.item.name,
        shop: errand.shopName,
        destination: last?.name ?? t('session.supplies.beforeRouteNowhere')
      })
    );
    return null;
  }

  /** What this character is doing about going anywhere. See `movementOf`. */
  get movement(): Movement {
    return movementOf(this.walker.progress, this.loops.progress);
  }

  /**
   * Stop moving — the one stop, whichever of the two is running.
   *
   * There were three (`walk:stop`, `loop:stop`, `loop:pause`) and the player
   * had to know which of them applied before pressing one. They do not: a
   * character is routing, looping or stopped, and *stop* means the same thing
   * in all three sentences. See `src/shared/movement.ts`.
   *
   * **The lap first, then its leg.** `Walker.stop` reports `ended`
   * synchronously, and on a lap still running that is read as a stop the
   * client could not reach — a counted failure, and a fresh leg planned for a
   * walk nothing went wrong with. Stopped first, the runner reads the ending
   * as what it is.
   *
   * Nothing is forgotten either way: the lap keeps its place and the walker
   * keeps its route, which is what `startMoving` picks back up.
   */
  stopMoving(): void {
    const reason = t('session.walk.stoppedByPlayer');
    if (this.loops.progress.status === 'running') this.loops.stop(reason);
    this.walker.stop(reason);
  }

  /**
   * Start moving: begin the named loop, or pick back up whatever was stopped.
   *
   * `loopName` is what the card's picker says, and it is only ever a *start*:
   * naming the lap that is already stopped means resume it where it is, which
   * is why the name is compared rather than obeyed. **Null is the picker's
   * resume entry** — *whatever is stopped*, named by main rather than by the
   * window, so the two can never disagree about which of the pair it was.
   *
   * **The wander check is the reason this returns a union rather than a
   * refusal string.** A stop is a pause, so the character may have been walked
   * — or killed and reborn in a temple on another map — a long way from
   * whatever it was walking, and picking it back up would send it on a journey
   * across the realm that nobody asked for. Past
   * `tuning.walk.resumeAskSteps` the window asks first and presses play again
   * with `confirmed`.
   *
   * The figure the two kinds measure is deliberately **not** the same, because
   * the question is not:
   *
   * - A **route** already knows how far it had left when it stopped, so what
   *   is asked about is the *difference* — how much further away the character
   *   is now than it was. Walking on down a route you were already walking
   *   asks nothing however long the route is.
   * - A **lap** has no such figure: a leg is short by construction, so the
   *   distance to the stop it is heading for **is** how far off the lap the
   *   character has got.
   */
  startMoving(loopName: string | null, confirmed: number | null): MovementStart {
    const state = this.tracker.current;
    const movement = this.movement;
    if (movement.moving) return { refused: t('session.move.alreadyMoving') };

    const loop = this.loops.progress;
    // A name that is not the lap already stopped is a different lap, and
    // starting one is not resuming anything: it chooses its own nearest stop.
    if (loopName !== null && loopName !== loop.name) {
      const chosen = this.loopNamed(loopName);
      if (chosen === undefined) {
        return { refused: t('session.move.noSuchLoop', { name: loopName }) };
      }
      return this.startLoop(chosen);
    }

    /*
     * Which of the two is picked back up is `movementOf`'s to say and not this
     * method's, so the card cannot draw one and play the other: the face on
     * screen and the thing play moves are the same reading of the same two
     * progresses.
     */
    if (movement.kind === 'loop') return this.resumeLoop(state, confirmed);
    if (movement.kind === 'route' && movement.resumable) return this.resumeRoute(confirmed);
    return { refused: t('session.move.nothingToResume') };
  }

  /**
   * A lap the player asked for, from the palette, the shelf or the card.
   *
   * **One movement at a time**: a lap starting takes the character off
   * whatever route it was walking, said out loud rather than superseded
   * silently by its own first leg — which is what `Walker.start` would do, and
   * the mirror of the failure `walkRoute` stops a running lap to avoid.
   */
  startLoop(loop: Loop): MovementStart {
    if (this.walker.walking) this.walker.stop(t('session.loop.stoppedForLoop'));
    // Both destinations the walk was owed die with it: the shop it was going
    // to and the route it was shopping on behalf of are about a journey the
    // lap has just replaced.
    this.journey = null;
    this.errandOwes = null;
    const refused = this.loops.start(loop, this.tracker.current);
    return refused === null ? { started: true } : { refused };
  }

  /**
   * The stopped lap, from wherever the character now stands.
   *
   * The distance to the stop it was heading for **is** how far off the lap the
   * character has got, because a leg is short by construction. An unplannable
   * leg is not a long one: `resume` reports the real refusal in the runner's
   * own words rather than this guessing at it.
   */
  private resumeLoop(state: CharacterState, confirmed: number | null): MovementStart {
    const loop = this.loops.progress;
    const heading = this.loops.heading;
    if (heading !== null) {
      const plan = this.planFromHere(heading);
      if (typeof plan !== 'string' && this.tooFar(plan.steps.length, confirmed)) {
        return {
          confirm: {
            kind: 'loop',
            name: loop.name ?? t('session.move.theLoop'),
            steps: plan.steps.length
          }
        };
      }
    }
    const refused = this.loops.resume(state);
    return refused === null ? { started: true } : { refused };
  }

  /**
   * The stopped route, planned afresh from here.
   *
   * What is asked about is the **difference** — how much further away the
   * character is now than when it stopped — so walking on down a route you
   * were already walking asks nothing however long the route is.
   */
  private resumeRoute(confirmed: number | null): MovementStart {
    const owed = this.walker.unfinished;
    if (owed === null) return { refused: t('session.move.nothingToResume') };
    const plan = this.planFromHere(owed.to);
    if (typeof plan === 'string') return { refused: plan };
    const wandered = plan.steps.length - owed.left;
    if (this.tooFar(wandered, confirmed)) {
      return { confirm: { kind: 'route', name: owed.name, steps: wandered } };
    }
    // Through `walkRoute`, so a resumed route is consulted against the supply
    // list exactly as the one the player drew was: being about to travel is
    // what makes the pack matter, and resuming is being about to travel.
    const refused = this.walkRoute(plan);
    return refused === null ? { started: true } : { refused };
  }

  /**
   * Whether this distance has to be asked about, given what was already
   * agreed to.
   *
   * **`confirmed` is the figure the player was shown**, not a flag, and the
   * distance is measured again on the way back through. A boolean was an
   * unconditional bypass: the prompt says *34 steps*, the dialog sits there
   * while the character is killed and reborn two maps away, and *walk it back*
   * then walks a hundred and twenty with nothing asked — the exact sequence
   * the prompt's own words describe. Agreeing to a journey is agreeing to
   * *that* journey, so anything longer is asked again.
   */
  private tooFar(steps: number, confirmed: number | null): boolean {
    if (steps <= tuning().walk.resumeAskSteps) return false;
    return confirmed === null || steps > confirmed;
  }

  /**
   * The errand let go: walk on to where the player was going.
   *
   * Planned from where the character is standing rather than replayed, for
   * `pickUpAfterLoss`' reason — the shop is not on the route that was drawn,
   * and the way from it is a different set of steps. A refusal is said out
   * loud with the destination in it; the route is not owed twice either way.
   */
  private walkOnAfterErrand(): void {
    const owed = this.errandOwes;
    if (owed === null) return;
    this.errandOwes = null;
    const route = this.planFromHere(owed.to);
    const refused =
      typeof route === 'string' ? route : this.walker.start(route, this.tracker.current);
    this.sink.notice(
      refused === null || refused === undefined
        ? t('session.walk.resumed', { destination: owed.name })
        : t('session.walk.notResumed', { destination: owed.name, reason: refused })
    );
  }

  private stopGoingAnywhere(): void {
    const retreat = this.retreat;
    if (retreat !== null) {
      this.retreat = null;
      this.sink.notice(t('session.safety.retreatDropped', { room: retreat.room }));
    }
    /*
     * A running lap is stopped; one already stopped **restates** why.
     *
     * The second half is not tidiness. `stop` is idempotent, so an
     * already-stopped lap took nothing from a death — and `pausedForFollowers`
     * is only spent when a publish shows the lap in some state other than
     * `stopped`, which a skipped `stop()` never produces. A `@wait`, a death,
     * and then `@ok` therefore walked the character out of the temple on a
     * follower's say-so, past both guards. The claim is spent here explicitly,
     * where the fact that spends it is.
     */
    if (this.loops.progress.status === 'running') this.loops.stop(t('session.loop.stoppedDied'));
    else this.loops.restate(t('session.loop.stoppedDied'));
    this.pausedForFollowers = false;
    // And an errand: the shop it was walking to is several maps away now.
    // With it goes the route it was shopping on behalf of — a death is the
    // player's cue to decide what happens next, not the client's.
    this.errandOwes = null;
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
    // the walker, the queue and the roster are all torn down identically —
    // said as the *client's* doing, because nobody pressed anything.
    this.disconnect('client');
  }

  /**
   * Records one safety decision, bounded.
   *
   * Capped like every other log here: this is a diagnostic somebody reads
   * backwards from whatever just happened, and a session that runs all evening
   * must not grow one.
   */
  /**
   * Stands the arbiter down for as long as a form has the terminal.
   *
   * Cleared rather than paused: what is queued was decided for a character
   * standing in a room, and the character is not standing in one — the server
   * has already run `Player.Exits()` on them. The player's own keystrokes are
   * untouched, as they are everywhere else; they never come through the queue,
   * and typing into the form is the whole reason they are there.
   *
   * Said out loud, once, with the refusal recorded beside every other one: a
   * client that silently stops automating looks exactly like a client that has
   * crashed.
   */
  private holdForStatScreen(because: string): void {
    if (!this.queue.hold(because)) return;
    this.sink.notice(t('session.stats.held'));
    this.noteSafety({
      at: Date.now(),
      action: 'stat screen',
      because,
      acted: true
    });
  }

  /** A prompt came back, so there is a command line again. */
  private releaseStatScreen(): void {
    if (!this.queue.release()) return;
    this.sink.notice(t('session.stats.released'));
  }

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
    this.publishVerdict();
    this.watchForReset();
  }

  /**
   * Whether the character in the realm is still the character this client's
   * records are about.
   *
   * A player who deletes a character and makes a new one keeps the **name**,
   * because the name is the login — so nothing about the connection changes,
   * and every record kept against that name is quietly about somebody who no
   * longer exists: a vault balance, a loadout of kit that is gone, a spellbook,
   * a map, a quest counter.
   *
   * **It reports and nothing more.** The client cannot tell a reset from a
   * realm that renumbered its classes, and deleting the only copy of what
   * somebody learned is not a decision to take from a heuristic. What crosses
   * is both characters and what was noticed; the answer is the player's
   * (`Invoke.forgetCharacter`).
   *
   * Asked **once per session**, and the remembered identity is moved on
   * immediately either way: a prompt that came back on the next status line
   * would be a dialog somebody dismisses without reading, which is the same as
   * no dialog at all.
   */
  private watchForReset(): void {
    if (this.tracker.current.phase !== 'in-game') return;
    const now = identityOf(this.tracker.current, Date.now());
    if (now === null) return;

    const remembered = this.belongings.recallIdentity();
    // Moved on whatever happens next, so this asks once and the record stays
    // current for the session after it.
    this.belongings.rememberIdentity(now);
    if (remembered === null || this.askedAboutReset) return;

    const signals = resetSignals(remembered, now, tuning().session.resetExpDropShare);
    if (signals.length === 0) return;

    this.askedAboutReset = true;
    this.sink.notice(t('session.reset.noticed', { signals: signals.join(', ') }));
    this.sink.reset?.({ signals, before: remembered, after: now });
  }

  /**
   * Throws away what this client kept about the character that was here before.
   *
   * The player's call and only ever the player's — see `watchForReset`. What
   * goes is what is *about a character*: the vault, the loadout, the spellbook,
   * the measured spell durations, the quest counters and the identity itself.
   * What stays is what is about the **realm** — the map this character walked,
   * the shops, the other players — because none of that stopped being true.
   */
  forgetCharacter(): boolean {
    if (!this.belongings.forget()) return false;
    // The four persisted fields are re-seeded from the record that is now
    // empty; the room, the roster and the phase are this session's own and are
    // left exactly as they are.
    this.tracker.forgetBelongings();
    this.publishCharacter();
    this.sink.notice(t('session.reset.forgotten'));
    return true;
  }

  /**
   * The character's own side of the combat arithmetic, for the engine's
   * ranking and the room's appraisal alike: the realm's `CombatLVL` and
   * `MageryLVL` for this class — the stat sheet prints neither — and which
   * lineage's formulas the server runs.
   *
   * Read at the point of use rather than captured, because `this.world`
   * arrives with `useRealm` and the class is not known until a stat sheet
   * has been read. `serverFamily` and not the realm data's, deliberately:
   * this decides which *formulas* run, and the formulas are the server's.
   * The two can legitimately differ — see `noteFamily` — and on the shipped
   * configuration they do.
   */
  private realmClass(): {
    combat: number | null;
    magery: number | null;
    family: RealmFamily | null;
  } {
    const row = this.world?.classNamed(this.tracker.current.className ?? '') ?? null;
    return {
      combat: row?.combat ?? null,
      magery: row?.magery ?? null,
      family: this.serverFamily
    };
  }

  /**
   * *Can I fight this room?* — pushed beside the character, on change.
   *
   * Computed here and not in the renderer because three of its inputs live
   * only in main: the class row, the server's family and the menace prices in
   * `internal.yaml`. And computed here rather than inside `AutoCombat` because
   * the answer is owed to a player with automation **off** — the Room card is
   * for a person deciding whether to open, and the engine's ranking is one
   * consumer of the same function, not its owner. The key keeps a status line
   * that moves no drawn figure from costing a push.
   */
  private publishVerdict(): void {
    const appraisal = this.verdict;
    const key = roomVerdictKey(appraisal);
    if (key === this.lastVerdictKey) return;
    this.lastVerdictKey = key;
    this.sink.verdict?.(appraisal);
  }

  /** The room as it stands, appraised against the character as it stands. See `appraiseRoom`. */
  get verdict(): RoomVerdict {
    const state = this.tracker.current;
    if (state.phase !== 'in-game' || state.room.occupants.length === 0) return EMPTY_ROOM_VERDICT;
    const { combat, magery, family } = this.realmClass();
    return appraiseRoom(
      state.room.occupants,
      this.menacePlayer(state),
      tuning().menace,
      prowessSheetOf(state, { combat, magery }),
      wieldedWeapon(state.inventory.items),
      family
    );
  }

  /**
   * One monster each, by name, for the Reference card's lookup — the same
   * arithmetic as the room's, run on a room of one, so a monster looked up
   * from the console reads exactly as it would standing in front of it.
   *
   * A name the realm cannot place gets no key: the lookup already answers only
   * with the realm's own rows, so an unplaceable name here is one the caller
   * invented rather than one the card will draw.
   */
  appraise(names: readonly string[]): Record<string, Verdict> {
    const state = this.tracker.current;
    const { combat, magery, family } = this.realmClass();
    const sheet = prowessSheetOf(state, { combat, magery });
    const weapon = wieldedWeapon(state.inventory.items);
    const player = this.menacePlayer(state);
    const verdicts: Record<string, Verdict> = {};
    // Weighed as the row the character's own room resolves each name to: a
    // name holding two of the realm's rows was weighed as the worse of them
    // wherever the room says which it is. See `WorldGraph.resolveMobRow`.
    const at =
      state.room.map === null || state.room.number === null
        ? null
        : roomId(state.room.map, state.room.number);
    for (const name of names) {
      const entity = this.world?.buildMobEntity(name, { at });
      if (entity === undefined || entity.source === 'wire') continue;
      const [verdict] = weighVerdicts([entity], player, tuning().menace, sheet, weapon, family);
      if (verdict !== undefined) verdicts[name] = verdict;
    }
    return verdicts;
  }

  /** The three sheet figures a monster's blow or cast is measured against. */
  private menacePlayer(state: CharacterState): {
    armourClass: number | null;
    damageResist: number | null;
    magicRes: number | null;
  } {
    return {
      armourClass: state.progress.armourClass,
      damageResist: state.progress.damageResist,
      magicRes: state.progress.magicRes
    };
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
