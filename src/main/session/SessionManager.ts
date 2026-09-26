/**
 * Owns one live game session: the transport, its observable state, and a
 * bounded diagnostic log. Everything it publishes goes through a sink supplied
 * by the caller, so it has no direct dependency on Electron's IPC.
 */
import { CommandQueue } from '../automation/CommandQueue';
import { Routines } from '../automation/Routines';
import { Walker } from '../automation/Walker';
import { splitOntoChannel } from '../../shared/talk';
import { macroLength, parseMacro } from '../../shared/macro';
import {
  CLASS_STEALTH_ABILITY,
  holdsAbility,
  poisonRefusesRest,
  restsInTheShadows
} from '../../shared/abilities';
import type { TrainerChoice } from '../../shared/world';
import type { AutomationSnapshot, SafetyDecision } from '../../shared/automation';
import { LoginAutomator } from '../automation/LoginAutomator';
import { RuleEngine } from '../automation/RuleEngine';
import { HangUpWatch } from '../automation/HangUp';
import { AutoCombat } from '../automation/AutoCombat';
import { Recovery } from '../automation/Recovery';
import { AutoDeposit } from '../automation/AutoDeposit';
import { AutoDrop } from '../automation/AutoDrop';
import { AutoSearch } from '../automation/AutoSearch';
import { AutoLoot } from '../automation/AutoLoot';
import { AutoLight } from '../automation/AutoLight';
import { AutoStealth } from '../automation/AutoStealth';
import { GearRecovery } from '../automation/GearRecovery';
import { TrainErrand } from '../automation/TrainErrand';
import { StatScreen } from '../automation/StatScreen';
import { RestAway } from '../automation/RestAway';
import { AutoKeys } from '../automation/AutoKeys';
import { Supplies } from '../automation/Supplies';
import { Remotes } from '../automation/Remotes';
import { Afk } from '../automation/Afk';
import type { RemoteName } from '../../shared/remotes';
import { AutoHeal } from '../automation/AutoHeal';
import { AutoInvoke } from '../automation/AutoInvoke';
import { Blessings } from '../automation/Blessings';
import { CastRound } from '../automation/CastRound';
import { CombatLease } from '../automation/CombatLease';
import { Cures } from '../automation/Cures';
import { Potions } from '../automation/Potions';
import { LoopRunner } from '../automation/LoopRunner';
import {
  movementOf,
  type Movement,
  type MovementStart,
  type WalkStart
} from '../../shared/movement';
import { AutoHunt } from '../automation/AutoHunt';
import { ItemErrand } from '../automation/ItemErrand';
import { QuestRunner } from '../automation/QuestRunner';
import { AFTER_WORD } from '../automation/PackAfter';
import { EquipmentManager } from '../automation/EquipmentManager';
import { Wards } from '../automation/Wards';
import { RealmMenu } from './RealmMenu';
import { RowOverrides } from '../automation/RowOverrides';
import { Grounded } from './Grounded';
import { Safety } from './Safety';
import { FleeGoto } from './FleeGoto';
import { Events } from '../automation/Events';
import type { SessionModule } from '../automation/Module';
import type { Loop } from '../../shared/loops';
import {
  nameAnswersTo,
  roomAddress,
  roomId,
  landingRooms,
  type Corridor,
  type Route,
  type WorldSpell
} from '../../shared/world';
import { CharacterTracker } from '../parse/CharacterTracker';
import { Classifier } from '../parse/Classifier';
import { actsOf, applyAct, readLine, type LineAct, type LineRead } from '../parse/lineActs';
import { LineTokenizer, plainText } from '../net/LineTokenizer';
import { TelnetClient } from '../net/TelnetClient';
import { LinkWatch } from './LinkWatch';
import { isPrompt, type Block } from '../../shared/blocks';
import {
  type CharacterState,
  type RealmFamily as RealmWord,
  type SessionPhase
} from '../../shared/character';
import { wireItem } from '../../shared/entities';
import type { Traveller, WorldGraph } from '../world/WorldGraph';
import type { Wearer } from '../../shared/gear';
import { Errands } from './Errands';
import { Claims } from './Claims';
import { Locating } from './Locating';
import { Marks } from './Marks';
import { PromptDesign } from './PromptDesign';
import { QuestWatch } from './QuestWatch';
import { Records } from './Records';
import { StatlineReport } from './StatlineReport';
import { ERRAND_LEG, Travel } from './Travel';
import { UNSTATED_LOCATE, Vocabulary, type VocabularyParts } from './Vocabulary';

/** The item errand's phrase and the listing asked after it, so both can be taken back. */
const COLLECT_SAY_KEY = 'collect:say';
const COLLECT_AFTER_KEY = 'collect:after';
import { NO_LORE, type RealmLoreView } from '../../shared/lore';
import { NO_SPELL_LORE, type SpellLore } from '../../shared/spell-messages';
import { NO_SHIPPED_SENTENCES, type ShippedSentences } from '../../shared/sentences';
import {
  NO_REALM_PLAYERS,
  recordOf,
  type PlayerRegistry,
  type RealmPlayers
} from '../../shared/players';
import { NO_BELONGINGS, type BelongingsSink } from '../../shared/belongings';
import { NO_FIGHTS, type FightSink } from '../../shared/fights';
import type { Discovery, RealmMemory } from '../../shared/memory';
import { NO_FINDS, type Find, type RealmFinds } from '../../shared/finds';
import type {
  QuestErrand,
  QuestPlan,
  QuestRunProgress,
  QuestWatched,
  RoomAsk
} from '../../shared/quests';
import { identityOf, resetSignals } from '../../shared/reset';
import { DEFAULT_INTERNAL, type InternalConfig } from '../../shared/internal';
import type { RealmFamily } from '../../shared/realm';
import { SHIPPED_WORLD_LABEL, worldOfRealm } from '../../shared/worlds';
import { opensStatScreen } from '../../shared/commands';
import { STATUS_LINE } from '../parse/patterns';
import { answeringAfter } from '../parse/echo';
import { TerminalFeed } from './TerminalFeed';
import { Paint } from './Paint';
import { Appraisal } from './Appraisal';
import { Publisher } from './Publisher';
import { Rewriter } from './Rewriter';
import {
  DEFAULT_CONFIG,
  type AutomationConfig,
  type LoginConfig,
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
  StreamLine,
  TelnetEvent,
  TerminalSize
} from '../../shared/types';
import { tuning } from '../app/tuning';
import type { RoomVerdict, Verdict } from '../../shared/verdict';
import type { HuntingAdvice } from '../../shared/hunting';
import type { SessionSink } from './SessionSink';

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
 *
 * Stated here, where the session's tests read it, and handed to `Paint`,
 * which keeps the clock.
 */
export const IDLE_FLUSH_MS = 150;

/**
 * What a session is handed besides its sink, each by name and each optional:
 * the host passes all of them, a probe or a test the few it is about, and the
 * constructor applies every default in one place. See `mudengine-session` ›
 * *A session is handed its ports by name*.
 */
export interface SessionDeps {
  readonly world?: WorldGraph;
  readonly automation?: AutomationConfig;
  readonly login?: LoginConfig;
  /**
   * What is known about monsters and attack spells on *this character's*
   * realm, and what fighting teaches. Defaults to knowing nothing, the honest
   * state for a client with no realm data and the one every test wants.
   */
  readonly lore?: RealmLoreView;
  /**
   * Where what this character learns about the realm is kept.
   *
   * An interface, not the store: this is the session layer, and the file
   * handling belongs to whoever decided where the file goes. Absent in every
   * test and for a realm with no realm data, where there is nothing to learn
   * against and learning something and forgetting it beats refusing to play.
   */
  readonly memory?: RealmMemory;
  /**
   * Where fights are written down.
   *
   * Absent in every test and with `logging.fights` off, which writes no file
   * rather than an empty one. See
   * `shared/fights.ts` for why the record exists at all before anything reads
   * it.
   */
  readonly fights?: FightSink;
  /**
   * What the realm knows about the other players on it, shared by every
   * character dialling the same address. Defaults to a realm that knows
   * nothing, which is what every test wants.
   */
  readonly players?: RealmPlayers;
  /**
   * The realm's sentences for an effect landing and ending, shipped and
   * learned. Per realm like the lore beside it, and defaulting to none for
   * the same reason.
   */
  readonly spellLore?: SpellLore;
  /**
   * Where what a `search` turns up in this realm is written down.
   *
   * Keyed like `memory`'s shared half: what a room hides is the realm's, not
   * this character's. Defaulting to a realm nothing is written down for,
   * which is what the tests want.
   */
  readonly finds?: RealmFinds;
  /**
   * The server's own words for an emote and for a monster dying, shipped
   * (`resources/world/actions.csv`, `death-messages.csv`) and shared by
   * every session. Defaulting to none, which reads exactly as the frames
   * alone did.
   */
  readonly sentences?: ShippedSentences;
  /** The realm's locate word (`Profile.locate`), read through so a reload lands. */
  readonly locate?: VocabularyParts['locate'];
}

/** A module on the session's list, and the slice of a reload it reads, where it reads one. */
interface Managed {
  readonly module: SessionModule;
  readonly configure?: (automation: AutomationConfig) => void;
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
  /** The realm's own word for its data, once the menu has said it. See `noteRealmWord`. */
  private realmTold: RealmWord | null = null;
  private internal: InternalConfig = DEFAULT_INTERNAL;
  private readonly lineLog: StreamLine[] = [];
  private lineSeq = 0;
  /** When the feed is painted and the tail framed on silence. See `Paint`. */
  private readonly paint: Paint;
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
    pvpBlow: (attacker, at) => this.safety.onPvpBlow(attacker, at)
  });
  /** Not a direction: hanging up and the gang alert (`Safety`); the teleport (`FleeGoto`). */
  private readonly safety: Safety;
  /** A monster row overruling the realm's disposition, said once (todo 818). */
  private readonly rowOverrides: RowOverrides;
  private readonly fleeGoto: FleeGoto;
  /** Talk-box lines queued this session, so each one's commands can be named together. */
  private macros = 0;
  /** What the realm menu said a hang-up costs on the realm chosen (todo 01). */
  private readonly realmMenu = new RealmMenu();
  /** Nothing automated on a character lying mortally wounded. See `Grounded`. */
  private readonly grounded: Grounded;
  private lastSize: TerminalSize = { cols: 80, rows: 24 };

  /**
   * Who asked for the hang-up now in flight, latched by `disconnect`.
   *
   * Cleared by every dial, so a `client` left over from last night's
   * low-health hang-up cannot be read as the reason for tomorrow's loss.
   */
  private endedBy: ConnectionEnd | null = null;

  readonly queue: CommandQueue;
  readonly rules: RuleEngine;
  readonly walker: Walker;
  private readonly combatLease: CombatLease;
  /**
   * Fighting on the character's behalf.
   *
   * Below the two safety nets in every sense: it is consulted *after* them on
   * every state change, it proposes in the `combat` band rather than
   * `emergency`, and it is told to stand down whenever an escape is in flight.
   */
  readonly combat: AutoCombat;
  /** What the window is told: the trace, the appraisal, the connection's state. See `Publisher`. */
  private readonly publisher: Publisher;
  /** The room weighed against the character. See `Appraisal`. */
  private readonly appraisal: Appraisal;
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
  /** Going to collect the level when the experience is there — todo 18. */
  private readonly trainLevel: TrainErrand;
  /** Where this character should be at all, and the lap that puts it there — todo 05. */
  private readonly hunt: AutoHunt;
  /** Going to get the item a route's door wants — todo 07. */
  private readonly itemErrand: ItemErrand;
  /** Carrying a quest's plan, step by step (todos 102–103). */
  private readonly questRunner: QuestRunner;
  /** Keeping a room's ward up off a carried item (todo 105). */
  private readonly wards: Wards;
  /** Which kit the character should be in, and getting it there (todo 00). */
  private readonly gear: EquipmentManager;
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
  private readonly castRound: CastRound;
  private readonly potions: Potions;
  private readonly cures: Cures;
  /** Blessings kept up by events on this character and the party. */
  private readonly blessings: Blessings;
  /** Asking a carried item for the blessing it can cast. See `AutoInvoke`. */
  private readonly invoke: AutoInvoke;
  readonly loops: LoopRunner;
  /**
   * Whether a lap, or a route, was moving on the previous progress push.
   *
   * Only so the *edge* is caught: `progress` fires on every step of every leg,
   * and the line about a journey fighting through a switch that is off belongs
   * at the start of it, not once a stop. Two flags because the two progress
   * callbacks are two, and a route starting mid-lap is not a fresh journey.
   */
  private wasLooping = false;
  private wasWalking = false;

  /**
   * The character's own persisted record, as `useRealm` handed it over — the
   * same instance the tracker writes through. Held here so the blessing
   * watchdog can read the measured durations at the point of use.
   */
  private belongings: BelongingsSink = NO_BELONGINGS;

  /** Stops listening to the realm's player book. See `useRealm`. */
  private forgetPlayers: () => void = () => {};
  private readonly events: Events;
  private readonly routines: Routines;
  /** Every module put down together, in order. See the constructor, where it is built. */
  private readonly modules: readonly Managed[];
  /**
   * Whether this session has already asked about a suspected reset.
   *
   * Once, and the remembered identity moves on either way: a prompt that came
   * back on the next status line is a dialog somebody dismisses without
   * reading, which is the same as no dialog at all.
   */
  private askedAboutReset = false;
  /**
   * Whether the far end is still answering. See `LinkWatch`.
   *
   * Owned here rather than by `Reconnect`, which never hears about a socket
   * that stays open: this is the piece that turns a link that died quietly into
   * the `close` event everything downstream already knows what to do with.
   */
  private readonly link: LinkWatch;
  /** `link` hung this socket up, so its close is not the far end's doing. */
  private hungUpDead = false;
  /** What this character writes down about the realm: ways through and finds. See `Records`. */
  private readonly records: Records;
  /** The realm read for this character: travellers, lairs, counters, quests. See `Errands`. */
  private readonly errands: Errands;
  /** What this realm speaks: its family and the words it lacks. See `Vocabulary`. */
  private readonly vocabulary: Vocabulary;
  /** What the server still owes, settled, and the locate that asks. See `Claims`. */
  private readonly claims: Claims;
  /** Placed before a Goto or a Loop plans, where the realm can say. See `Locating`. */
  readonly locating: Locating;
  /** What this character has been seen to do about each quest this sitting. See `QuestWatch`. */
  private readonly questWatch: QuestWatch;
  /** Walking, looping and running away, and what a lost connection carries. See `Travel`. */
  private readonly travel: Travel;

  constructor(
    private readonly sink: SessionSink,
    deps: SessionDeps = {}
  ) {
    const {
      world,
      automation = DEFAULT_CONFIG.automation,
      login = DEFAULT_CONFIG.connection.login,
      lore = NO_LORE,
      memory,
      fights = NO_FIGHTS,
      players = NO_REALM_PLAYERS,
      spellLore = NO_SPELL_LORE,
      finds = NO_FINDS,
      sentences = NO_SHIPPED_SENTENCES,
      locate = UNSTATED_LOCATE
    } = deps;
    this.tracker = new CharacterTracker(
      world,
      lore,
      (discovery) => this.records.remember(discovery),
      fights,
      players,
      spellLore
    );
    this.records = new Records({ tracker: this.tracker, world, memory, finds }, sink);
    this.questWatch = new QuestWatch({ tracker: this.tracker, world }, sink);
    // Before `useRealm`, which tells it the family is unread again.
    this.errands = new Errands(
      { world, tracker: this.tracker, fightRecord: fights },
      {
        config: () => this.automationConfig,
        family: () => this.vocabulary.family,
        watched: () => this.questWatch.watched,
        askAbilities: (state) => this.routines.askAbilities(state),
        notice: (message) => this.sink.notice(message)
      }
    );
    this.vocabulary = new Vocabulary(
      { tracker: this.tracker, errands: this.errands, world, locate },
      {
        locateRefused: () => [this.claims, this.locating].forEach((it) => it.locateRefused()),
        notice: (message) => this.sink.notice(message)
      }
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
        mob: (name) => world?.mob(name),
        self: () => this.tracker.current.name
      },
      // And the spell message table, for the whole-line sentences no frame
      // reads; a lookup because what has been learned changes as the session runs.
      (text) => spellLore.match(text),
      /*
       * And how this realm's monsters die: what its own wire taught (todo 04)
       * **beside** the server's own table, which may name several.
       *
       * Both, not the wire instead of the table (2026-09-14). They are not
       * rivals — a learned name and a shipped one are the same fact at two
       * granularities — and the one answer the wire had taught hid the four
       * the table names, which is what let a sentence every dark monk in the
       * room answers to be read as naming exactly one of them. A sentence
       * several monsters here could have said is settled by the room or by
       * nothing; see `Classifier.asDeathSentence`.
       */
      (text) => {
        const learned = lore.deathOf?.(text) ?? [];
        const shipped = sentences.deaths.mobsOf(text);
        if (learned.length === 0) return shipped;
        return [...new Set([...learned, ...shipped])];
      },
      // And the realm's emotes, off the server's action table.
      (text) => sentences.actions.match(text),
      // And, last, the server's own message table, fitted whole (todo 109).
      (text) => sentences.messages.match(text),
      // And which of its rows a confusing spell prints when it throws a
      // command away, so a fumble in any of the realm's words is read as one.
      (row) => world?.confusionMessages().has(row) ?? false
    );
    this.world = world;
    this.promptDesign = new PromptDesign(
      { tracker: this.tracker, rewriter: this.rewriter },
      { notice: (message) => this.sink.notice(message) }
    );
    this.statlineReport = new StatlineReport({ notice: (message) => this.sink.notice(message) });
    this.marks = new Marks(
      { tracker: this.tracker, world },
      { enrich: () => this.internal.terminal.enrich }
    );
    this.feed = new TerminalFeed(
      {
        isQuiet: (word) =>
          this.internal.terminal.quiet.enabled &&
          this.internal.terminal.quiet.commands.includes(word),
        isStatus: (plain) => STATUS_LINE.test(plain),
        now: () => Date.now(),
        design: (plain) => this.promptDesign.design(plain),
        designing: () => this.promptDesign.designing,
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
      // A held tail released by its timer, outside any chunk.
      (released) => this.paint.released(released)
    );
    this.paint = new Paint(
      { tokenizer: this.tokenizer, feed: this.feed, quietMs: IDLE_FLUSH_MS },
      {
        publish: (framed, at) => this.publishLine(framed, at),
        data: (chunk) => this.sink.data(chunk)
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
         * The player's own line, paced (todo 04): the path a keystroke takes,
         * so it is observed and recorded as typed. Safe inside a drain: the
         * queue sends only with no typing hold standing, so `send`'s own
         * `noteTyping(false)` returns at once.
         */
        if (intent.typed === true) {
          this.send(`${command}\r`);
          return;
        }
        /*
         * An empty line is not a command, and the typed path has always said
         * so (`send` skips all three of these for a bare Enter). Filing one
         * would clear the slots that interpret the *previous* command — the
         * classifier's `lastCommand` and the tracker's unmodelled
         * slot — for a line the server keeps nothing of either. The walker's
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
          this.safety.noteRealmChoice(command);
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
        // `intent.secret` is the login's own answer about *this* command; the
        // latch below is about the last prompt, and the queue may hold the two
        // apart. See `Intent.secret`.
        const reported = this.publisher.reportable(command, intent.secret === true);
        this.sink.command?.(reported, 'automation');
        this.noteSent(command, 'automation');
        this.publisher.recordSent({
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
      unavailable: (command) => this.vocabulary.wordUnavailable(command),
      connected: () => this.client.connected
    });

    const onTheGround = (): boolean => this.grounded.down;
    // Under a timed spell the way in cast, the walk moves and nothing else does (todo 104).
    const moveOnly = (state: CharacterState): boolean => this.underTimedSpell(state) !== null;
    this.routines = new Routines(automation, this.queue, {
      notice: (message) => this.sink.notice(message),
      onTheGround
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
        this.hungUpDead = true;
        this.client.abandon();
      }
    });

    // What the lease, the light, the errands and the travel tell the session:
    // a line for the console, and a decision for the safety trace.
    const reports = {
      notice: (message: string): void => this.sink.notice(message),
      decided: (decision: SafetyDecision): void => this.publisher.noteSafety(decision)
    };
    /*
     * Walking a route is an outbound action, so it proposes to the arbiter like
     * everything else. Phase 4 planned routes and stopped there deliberately;
     * this is the piece that executes one, a verified step at a time.
     */
    this.combatLease = new CombatLease({
      flip: (on) => this.sink.switchAutomation?.('combat', on) ?? false,
      ...reports,
      declined: () => this.combat.journeyDeclined,
      returned: (declined) => this.combat.leaseReturned(declined)
    });
    // Configured where it is built, as the loop runner is: unconfigured, it
    // read every switch as on and would never lend (todo 00).
    this.combatLease.configure(automation);
    this.walker = new Walker(automation, this.queue, {
      // A loop walks through the walker, so this is how it hears a leg end.
      ended: (arrived, reason) => {
        this.travel.walkEnded(arrived);
        this.loops.onWalkEnded(arrived, reason, this.tracker.current);
        this.supplies.onWalkEnded(arrived, reason, this.tracker.current);
        this.recoverGear.onWalkEnded(arrived, reason, this.tracker.current);
        this.trainLevel.onWalkEnded(arrived, reason, this.tracker.current);
        this.hunt.onWalkEnded(arrived, reason, this.tracker.current);
        this.questRunner.onWalkEnded(arrived, reason, this.tracker.current);
      },
      stepping: (command, direction, to, landing) => {
        if (landing !== undefined && direction !== 'portal') {
          /*
           * An exit whose cast moves the character, which answers with **two**
           * room blocks: the room the exit table names, then the room the
           * spell put them in. Both are this command's answer, so both are
           * queued. See `Expectations.hintCast`.
           */
          this.tracker.hintCast(command, direction, landingRooms(landing));
          return;
        }
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
      refused: (from, direction, why) => this.errands.noteRefused(from, direction, why),
      // Where the player asked to go. Every walk goes through the walker — a route from the palette
      // and a loop's own leg alike — which is why the record is taken here and not at the IPC
      // handler the loop never reaches. And a new walk supersedes a journey still owed from a lost
      // connection, whoever started it — the walker replaces a walk silently, and picking the old
      // one up later would replace the new one the same way.
      destination: (room, name) => {
        this.travel.supersedeJourney();
        this.sink.destination?.(room, name);
      },
      // The tracker's queue, not the walker's own idea of one: it counts a
      // typed direction and a leg left over from a walk combat stopped, which
      // are the moves a route cannot see and is desynchronised by.
      pendingMoves: () => this.tracker.pendingMoves,
      // A rest, or a floor read after a kill, asked a moment ago and unanswered: a move
      // in flight's kind of fact (`Recovery.restInFlight`, todo 14; `AutoLoot`, 814).
      restInFlight: () => this.recovery.restInFlight,
      floorInFlight: () => this.loot.floorInFlight,
      onTheGround,
      /*
       * A route that stood still for a fight plans again from wherever the
       * fight left the character. Answered here for the reason `holdAt` and
       * `lightSource` are: the answer needs the realm graph, the character's
       * purse and the edges this session has seen refused, and the walker
       * holds a route and a queue and deliberately not the world.
       */
      replan: (to, shortest) => this.travel.replan(to, shortest),
      moveOnly,
      /*
       * And where a draw put the character, when the room's own name and
       * exits cannot say. The same ask the lap makes and the same one
       * command; see `WalkerEvents.locate` for why a scatter maze is the
       * case that needs it.
       */
      locate: () => this.claims.askWhereIAm(),
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
      routeBetween: (from, to, shortest) => this.errands.routeBetween(from, to, shortest),
      // A walk that engages pauses where there is something worth fighting, so
      // the wanderer met mid-corridor is met, not passed — and so is the second
      // monster in a room the first was just killed in. Asked of auto-combat
      // whole: which walks engage is `whileWalking` and `looping`, and stating
      // half of that here left the two able to disagree. See `quarry`.
      holdAt: (state) => this.combat.quarry(state),
      // Whether an onset that landed behind a step is a hold at all is the
      // realm's to say, and the realm is here. See `spellsHold`.
      spellsHold: (spells) => this.errands.spellsHold(spells),
      // The beat is re-asked on a timer, by which time the state it began with
      // is a second and a half old.
      stateNow: () => this.tracker.current,
      // Which of the things in the pack is a light is realm data, so the
      // question is answered here where the world graph is and not in the
      // walker, which holds a route and a queue and nothing else.
      lightSource: (state) => this.errands.lightSource(state),
      // And the light itself, ahead of the step. See `AutoLight`.
      beforeStep: (ahead, state) => this.light.beforeStep(ahead, state),
      // And the ward the room ahead wants, off the pack (todo 105).
      wardFor: (to, state) => this.wards.beforeStep(to, state),
      // Whether a fight here is one auto-combat will fight: the walk waits out
      // nothing else (`Holds.canEndAFight`), and never past an escape's move.
      willFight: () => this.combat.wouldFight,
      escaping: () => this.travel.escapeUnanswered || this.travel.isRetreating(),
      /*
       * And whether one is coming for the room the character is standing in,
       * which is what a walk waits on rather than giving up in the dark. This
       * module runs *after* the walker on every state, so the walker cannot
       * read the answer off the queue — it has to ask.
       */
      lightComing: (state) => this.light.couldReady(state),
      keyToUse: (keyId) => this.errands.keyToUse(keyId),
      notice: (message) => this.sink.notice(message),
      progress: (progress) => {
        /*
         * Auto-combat is told whether a route is running, rather than reaching
         * into the walker for it: the walker is the only thing that knows a
         * route is in progress.
         *
         * **A route fights**, whatever the switch says (todo 00) — the player
         * asked to go somewhere, and what lives between here and there is the
         * realm's business. Said once at the start, for the reason the lap's
         * line is: a client that attacks while the toolbar's own switch reads
         * off is two surfaces disagreeing in silence.
         */
        const walking = progress.status === 'walking';
        // Not for a run: it declines the fight one statement after this
        // publish, and the sentence would announce a fight it never has.
        if (
          walking &&
          !this.wasWalking &&
          !this.wasLooping &&
          !this.travel.walkIsRun &&
          this.combat.fightingBecauseTravelling
        ) {
          this.sink.notice(t('automation.combat.fightingForTheRoute'));
        }
        this.wasWalking = walking;
        this.combat.noteWalking(walking);
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
        // The round beat, for the one thing that rides it without being a
        // cast: the equipment manager's off-round invocation (todo 00).
        round: (state) => this.gear.round(state),
        /*
         * The trace, not the console. A refusal to open a fight is not news
         * the *game's* surface should carry — it happens in every corridor and
         * would be the chrome talking over the realm — but it is exactly what
         * somebody asking "why did it walk past those thugs" needs, and the
         * Automation card is where a decision is read back.
         */
        decided: (decision) => this.publisher.noteEngagement(decision),
        /*
         * Whether this class can get into the shadows at all, from the realm's
         * own class row (todo 28). `combat.opener` survives a reroll, so a
         * profile set up for a Ninja asked for `bs` as a Mage and was told why
         * it was withheld *this time* — which cannot be acted on.
         *
         * `ClassStealth` rather than `Stealth`: the class row grants the
         * first, and a Thief carries both. Null while the realm or the class
         * is unread, which never refuses.
         */
        canHide: () => holdsAbility(this.errands.capabilities(), CLASS_STEALTH_ABILITY),
        onTheGround
      },
      automation.spells,
      (name) => this.world?.spellNamed(name) ?? null,
      /*
       * The character's own side of the combat arithmetic, read at the point
       * of use: the class is not known until a stat sheet has been read.
       *
       * `Vocabulary.family` and not the realm data's, deliberately: this decides
       * which *formulas* run, and the formulas are the server's. The two can
       * legitimately differ — see `Vocabulary.noteFamily` — and on the shipped
       * configuration they do.
       */
      () => this.errands.realmClass(),
      lore
    );

    /*
     * Sitting down, which is the opposite answer to the same number the
     * retreat reads. Both are consulted below, in the order that settles which wins:
     * running away is `emergency` and this is `probe`, so a character under
     * both thresholds runs first and rests wherever it lands.
     */
    this.recovery = new Recovery(automation, this.queue, {
      notice: (message) => this.sink.notice(message),
      /*
       * GreaterMUD's engine refuses `rest` outright while poisoned — unless
       * the character is *immune*, which the server's own test says lifts it
       * (`RestCommand.cs:28`) and which a Kang has from its race (todo 22).
       * Telling a Kang it cannot rest would be the client inventing a
       * refusal the server does not make.
       *
       * The family and not the loaded database: it is the server's branch,
       * so a MajorMUD server running a converted GreaterMUD realm does not
       * have it, and null is not `greatermud`.
       */
      poisonRefusesRest: () =>
        poisonRefusesRest(this.errands.capabilities(), this.vocabulary.family)
    });
    /*
     * The realm's row for a name on the floor. Read at the point of use, like
     * `realmSpell` below and for the same reason: `this.world` arrives with
     * `useRealm` and may not exist yet. A realm with no data answers a whole
     * wire entity, which is what makes the predicates decline rather than
     * throw.
     */
    this.loot = new AutoLoot(automation.loot, automation.supplies, automation.enabled, this.queue, {
      realmItem: (name) => this.world?.buildItemEntity(name) ?? wireItem(name),
      notice: (message) => this.sink.notice(message),
      onTheGround,
      moveOnly,
      rereads: this.tracker
    });
    /*
     * The light, asked by the walker before every step (`beforeStep`) and by
     * the state on every arrival. Its refusals go to the safety trace, because
     * a torch not lit in a dark room is a decision somebody will ask about.
     */
    /*
     * And the ward a room wants, kept up off the pack (todo 105): the realm
     * says which spell stops a room's effect and which item's use casts it,
     * and this uses the item before the step and again when the spell
     * lapses. The stated countdowns are the router's; this module's own clock
     * is the walk's.
     */
    this.wards = new Wards(
      automation.health,
      automation.enabled,
      this.queue,
      {
        hazardAt: (room) => this.errands.hazardAt(room),
        itemsCasting: (spell) => this.world?.itemsCasting(spell) ?? [],
        spellById: (id) => this.world?.spellById(id) ?? null,
        spellsUp: (state) => this.errands.spellsUp(state)
      },
      { notice: (message) => this.sink.notice(message) }
    );
    this.light = new AutoLight(automation.movement, automation.enabled, this.queue, {
      ...reports,
      escaping: () => this.travel.isRetreating()
    });
    /*
     * The shadows, asked for between fights. Told whether a lap or a route
     * has the character, because the answer is a different command: `sn` for
     * the step ahead, `hide` for standing still.
     */
    this.stealth = new AutoStealth(automation.combat, automation.enabled, this.queue, {
      notice: (message) => this.sink.notice(message),
      escaping: () => this.travel.isRetreating(),
      moving: () => this.walker.walking || this.loops.progress.status === 'running',
      moveInFlight: () => this.tracker.pendingMoves > 0,
      openerRefused: () => this.combat.openerRefused(),
      /*
       * Whether resting and hiding undo each other for this class, read off the
       * realm's own class row. The shipped data is the reason it is read rather
       * than named: Paradigm grants `ShadowHome` to seven classes and
       * MajorMUD's realm to none, so the file loaded already answers it — and
       * the family gates the *behaviour*, which belongs to GreaterMUD's engine
       * whatever database it is running.
       */
      restsHidden: () =>
        restsInTheShadows(
          this.world?.classNamed(this.tracker.current.className ?? '')?.abilities,
          this.vocabulary.family
        )
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
        ways: (state) => this.errands.keyedWaysHere(state),
        carried: (state) => this.errands.packContents(state),
        idOf: (name) => this.world?.itemIdNamed(name) ?? null
      },
      {
        notice: (message) => this.sink.notice(message),
        escaping: () => this.travel.isRetreating(),
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
    // An errand letting a held lap go, and a lap stopped with its walk: one each.
    const releaseErrand = (): void => {
      this.loops.noteErrandOver();
      this.travel.walkOnAfterErrand();
    };
    const stopLap = (reason: string): void => {
      this.loops.stop(reason);
      this.walker.stop(reason);
    };
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
        here: () => roomAddress(this.tracker.current.room),
        shopRoom: (item) => this.errands.shopRoom(item),
        routeTo: (room) => this.errands.planFromHere(room),
        priceAt: (item, shop) => this.errands.priceAt(item.name, shop),
        cashFrom: (need, then) => {
          const state = this.tracker.current;
          const here = roomAddress(state.room);
          if (this.world === undefined || here === null) return [];
          return this.world.cashPlaces(
            state.banks,
            need,
            here,
            then,
            this.errands.travellerNow(state)
          );
        },
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
        busy: () => this.travel.isRetreating() || this.travel.retreatArmed,
        looping: () => this.loops.progress.status === 'running',
        hold: () => this.loops.noteErrand(),
        release: releaseErrand
      },
      reports
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
        here: () => roomAddress(this.tracker.current.room),
        routeTo: (room) => this.errands.planFromHere(room),
        walk: (route) => this.walker.start(route, this.tracker.current, ERRAND_LEG),
        moveInFlight: () => this.tracker.pendingMoves > 0,
        walking: () => this.walker.walking,
        busy: () =>
          this.travel.isRetreating() || this.travel.retreatArmed || this.travel.escapeUnanswered
      },
      reports
    );
    /*
     * And going to collect the level, which is the one thing an unattended
     * client has to do (todo 18). The errand's own planner, with the same
     * refusals and a leg's options — and the lap held rather than ended, as
     * a supply errand holds it.
     */
    this.trainLevel = new TrainErrand(
      automation.train,
      automation.enabled,
      this.queue,
      {
        here: () => roomAddress(this.tracker.current.room),
        trainers: () => this.errands.trainers(),
        routeTo: (room) => this.errands.planFromHere(room),
        walk: (route) => this.walker.start(route, this.tracker.current, ERRAND_LEG),
        moveInFlight: () => this.tracker.pendingMoves > 0,
        walking: () => this.walker.walking,
        busy: () =>
          this.travel.isRetreating() || this.travel.retreatArmed || this.travel.escapeUnanswered,
        looping: () => this.loops.progress.status === 'running',
        hold: () => this.loops.noteErrand(),
        release: releaseErrand
      },
      reports
    );
    /*
     * And where the character should be at all (todo 05): the survey's best
     * lair within reach, walked to as a journey the card draws and then run as
     * a loop that is filed nowhere. Its planner is the errand's, with one
     * difference that is the whole point — the walk is a **route the player
     * asked for** rather than a leg, because a lair three maps away is a
     * journey and a journey drawn as nothing is a character crossing the realm
     * under a card that says *stopped*.
     */
    this.hunt = new AutoHunt(
      automation.hunting,
      automation.walk,
      automation.health,
      automation.enabled,
      {
        here: () => roomAddress(this.tracker.current.room),
        survey: (radius) => this.errands.huntingGrounds(radius),
        routeTo: (room) => this.errands.planFromHere(room),
        walk: (route) => this.walker.start(route, this.tracker.current),
        runLoop: (loop) => {
          const answer = this.travel.startLoop(loop);
          return 'refused' in answer ? answer.refused : null;
        },
        // The lap's **name**, so the hunt can tell its own from one the player
        // started while it was running. See `HuntPlanner.runningLoop`.
        runningLoop: () =>
          this.loops.progress.status === 'running' ? (this.loops.progress.name ?? null) : null,
        stopLoop: stopLap,
        moveInFlight: () => this.tracker.pendingMoves > 0,
        walking: () => this.walker.walking,
        /*
         * Nothing else in the middle of something. The escapes, and **the
         * errands** — each of which has phases where nothing is walking and
         * nothing is looping (a shop errand waiting for its listing, a trainer
         * errand waiting for the level to move), during which a hunt would
         * otherwise survey and walk the character away from what it came for.
         */
        busy: () =>
          this.travel.isRetreating() ||
          this.travel.retreatArmed ||
          this.travel.escapeUnanswered ||
          this.supplies.current !== null ||
          this.trainLevel.busy ||
          this.itemErrand.running ||
          this.questRunner.running
      },
      reports
    );
    /*
     * And going to get the thing a door wants (todo 07): bought where the
     * realm names a counter, hunted where it names a monster, and the route
     * the player asked for walked once the pack holds it.
     */
    this.itemErrand = new ItemErrand(
      {
        here: () => roomAddress(this.tracker.current.room),
        sourcesOf: (item, to) => this.errands.itemSources(item, to),
        buy: (row) => this.supplies.fetch(row, this.tracker.current),
        buying: () => this.supplies.current !== null,
        runLoop: (loop) => {
          // `startLoop` replaces whatever lap was running, which is right — one
          // movement at a time — and worth saying, because the lap it replaces
          // is the player's and it is not coming back on its own.
          if (this.loops.progress.status === 'running') {
            this.sink.notice(
              t('automation.collect.replacingLap', { loopName: this.loops.progress.name ?? '' })
            );
          }
          const answer = this.travel.startLoop(loop);
          return 'refused' in answer ? answer.refused : null;
        },
        looping: () => this.loops.progress.status === 'running',
        stopLoop: stopLap,
        alsoTake: (name) => this.loot.alsoTake(name),
        stopTaking: (name) => this.loot.stopTaking(name),
        walk: (route, run) => this.travel.walkAfterCollecting(route, run),
        // The player's own list is what makes a found key worth keeping.
        kept: (name) =>
          this.automationConfig.supplies.items.some((row) => nameAnswersTo(name, row.name)),
        walkTo: (room) => this.travel.walkLegTo(room),
        walking: () => this.walker.walking,
        // The phrase in the `probe` band, as the quest run's act, and seen by
        // the quest book like any act this client sends for the player.
        say: (command, onSent) =>
          this.queue.enqueue({
            command,
            priority: 'probe',
            coalesceKey: COLLECT_SAY_KEY,
            // Lapses as the quest run's act does, so a phrase that never goes
            // out ends the errand rather than holding it (`saying`).
            expiresAt: Date.now() + tuning().quests.expiresMs,
            reason: t('automation.collect.reasonSay', { command }),
            onSent: () => {
              onSent();
              this.questWatch.noteSaid(command);
            }
          }),
        listPack: (onSent) =>
          this.queue.enqueue({
            command: AFTER_WORD,
            priority: 'probe',
            coalesceKey: COLLECT_AFTER_KEY,
            expiresAt: Date.now() + tuning().quests.expiresMs,
            reason: t('automation.collect.reasonPackAfter'),
            onSent
          }),
        saying: () => this.queue.queued((intent) => intent.coalesceKey === COLLECT_SAY_KEY),
        takeBack: () =>
          this.queue.cancel(
            (intent) =>
              intent.coalesceKey === COLLECT_SAY_KEY || intent.coalesceKey === COLLECT_AFTER_KEY
          )
      },
      reports
    );
    /*
     * And carrying a quest's plan (todos 102–103): the errands above, the
     * walker and auto-combat, driven one step at a time by the plan the card
     * drew. Its legs are an errand's — quiet, held for health, not owed
     * across a lost connection — and it holds the lap as the errands do.
     */
    this.questRunner = new QuestRunner(
      automation.quests,
      automation.enabled,
      this.queue,
      {
        here: () => roomAddress(this.tracker.current.room),
        /*
         * `abil` is GreaterMUD's alone, and the family is told by the banner
         * or by the listing having answered at all: a realm that has printed
         * its counters once prints them.
         */
        printsCounters: () =>
          this.vocabulary.family === 'greatermud' || this.tracker.current.abilities !== null,
        routeTo: (room) => this.errands.planFromHere(room),
        walk: (route) => this.walker.start(route, this.tracker.current, ERRAND_LEG),
        stopWalking: (reason) => {
          if (this.walker.walking && !this.travel.walkIsAsked) this.walker.stop(reason);
        },
        moveInFlight: () => this.tracker.pendingMoves > 0,
        walking: () => this.walker.walking,
        busy: () =>
          this.travel.isRetreating() || this.travel.retreatArmed || this.travel.escapeUnanswered,
        looping: () => this.loops.progress.status === 'running',
        hold: () => this.loops.noteErrand(),
        release: () => this.loops.noteErrandOver(),
        buy: (row) => this.supplies.fetch(row, this.tracker.current),
        buying: () => this.supplies.current !== null,
        restock: (to, later) => this.errands.questRestock(to, later),
        hunt: (item) => this.itemErrand.collect([item], null, this.tracker.current),
        hunting: () => this.itemErrand.running,
        abandonErrands: (reason) => {
          this.supplies.abandon(reason);
          this.itemErrand.abandon(reason);
        },
        fightFor: (mob) => this.combat.alsoFight(mob),
        stopFighting: (mob) => this.combat.stopFighting(mob),
        questing: (on) => this.combat.noteQuesting(on),
        warding: (on) => this.wards.lend(on),
        said: (command) => this.questWatch.noteSaid(command),
        watched: () => this.questWatch.watched
      },
      { ...reports, progress: (progress) => this.sink.questRun?.(progress) }
    );
    /*
     * And where a rest is taken: not in a room that makes monsters on a short
     * clock, when a neighbour the realm holds no lair in can be looked into
     * and found empty. The clock is the realm's own (`Rooms.Delay`, read the
     * way `huntingGrounds` reads it); the neighbours are the room's exits
     * into rooms with no lair and no resident, plain exits first.
     */
    this.restAway = new RestAway(
      automation,
      this.queue,
      {
        here: () => roomAddress(this.tracker.current.room),
        lairClock: (room) => this.errands.lairClock(room),
        neighbours: (room) => this.errands.neighbours(room),
        moveInFlight: () => this.tracker.pendingMoves > 0,
        walking: () => this.walker.walking && this.walker.holding === null,
        looping: () => this.loops.progress.status === 'running',
        busy: () =>
          this.travel.isRetreating() || this.travel.retreatArmed || this.travel.escapeUnanswered
      },
      reports
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
          const here = roomAddress(this.tracker.current.room);
          const room = here === null ? undefined : this.world?.byId(here);
          if (!room || room.shop === undefined) return false;
          return this.world?.shop(room.shop)?.kind === 'trainer';
        },
        write: (bytes) => {
          this.client.send(bytes);
          this.sink.command?.(bytes.replace(/\r?\n$/, ''), 'automation');
        }
      },
      reports
    );
    // And its opposite number: what the loot hoarded, the drop list sheds.
    this.drop = new AutoDrop(automation.drop, automation.enabled, this.queue);
    this.search = new AutoSearch(
      automation.search,
      automation.enabled,
      this.queue,
      // The state as it is at the send, not as it was at the proposal.
      () => this.tracker.current,
      (state) => this.combat.quarry(state)
    );
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
      /*
       * The counter in front of the character, as the realm's own shop row —
       * `null` where the resolved room is not a bank at all. The *row* rather
       * than a yes, so a character standing at a counter that is not the one
       * it banks at can be told which fact stopped it (todo 00).
       */
      (state) => {
        const at = roomAddress(state.room);
        const here = at === null ? undefined : this.world?.byId(at);
        if (!here || here.shop === undefined) return null;
        return this.world?.shop(here.shop)?.kind === 'bank' ? here.shop : null;
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
    this.afk = new Afk(automation.afk, automation.enabled, this.queue, this.sink);
    this.remotes = new Remotes(automation, this.queue, {
      notice: (message) => this.sink.notice(message),
      // What the character is doing, for `@status`, at the moment it is asked.
      progress: () => ({ walk: this.walker.progress, loop: this.loops.progress }),
      peer: (who) => recordOf(this.tracker.players, who),
      pace: (who, ready) => this.travel.pace(who, ready),
      // On their registry entry, which the Player card reads; pushed now, as nothing else moved.
      commanded: (from, raw, at) => {
        if (this.tracker.noteRemoteCall(from, raw, at)) this.publisher.players();
      },
      // A blessed party member says the spell wore off; recast on the event.
      blessExpired: (from, spell) => this.blessings.onPeerExpired(from, spell),
      /*
       * A member asks for a heal. Decided now rather than on the next status
       * line, which out of a fight may be a long way off — under the guard the
       * heal always runs under, since nothing is cast on the way out of a room.
       */
      healRequested: (from) => {
        const state = this.tracker.current;
        this.heal.request(from, state);
        if (!this.grounded.standsDown(state) && !this.travel.isRetreating())
          this.heal.onCharacter(state);
      },
      /*
       * Which client another player runs — the fact the extended vocabulary
       * turns on — on their registry entry, and pushed for `commanded`'s reason.
       */
      clientNamed: (from, client, extended) => {
        const facts = { ...(client === undefined ? {} : { client }), extendedRemotes: extended };
        if (this.tracker.noteRemoteClient(from, Date.now(), facts)) this.publisher.players();
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
        if (this.tracker.noteRemoteRoom(from, room, name, Date.now())) this.publisher.players();
      },
      comeBack: (from, map, room) => this.travel.comeBack(from, map, room)
    });
    // All four casters share one realm lookup, handing over the realm's whole
    // row, read at the point of use because `this.world` arrives with `useRealm`.
    const realmSpell = (name: string): WorldSpell | null => this.world?.spellNamed(name) ?? null;
    this.castRound = new CastRound(reports);
    this.heal = new AutoHeal(
      automation.spells,
      automation.enabled,
      this.queue,
      undefined,
      realmSpell,
      { notice: (message) => this.sink.notice(message) },
      // The class row and the server's family, for `castOdds` — read at the
      // point of use, as `AutoCombat`'s is.
      () => this.errands.realmClass(),
      this.castRound
    );
    this.potions = new Potions(automation.health, automation.enabled, this.queue);
    this.cures = new Cures(
      automation.spells,
      automation.enabled,
      this.queue,
      undefined,
      realmSpell,
      { notice: (message) => this.sink.notice(message) },
      this.castRound
    );
    this.blessings = new Blessings(automation.spells, automation.enabled, this.queue, {
      /*
       * The measured duration of this character's own cast, read at the point
       * of use so the store that arrives with `useRealm` is the one answering.
       * Null before any measurement — the shipped watchdog covers that. The one
       * fact here that is not the realm's, which is why it is still its own.
       */
      learnedDuration: (spell) =>
        this.belongings.recallSpellDurations()[spell.trim().toLowerCase()] ?? null,
      realmSpell,
      onTheGround,
      castGate: this.castRound
    });
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
    /*
     * And which kit to be in. The pack is asked before the realm for both
     * facts: a carried item carries the realm's own reading joined onto it
     * (`ItemEntity.realmSlot`, `weapon.hands`), and that is the row the
     * server will actually put on — a second row of the same name in the
     * catalogue is not.
     */
    this.gear = new EquipmentManager(
      automation.gear,
      automation.enabled,
      this.queue,
      {
        slotOf: (name) => this.errands.gearSlotOf(name),
        handsOf: (name) => this.errands.gearHandsOf(name)
      },
      { notice: (message) => this.sink.notice(message) }
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
    this.events = new Events(automation.events, automation.enabled, this.queue, { onTheGround });
    /*
     * A loop is walked *by the walker*: it plans each leg with the same route
     * planner a person uses and hands it over, so every guard a walk has —
     * one verified step at a time, stop on a shut door, stop on a typed
     * command — holds for a loop too. What the loop adds is where to go next.
     */
    this.loops = new LoopRunner(
      {
        routeTo: (stop) => {
          if (roomAddress(this.tracker.current.room) === null) return t('session.loop.unknownRoom');
          const found = this.errands.findStop(stop);
          if (typeof found === 'string') return found;
          return this.errands.planFromHere(roomId(found.map, found.room), {}, true);
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
            resumeAfterLoss: false,
            // And by distance, however the walker comes to re-plan it.
            shortest: true
          }),
        moveInFlight: () => this.tracker.pendingMoves > 0,
        // A rest this client asked for a millisecond ago. The lap waits a beat
        // rather than stepping into it — see `Recovery.restInFlight`, todo 14.
        restInFlight: () => this.recovery.restInFlight,
        // Some other walk is running this character — a `safe-haven` retreat,
        // in practice, which is the one walk that runs while the loop is held.
        walking: () => this.walker.walking,
        here: (stop) => {
          const here = this.tracker.current.room;
          const found = this.errands.findStop(stop);
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
        roomOf: (stop) => this.errands.stopRoom(stop),
        // Where the character is standing, read at the moment the lap stops.
        // See `LoopRunner.stoppedIn` and `resumeLoop`.
        hereNow: () => roomAddress(this.tracker.current.room),
        onTheGround
      },
      {
        /*
         * Where would earn more, for the low-experience stop (todo 05). Asked
         * at that stop and nowhere else, which is why the hunt is told here:
         * *the lap earned too little* is exactly the fact that re-opens a
         * settled answer, and naming the better lair without going to it was
         * the half this had (todo 05's own last bullet).
         */
        betterSpot: () => {
          this.hunt.noteLapStopped();
          return this.errands.betterHuntingWords();
        },
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
          if (running && !this.wasLooping && this.combat.fightingBecauseTravelling) {
            this.sink.notice(t('automation.loops.fightingForTheLap'));
          }
          this.wasLooping = running;
          this.combat.noteLooping(running);
          this.travel.noteLap(progress);
          this.sink.loop?.(progress);
        },
        locate: () => this.claims.askWhereIAm()
      }
    );
    /*
     * The one module built without its config: the runner takes a planner and
     * events, and learned its floors only in `configure` — which the host
     * calls after construction and a test or a harness may not. Built with
     * `automation` and never configured, a session rested on the profile's
     * `restBelow` and marched its lap on the default one, 457 ms apart
     * (todo 106). Configured where it is built, so a session has one answer to
     * *hurt* from its first status line; `configure` re-applies on reload.
     */
    this.loops.configure(automation.health, automation.movement, automation.walk);
    // Built once every module it drives exists; the callbacks above reach it
    // only when something happens, which is after the constructor.
    this.travel = new Travel(
      {
        tracker: this.tracker,
        world,
        errands: this.errands,
        queue: this.queue,
        walker: this.walker,
        loops: this.loops,
        combat: this.combat,
        combatLease: this.combatLease,
        supplies: this.supplies,
        trainLevel: this.trainLevel,
        hunt: this.hunt,
        itemErrand: this.itemErrand,
        questRunner: this.questRunner
      },
      {
        config: () => this.automationConfig,
        movement: () => this.movement,
        loopNamed: (name) => this.loopNamed(name),
        dropTyped: (died) => this.dropTyped(died),
        ...reports
      }
    );
    this.claims = new Claims(
      {
        tracker: this.tracker,
        queue: this.queue,
        combat: this.combat,
        vocabulary: this.vocabulary
      },
      { notice: (message) => this.sink.notice(message) }
    );
    this.locating = new Locating({ tracker: this.tracker, claims: this.claims }, sink);

    // Rules propose; the queue disposes. Nothing here reaches the socket.
    this.rules = new RuleEngine(this.queue, {
      notice: (message) => this.sink.notice(message),
      onTheGround
    });
    this.rules.load(automation.rules, automation.combat.mobRules);

    this.appraisal = new Appraisal(
      { tracker: this.tracker, world, errands: this.errands },
      { config: () => this.automationConfig, watched: () => this.questWatch.watched }
    );
    this.publisher = new Publisher(
      {
        tracker: this.tracker,
        appraisal: this.appraisal,
        queue: this.queue,
        rules: this.rules,
        client: this.client
      },
      { config: () => this.automationConfig },
      sink
    );
    this.grounded = new Grounded(this.publisher, sink);
    const safetyParts = {
      tracker: this.tracker,
      hangUp: this.hangUp,
      realmMenu: this.realmMenu,
      queue: this.queue,
      travel: this.travel,
      client: this.client,
      publisher: this.publisher,
      grounded: this.grounded
    };
    const safetySession = {
      config: () => this.automationConfig,
      disconnect: (by: ConnectionEnd) => this.disconnect(by),
      notice: (message: string) => this.sink.notice(message)
    };
    this.safety = new Safety(safetyParts, safetySession);
    this.rowOverrides = new RowOverrides(automation, { notice: (text) => this.sink.notice(text) });
    this.fleeGoto = new FleeGoto(safetyParts, safetySession);

    /*
     * Answering the login is on the *player's* behalf, so it goes through the
     * arbiter at `user` priority and outranks anything automated.
     */
    this.publisher.useSecret(login.password);
    this.login = new LoginAutomator(login, this.queue, this.sink);
    /*
     * The modules, in the order `connect` puts them down; `connect`,
     * `leftTheRealm`, `configure` and `dispose` walk this list and nothing
     * else. `walker` precedes `questRunner`: `QuestRunner.reset` settles a run,
     * which stops a live walk. Handled by name beside the loop, with why: the
     * line pipeline, `loops`, `login`, `realmMenu`, the lease's reload (combat
     * reads it). `travel` and `errands` come last: a module's reset may settle
     * a walk or let an errand go, and what that sets off plans with them; what
     * a same-realm reconnect carries (the journey owed, the followers' `@wait`)
     * is Travel's, put down by name. `safety` and `fleeGoto` sit beside the
     * watch; what they forget only `act()` reads, so their place is not a
     * decision. `lifecycle.test.ts` holds every module with a `reset` here.
     */
    this.modules = [
      { module: this.routines, configure: (a) => this.routines.configure(a) },
      { module: this.rules, configure: (a) => this.rules.load(a.rules, a.combat.mobRules) },
      { module: this.walker, configure: (a) => this.walker.configure(a) },
      { module: this.combat },
      {
        module: this.recovery,
        configure: (a) => this.recovery.configure(a)
      },
      { module: this.loot, configure: (a) => this.loot.configure(a.loot, a.supplies, a.enabled) },
      { module: this.drop, configure: (a) => this.drop.configure(a.drop, a.enabled) },
      { module: this.search, configure: (a) => this.search.configure(a.search, a.enabled) },
      { module: this.deposit, configure: (a) => this.deposit.configure(a.banking, a.enabled) },
      { module: this.light, configure: (a) => this.light.configure(a.movement, a.enabled) },
      { module: this.wards, configure: (a) => this.wards.configure(a.health, a.enabled) },
      { module: this.gear, configure: (a) => this.gear.configure(a.gear, a.enabled) },
      { module: this.stealth, configure: (a) => this.stealth.configure(a.combat, a.enabled) },
      {
        module: this.recoverGear,
        configure: (a) => this.recoverGear.configure(a.movement, a.enabled)
      },
      { module: this.trainLevel, configure: (a) => this.trainLevel.configure(a.train, a.enabled) },
      {
        module: this.hunt,
        configure: (a) => this.hunt.configure(a.hunting, a.walk, a.health, a.enabled)
      },
      { module: this.itemErrand },
      { module: this.questWatch },
      {
        module: this.questRunner,
        configure: (a) => this.questRunner.configure(a.quests, a.enabled)
      },
      { module: this.restAway, configure: (a) => this.restAway.configure(a) },
      { module: this.statScreen, configure: (a) => this.statScreen.configure(a.train, a.enabled) },
      { module: this.keys, configure: (a) => this.keys.configure(a.movement, a.enabled) },
      { module: this.supplies, configure: (a) => this.supplies.configure(a.supplies, a.enabled) },
      { module: this.remotes, configure: (a) => this.remotes.configure(a) },
      { module: this.afk, configure: (a) => this.afk.configure(a.afk, a.enabled) },
      { module: this.heal, configure: (a) => this.heal.configure(a.spells, a.enabled) },
      { module: this.castRound },
      { module: this.potions, configure: (a) => this.potions.configure(a.health, a.enabled) },
      { module: this.cures, configure: (a) => this.cures.configure(a.spells, a.enabled) },
      { module: this.blessings, configure: (a) => this.blessings.configure(a.spells, a.enabled) },
      { module: this.combatLease },
      {
        module: this.invoke,
        configure: (a) => this.invoke.configure(a.enabled && a.spells.invokeItems)
      },
      { module: this.events, configure: (a) => this.events.configure(a.events, a.enabled) },
      { module: this.hangUp },
      { module: this.rowOverrides, configure: (a) => this.rowOverrides.configure(a) },
      { module: this.safety },
      { module: this.fleeGoto },
      { module: this.locating },
      { module: this.travel },
      { module: this.errands }
    ];
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
      this.feed.arrived();
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
      this.paint.afterChunk(at);
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
      this.publisher.patch({});
    });

    this.client.on('close', (graceful) => {
      this.paint.flush();
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
      this.travel.carryJourney(lost);
      /*
       * A walk cannot continue through a closed socket, and leaving it in
       * `walking` means the card reports progress for a route nothing is
       * walking until the step timeout eventually fires. Say so at once.
       *
       * The queue is cleared for the same reason: intents held for a session
       * that has ended would be sent into the *next* one.
       */
      this.walker.stop(t('session.walk.stoppedConnectionClosed'));
      this.dropTyped();
      this.queue.clear();
      // A lent switch is in the player's file; nothing is fighting for it now.
      this.combatLease.end(lost ? 'lost' : 'closed');
      /*
       * The character is no longer in the realm, and saying otherwise is a lie
       * the HUD acts on: it went on reporting vitals and a room for a character
       * whose socket had closed. Identity survives — the offline card and the
       * tab still have a name to show.
       */
      if (this.tracker.leaveRealm()) {
        this.publishCharacter();
        this.publisher.players();
        this.routines.onCharacter(this.tracker.current);
        this.rules.onState(this.tracker.current);
        this.walker.onCharacter(this.tracker.current);
      }
      // A dead link hung up here is still a loss, but the far end did not
      // close it, and saying it did sent the player to blame the realm.
      const detail = graceful
        ? t('session.connection.disconnected')
        : this.hungUpDead
          ? t('session.connection.hungUp')
          : t('session.connection.closedByRemote');
      this.hungUpDead = false;
      /*
       * Who ended it, for the window. `lost` is already the whole test of
       * whether anybody here asked; what it does not say is *which* of the two
       * here asked, and the latch does. Somebody who typed their way out to the
       * BBS menu arrives ungracefully and is still the player.
       */
      const endedBy: ConnectionEnd = lost ? 'realm' : (this.endedBy ?? 'player');
      this.endedBy = null;
      this.publisher.patch({ phase: 'closed', connectedAt: null, detail, endedBy });
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
      this.publisher.patch({ phase: 'error', detail: error.message });
      this.sink.notice(t('session.connection.socketError', { message: error.message }));
    });
  }

  get state(): ConnectionState {
    return this.publisher.state;
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

  get players(): PlayerRegistry {
    return this.tracker.players;
  }

  /**
   * Which lineage's arithmetic the *server* runs, as the wire stated it.
   *
   * Not `CharacterState.realm`, which is the `[MAJORMUD]:` / `[PARADIGM]:`
   * menu prompt — a different fact over a different union, since `paradigm` is
   * a database and there is no Paradigm arithmetic. Exposed for the queries
   * main answers out of the realm file, which have to read a column the way
   * this server reads it. Null until the wire has said.
   */
  get family(): RealmFamily | null {
    return this.vocabulary.family;
  }

  /**
   * This character's level, for a query out of the realm file that has to
   * answer *for this character* — a room spell whose effect the realm gates
   * on level (todo 01). Null until a status line or a sheet has said, which
   * `hazardFor` reads as *keep the whole hazard*.
   */
  get level(): number | null {
    return this.tracker.current.progress.level;
  }

  /** What this character has learned about the realm the data does not have. See `Records`. */
  get learned(): Discovery[] {
    return this.records.learned;
  }

  /** Strikes an observation out because the player says it is wrong. See `Records.forget`. */
  forget(discovery: Pick<Discovery, 'from' | 'command'>): boolean {
    return this.records.forget(discovery);
  }

  /** Strikes a find out because the player says it is wrong. See `Records.forgetFind`. */
  forgetFind(find: Pick<Find, 'room' | 'name'>): boolean {
    return this.records.forgetFind(find);
  }

  /** Everything a search has turned up in this realm. See `RealmFinds`. */
  get foundHere(): Find[] {
    return this.records.found;
  }

  /** What this character has been seen to do about each quest. See `QuestWatch`. */
  get questProgress(): QuestWatched {
    return this.questWatch.watched;
  }

  async connect(target: ConnectionTarget): Promise<ConnectionState> {
    this.telnetLog.length = 0;
    this.lineLog.length = 0;
    this.lineSeq = 0;
    this.tokenizer.reset();
    this.paint.reset();
    this.feed.reset();
    this.classifier.reset();
    this.tracker.reset();
    // Re-seeded from the realm's book, everyone offline: the window is told now.
    this.publisher.players();
    this.statlineReport.reset();
    this.queue.clear();
    this.publisher.forgetSent();
    this.link.reset();
    this.hungUpDead = false;
    this.askedAboutReset = false;
    // A refusal arriving before the new session's first prompt is nobody's.
    this.answering = null;
    for (const { module } of this.modules) module.reset();
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
    const sameRealm =
      this.publisher.state.target !== null && sameTarget(this.publisher.state.target, target);
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
        this.travel.forgetFollowers();
        this.sink.notice(
          t('automation.loops.stopped', { reason: t('session.loop.stoppedRealmChanged') })
        );
      }
      this.travel.realmChanged();
    }
    if (!this.loops.carried) {
      this.loops.reset();
      this.travel.forgetFollowers();
    }
    this.realmMismatchSaid = false;
    this.publisher.reset();
    // Off the list: leaving the realm lands at the menu, where the login has
    // already been made and what the menu said a hang-up costs still holds.
    this.login.reset();
    this.realmMenu.reset();
    this.outbound = '';
    this.playerMove = null;
    this.phaseWas = 'unknown';
    this.realmTold = null;
    this.endedBy = null;
    this.publisher.patch({
      phase: 'connecting',
      target,
      detail: null,
      connectedAt: null,
      endedBy: null
    });
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
      this.publisher.patch({ phase: 'connected', connectedAt: Date.now(), detail: null });
      this.sink.notice(t('session.connection.connected', { host: target.host, port: target.port }));
    } catch (error) {
      const detail = errorMessage(error);
      this.publisher.patch({ phase: 'error', detail });
      this.sink.notice(t('session.connection.failed', { detail }));
    }

    return this.publisher.state;
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
    if (!this.client.connected) return this.publisher.state;
    this.endedBy = by;
    this.publisher.patch({ phase: 'closing' });
    this.client.disconnect();
    return this.publisher.state;
  }

  send(data: string): void {
    /*
     * A pasted run split onto the channel the player has already named.
     *
     * Typing `-` and pasting three lines put `-a`, then `b`, then `c` on the
     * wire: one broadcast and two bare commands said out loud in the room
     * (todo 03). The realm's input line cannot know a paste happened, and the
     * only thing that knows a channel was named is the half-line already on
     * it — which is `this.outbound`, kept here for the queue.
     *
     * Rewritten before anything else looks at `data`, so the tracker, the
     * classifier, the capture and the queue all see the lines that actually
     * reach the socket. `splitOntoChannel` answers `null` for a single line,
     * a run with no channel named and a run whose extra lines are all blank,
     * which is every ordinary keystroke.
     */
    const outgoing = splitOntoChannel(this.outbound, data) ?? data;

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
    for (const ch of editorInput(outgoing)) {
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
        this.safety.noteRealmChoice(command);
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
        this.questWatch.noteSaid(command);
        // A person is at the keyboard: the away clock starts over.
        this.afk.noteAttended();
      } else {
        // The player pressing Return on an empty line reprints the room just
        // as the walker's nudge does, and the block it produces has to be
        // attributed to it for the same reason. Same gate, same door.
        this.tracker.observeReread();
      }
      this.sink.command?.(this.publisher.reportable(command), 'user');
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
    this.client.send(outgoing);

    // A line typed at a closed socket went nowhere, so nothing is owed for it.
    if (committed && this.client.connected) this.link.noteSent();
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
    // And the server holds its answers behind that line, so no claim ages.
    this.tracker.noteTyping(this.outbound.length > 0);
  }

  /**
   * A talk-box line that stands for several commands (todo 04), parsed here
   * again rather than trusted off the wire. Each goes into the queue at the
   * player's own band and out through `send` when its turn comes, one prompt
   * at a time: written at once, fifteen commands fill the realm's queue and
   * the automation behind them is told to slow down (`Intent.typed`).
   */
  sendMacro(line: string): void {
    const steps = parseMacro(line);
    if (steps === null) {
      this.send(`${line}\r`);
      return;
    }
    const count = macroLength(steps);
    const limit = tuning().session.macroCommands;
    if (count > limit) {
      this.sink.notice(t('session.macro.tooMany', { count, limit }));
      return;
    }
    const holding = this.queue.holding;
    if (holding !== null || !this.client.connected) {
      this.sink.notice(
        holding !== null ? t('session.macro.held', { reason: holding }) : t('session.macro.offline')
      );
      return;
    }
    const batch = `macro:${(this.macros += 1)}:`;
    let n = 0;
    for (const step of steps) {
      for (let i = 0; i < step.times; i += 1) {
        n += 1;
        const taken = this.queue.enqueue({
          command: step.command,
          priority: 'user',
          typed: true,
          // Unique per command: a second `s` is a different move.
          coalesceKey: `${batch}${n}`,
          reason: t('session.macro.reason', { line })
        });
        if (!taken) {
          /*
           * The line's own earlier command can close the queue: a `train
           * stats` goes out inside `enqueue` and holds it. What is still
           * waiting of the line goes too; what went out has gone.
           */
          this.queue.cancel((intent) => intent.coalesceKey?.startsWith(batch) === true);
          const reason = this.queue.holding;
          this.sink.notice(
            reason !== null
              ? t('session.macro.restHeld', { command: step.command, reason })
              : t('session.macro.restRefused', { command: step.command })
          );
          this.publisher.publishAutomation();
          return;
        }
      }
    }
    this.publisher.publishAutomation();
  }

  /**
   * What is still waiting of the talk box's lines, gone and said. The box's
   * own Drop, and a death: the rest of a path walked from a temple is a walk
   * nobody asked for.
   */
  dropTyped(died = false): void {
    const count = this.queue.cancel((intent) => intent.typed === true);
    if (count === 0) return;
    // The box's count is read off the snapshot, and nothing else may move soon.
    this.publisher.publishAutomation();
    if (died) {
      this.sink.notice(
        count === 1
          ? t('session.macro.droppedDied.one', { count })
          : t('session.macro.droppedDied.many', { count })
      );
    } else {
      this.sink.notice(
        count === 1
          ? t('session.macro.dropped.one', { count })
          : t('session.macro.dropped.many', { count })
      );
    }
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
  private whereWeStand(room = this.tracker.current.room): string | null {
    return roomAddress(room) ?? room.name;
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
    const here = this.whereWeStand(state.room);
    if (here === null || here === armed.where) return;
    this.playerMove = null;
    this.walker.notePlayerMoved();
    this.loops.notePlayerMoved();
    // And the errand, which is a walk automation chose: the player steering is
    // the one thing it may never argue with.
    this.supplies.notePlayerMoved();
    this.questRunner.notePlayerMoved();
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
    this.combatLease.end('left');
    this.dropTyped();
    this.queue.clear();
    this.playerMove = null;
    this.travel.leftTheRealm();

    // The loop before the walker: stopping a walk calls `ended`, and a loop
    // still running would book that as a failed leg on its way out.
    this.loops.stop(t('session.loop.stoppedLeftRealm'));
    this.walker.stop(t('session.walk.stoppedLeftRealm'));
    this.loops.reset();

    // Everything else that decides on this character's behalf: the list
    // `connect` walks, the walker (stopped above) on it.
    // A refusal arriving before the new session's first prompt is nobody's.
    this.answering = null;
    for (const { module } of this.modules) module.reset();
    this.realmMismatchSaid = false;
    /*
     * The traces stay. They are the record of what was decided just before the
     * character left, and leaving the realm is very often what a player does
     * straight after the thing they want to read about.
     */
    this.publisher.publishAutomation();
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
    this.promptDesign.noteDesign();
    this.errands.forgetPreferred();
    this.queue.configure(automation);
    // The lease first: it knows whether this reload is its own write landing,
    // and combat is told what it says.
    const leaseEdge = this.combatLease.configure(automation);
    this.combat.configure(
      automation.combat,
      automation.enabled,
      automation.spells,
      automation.party,
      leaseEdge
    );
    for (const { configure } of this.modules) configure?.(automation);
    this.loops.configure(automation.health, automation.movement, automation.walk);
    this.login.configure(login);
    this.publisher.useSecret(login.password);
  }

  /**
   * What the realm about to be dialled knows about its players.
   *
   * The host calls this with the *dialled* address before `connect`, because a
   * character can be dialled at a saved realm other than its own and what it
   * learns there is that realm's. The previous realm is unsubscribed first, so
   * a session never absorbs two realms' players at once.
   *
   * What another character on this realm learns about a player lands here and
   * is pushed, so the flyout on this tab says what the realm knows; no module
   * is told, since a fact absorbed is not a fact this character observed.
   */
  useRealm(players: RealmPlayers, belongings: BelongingsSink = NO_BELONGINGS): void {
    this.forgetPlayers();
    // What the realm said it lacks, and its family. See `Vocabulary.forgetRealm`.
    this.vocabulary.forgetRealm();
    this.tracker.useRealm(players);
    // A vault and a kit are the server's, so they are re-keyed with the roster
    // and not with the character. See `SessionHostOptions.belongingsAt`.
    this.tracker.useBelongings(belongings);
    this.belongings = belongings;
    this.forgetPlayers = players.subscribe((batch) => {
      if (this.tracker.absorbPlayers(batch)) this.publisher.players();
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
    this.paint.dispose();
    this.forgetPlayers();
    this.feed.dispose();
    if (this.reconsiderTimer) clearInterval(this.reconsiderTimer);
    this.reconsiderTimer = null;
    this.publisher.dispose();
    this.queue.dispose();
    this.link.dispose();
    for (const { module } of this.modules) module.dispose?.();
    this.client.disconnect();
    this.client.removeAllListeners();
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
    this.paint.lineFramed();
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

    let read: LineRead | null = null;
    try {
      read = readLine(this.classifier, line);
    } catch (error) {
      this.reportParserFault(error);
    }

    this.feed.line(
      line.text,
      line.terminator,
      line.plain,
      read?.block.type ?? null,
      read ? this.marks.markFor(read.block) : undefined,
      read
        ? {
            block: read.block,
            batchWas: read.batchWas,
            batchNow: read.batchNow,
            ...(read.batch ? { closed: read.batch } : {})
          }
        : undefined
    );
    if (!read) return;
    if (read.block.type === 'status-line') this.paint.noteStatusLine(line.plain);

    // The line and the listing it closed, then its tails: `lineActs.ts` has the order.
    try {
      for (const step of actsOf(read)) this.act(step);
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
  private act(step: LineAct): void {
    const { block, batch } = step;
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
      this.publisher.expectPassword();
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
    /*
     * And the exit sentence releases it too (todo 115): `SAVE` prints the
     * suicide-password paragraph and the room *before* the prompt, and the
     * staleness refresh that `user-stats-assigned` triggers (`st` for the
     * sheet the form rewrote) went to a queue still held and was dropped —
     * the client kept the old figures for the session.
     */
    else if (isPrompt(block.type) || block.type === 'user-stats-assigned') this.releaseStatScreen();
    // The one thing that reads the screen, fed every block: the dump, each
    // keystroke's echo, and the sentence the server prints on SAVE alone.
    this.statScreen.onBlock(block);

    // Ahead of the login script, which answers the realm prompt inside its own
    // `onBlock`: the menu has to know it was asked before the answer goes.
    this.realmMenu.onBlock(block);
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
    if (block.type === 'command-not-understood')
      this.vocabulary.noteWordMissing(block.groups['message']);

    this.vocabulary.noteFamily(block, this.answering);

    /*
     * The player's own direction was refused, so nobody moved and nobody took
     * the wheel. Disarmed before the walker sees the block, because the walker
     * may be about to answer the same refusal with an `open` and a step of its
     * own — and the room that follows *that* is the walk's, not the player's.
     *
     * Any `direction-failed` disarms it, even one that belongs to a walk step
     * rather than to the typed move. Both are refusals of a direction with the
     * player's own among the outstanding ones, and this cannot tell which
     * (`Barriers.refusalIsOurs` is the same problem, answered the same
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
    if (block.type === 'user-dies') {
      this.travel.stopGoingAnywhere();
      this.combatLease.end('died');
      this.wards.died();
    }

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
    this.combat.onBlock(block, this.answering);
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
    // The experience figure said again, which is what the next banked level waits for (todo 107).
    this.trainLevel.onBlock(block);
    /*
     * Before `tracker.apply`, deliberately: a wear-off is about to take the
     * buff off the list, and the entry — with the caster's name on it — is
     * the only record of whom to notify.
     */
    this.blessings.onBlock(block, this.tracker.current);
    this.castRound.onBlock(block);
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
    this.publisher.publishAutomation();

    const roomBefore = this.tracker.current.room;
    const fed = applyAct(this.tracker, step);
    // An escape in flight reads what the server said back (todos 06, 813).
    this.travel.settleEscape(block, roomBefore);
    this.fleeGoto.settle(block, this.answering);
    /*
     * A monster's blow on this character, for the rounds `CombatLease` counts.
     * After `apply`: a miss's pattern also fits a sentence about somebody
     * standing here, and only the tracker's vouching puts an attacker on it.
     */
    if (
      block.type === 'mob-hits' ||
      (block.type === 'mob-misses' && this.tracker.current.combat.attackers.length > 0)
    ) {
      this.combatLease.noteMonsterBlow(block.at);
    }
    const changed = fed.line || fed.batch;
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
    if (batch?.type === 'user-inventory') {
      this.deposit.onListing(this.tracker.current);
      // And the quest run and the item errand, which read only the listing
      // their own ask answered.
      this.questRunner.noteListing(this.answering);
      this.itemErrand.noteListing(this.answering);
    }

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
    if (
      block.type === 'room-hidden-items' ||
      // The bare search's empty answer; `to the north` asked about an exit.
      (block.type === 'user-search-failed' && block.groups['direction'] === undefined)
    ) {
      this.records.recordSearch();
    }

    /*
     * And what died, for the quest steps a monster's death runs.
     *
     * After `apply` for the same reason and with one of its own: the tracker is
     * what decides a death happened, so the slot it writes cannot be read
     * before it has run. The room is unchanged by a kill, so `current` is the
     * room the corpse is in either way.
     */
    for (const dead of this.tracker.takeDeaths()) this.questWatch.noteKilled(dead);

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
     * Which command the next answer is about: the realm's own echo
     * (`answeringAfter`). Read here because the refusal is a fact about the
     * wire; a module that proposes a verb is told and decides for itself.
     */
    this.answering = answeringAfter(block, this.answering);
    if (block.type === 'command-no-effect') {
      this.recovery.noteNoEffect(this.answering);
      this.vocabulary.noteNoEffectMissing(this.answering);
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
       * sentence names nothing, and it is what makes this apply to what the
       * queue sent and not to a keystroke: the resend is refused unless the
       * fumbled command is one the queue itself sent, a talk-box line's
       * included.
       */
      this.tracker.noteFumbled(this.answering);
      if (this.queue.resendLast(this.answering)) {
        this.sink.notice(t('automation.queue.fumbledResend', { command: this.answering ?? '' }));
      }
    }
    this.claims.settle(); // After every act, as `replayLine` replays it.
    // Republish only on a real change: during a combat burst most lines say
    // nothing new, and a HUD re-render per line is exactly the stall the
    // architecture exists to prevent. The registry is its own (todo 730).
    this.publisher.players();
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
      this.travel.pickUpAfterLoss(state);
      /*
       * **And nothing at all while the character is on the ground** (todo 20).
       *
       * `You drop to the ground!` is the server saying every command from here
       * is refused (`Player.MortallyWounded` guards the top of `RestCommand`,
       * `HideCommand`, `BashCommand`, the cast path and the rest), and the
       * client went on proposing: *Retreating ne, the way we came: health at
       * -8%*, sent, refused, twice in one run. Every threshold below is a
       * share of maximum and they all keep saying *act, urgently* the further
       * past zero the figure goes.
       *
       * An early return rather than a queue hold, because the queue's hold is
       * one slot and the stat screen owns it — two holds in one slot would
       * release each other. This is also the smaller claim: the player's own
       * keystrokes still go out, exactly as they do under the stat screen's
       * hold, and the only thing standing down is the automation that would
       * spend the budget on refusals. Why quiet helps: `Grounded`.
       */
      if (this.grounded.standsDown(state)) return;
      this.errands.unrefuseWhatTheRoomPrints(state);
      this.statlineReport.noteStatline(state);
      /*
       * Under a timed spell the way in put on the character — the dive into
       * the underwater passage — nothing below but the walk, the escapes and
       * the quest run gets a say (todo 104): a rest, a heal, a search or a
       * fight opened there is a round not spent walking out, and the spell is
       * the deadline. Said once going in and once coming out.
       */
      const passage = this.underTimedSpell(state);
      this.noteMoveOnly(passage);
      const moveOnly = passage !== null;
      this.combat.noteMoveOnly(moveOnly);
      this.routines.onCharacter(state);
      this.rowOverrides.onCharacter(state);
      this.rules.observe({ hangUpClean: this.hangUp.clean(state, Date.now()) });
      this.rules.onState(state);
      this.walker.onCharacter(state);
      this.loops.onCharacter(state);
      // A dark arrival, or a lit room to put the torch out in. Told whether
      // the walker has the character, because a torch is never put out
      // mid-route: the next step may be dark again.
      this.light.onCharacter(state, this.walker.walking);
      // And the ward the room the character stands in wants, when its spell
      // has lapsed (todo 105).
      this.wards.onCharacter(state, roomAddress(state.room));
      // And the key to a way out of this room, off this room's floor.
      this.keys.onCharacter(state);
      this.events.onCharacter(state);
      // Telling a party leader this character has sat down, and that it is up
      // again. A fact about this character, so it goes out with the others.
      this.remotes.onCharacter(state);
      // Running away first, walked and then the realm's teleport (todo 813): both cost
      // nothing, where an unclean disconnect is penalised and can kill outright.
      this.travel.considerEscape(state);
      this.fleeGoto.consider(state);
      // And the walk home a `safe-haven` escape armed, once the fight is over.
      this.travel.walkHomeIfDue(state);
      /*
       * Hit and not moving with auto-combat off lends it (todo 00). After the
       * walker, whose arrival decides first whether a destination keeps it on,
       * and after the escape, which outranks fighting.
       */
      this.combatLease.defend(state, {
        moveOnly,
        escaping: this.travel.escapeUnanswered || this.travel.isRetreating(),
        stoodDown: this.combat.stoodDown,
        movePending: this.tracker.pendingMoves > 0,
        fighting: this.combat.willFight
      });
      if (!moveOnly) {
        // Shopping, which yields to every one of the above: not while running
        // away, not while walking home, not while anything else has the
        // character. See `Supplies.consider`.
        this.supplies.onCharacter(state);
        // And the kit after a death, on the same terms as the errand.
        this.recoverGear.onCharacter(state);
        this.trainLevel.onCharacter(state);
        /*
         * And where the character should be at all, which is the last of the
         * *going somewhere* decisions and rightly so: it only ever acts when
         * nothing else has the character, so anything above that took it has
         * already said so.
         */
        this.hunt.onCharacter(state);
        // And whether the thing a door wants is in the pack yet (todo 07).
        this.itemErrand.onCharacter(state);
      }
      // And the quest run, which drives the errands above one step at a time
      // — and whose leg is what walks the passage, so it is never stood down.
      this.questRunner.onCharacter(state);
      // And the character points, at a trainer, under the switch.
      if (!moveOnly) this.statScreen.onCharacter(state);
      this.safety.considerHangingUp(state);
      /*
       * And fighting *last*, after every escape has had its say: a fight opened
       * in the tick the client decided to run spends the escape and stays in
       * the fight. `retreating` holds for the escape's cooldown, its window.
       */
      this.combat.noteRetreating(this.travel.isRetreating());
      // A step still waiting for its room stands auto-combat down: a fight
      // opened now lands in the room being left. Observed above, off every
      // line, because it is a fact about the wire rather than about the state.
      this.combat.onCharacter(state);
      // Under the passage's spell every routine below stands down: the walk
      // is the one thing that helps, and the walker is already told so.
      if (moveOnly) return;
      /*
       * And sitting down last of all, which is where it belongs rather than
       * beside the retreat it looks like: it is the thing to do when none of
       * the above found anything to do. It refuses in combat by itself, so this
       * needs no guard of its own — but it does need to come after, because a
       * character that has just been told to run is not one to rest.
       */
      // A blessing marked prioritizeOverHeal goes ahead of the heal: the
      // shield a caster dies without outranks the number that is already bad.
      if (!this.travel.isRetreating()) this.blessings.urgent(state);
      // Healing before resting: a number a spell can fix now is not one to sit down over.
      if (!this.travel.isRetreating()) this.heal.onCharacter(state);
      // And a potion beside the spell, under the same guard: nothing is drunk
      // on the way out of a room, because a move in flight is the escape.
      if (!this.travel.isRetreating()) this.potions.onCharacter(state);
      // A cure is a heal chosen by a sentence rather than a number; a buff is
      // the least urgent thing here and refuses combat by itself. Neither on
      // the way out of a room, for the reason above.
      if (!this.travel.isRetreating()) {
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
        // unread purse for itself — never while an errand is carrying cash it
        // has just withdrawn to a shop.
        if (this.supplies.current === null) this.deposit.onCharacter(state);
      }
      /*
       * And the kit, which is not under the escape guard above.
       *
       * Running away is a direction and dressing is not a command spent on the
       * way out of a room: a swap proposed while an escape is in flight is
       * queued behind it in a lower band and answered in the room it lands
       * in, where the situation is asked again. What it must not cross is a
       * move of this client's own, which is the guard it does have.
       */
      if (this.tracker.pendingMoves === 0) {
        this.gear.onCharacter(
          state,
          this.walker.walking || this.loops.progress.status === 'running'
        );
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
  /**
   * The timed passage the character is standing in, or null (todo 104): the
   * realm's own reading (`WorldGraph.spellOver`) of the room, never the
   * spell list, which records what the wire confirmed and the dive's
   * *holding breath* is confirmed by nothing readable.
   */
  private underTimedSpell(state: CharacterState): Corridor | null {
    const here = roomAddress(state.room);
    if (here === null || this.world === undefined) return null;
    return this.world.spellOver(here);
  }

  /** The passage last said, so going in and coming out are each said once. */
  private passageSaid: Corridor | null = null;

  private noteMoveOnly(passage: Corridor | null): void {
    if (passage === this.passageSaid) return;
    if (passage !== null) {
      this.sink.notice(
        t('session.corridor.entered', { spell: passage.name, rooms: passage.rooms })
      );
    } else if (this.passageSaid !== null) {
      this.sink.notice(t('session.corridor.left', { spell: this.passageSaid.name }));
    }
    this.passageSaid = passage;
  }

  private mayRest(): boolean {
    if (this.travel.isRetreating()) return false;
    // Under a timed spell the way in cast, sitting down is drowning (todo 104).
    if (this.underTimedSpell(this.tracker.current) !== null) return false;
    // An escape whose answer has not come is a room the character may still
    // be standing in — the one it just tried to leave (todo 06).
    if (this.travel.escapeUnanswered) return false;
    /*
     * A walk that is *marching* refuses, and a walk that is standing still for
     * health does not — those were one condition until a route learned to wait
     * (`Holds.holdForHealth`, 2026-09-02). Marching and resting undo each
     * other; a held walk is standing still precisely so this can happen, and
     * refusing there would recreate the reported bug from the other side, with
     * the walk waiting for a rest that was waiting for the walk.
     */
    /*
     * And a held walk answers for the loop too: a leg standing still before a
     * trap (`Holds.holdForTrap`, 2026-09-10) is a lap that is not marching,
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
   * The modules here are the ones whose answer can change while the wire
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
    // Before the retreat's early return: a running escape is a step owed, and
    // its probe is the one that most needs to go out on time.
    this.claims.settle();
    if (this.grounded.standsDown(state) || this.travel.isRetreating()) return;
    // The quest run's clocks lapse on a quiet wire; first, as its leg walks a passage
    // nothing else may act in. The item errand's too, but never inside one.
    this.questRunner.onCharacter(state);
    if (this.underTimedSpell(state) !== null) return;
    this.itemErrand.tick(state);
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

  /** Said once per connection; a second `rm` in the same wrong realm adds nothing. */
  private realmMismatchSaid = false;
  /** The prompt row and the listings this player has the client draw itself (`ui.rewrites`). */
  private readonly rewriter = new Rewriter();
  /** The client's own status line in the prompt's place. See `PromptDesign`. */
  private readonly promptDesign: PromptDesign;
  /** What `pro` said the prompt is, said once. See `StatlineReport`. */
  private readonly statlineReport: StatlineReport;
  /** The glyph and the buttons beside a room's name. See `Marks`. */
  private readonly marks: Marks;

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

  /** What this character costs to move, as the router prices it. See `Errands.travellerNow`. */
  travellerNow(state: CharacterState): Traveller {
    return this.errands.travellerNow(state);
  }

  /** What a lap's leg costs to move. See `Errands.lapTraveller`. */
  lapTraveller(state: CharacterState): Traveller {
    return this.errands.lapTraveller(state);
  }

  /** The trainers that will take this character. See `Errands.trainers`. */
  trainers(): TrainerChoice[] {
    return this.errands.trainers();
  }

  /** The order one quest step's items are best fetched in. See `Errands.questErrand`. */
  questErrand(block: number): QuestErrand | null {
    return this.errands.questErrand(block);
  }

  /** The plan to reach one step of a quest from here. See `Errands.questPlan`. */
  questPlan(block: number, marked: number | null): Promise<QuestPlan | null> {
    return this.errands.questPlan(block, marked);
  }

  /** Where this character should hunt. See `Errands.huntingGrounds`. */
  huntingGrounds(radius: number | null, measure: string | null = null): HuntingAdvice {
    return this.errands.huntingGrounds(radius, measure);
  }

  /**
   * Run the plan to one step (todo 102): the card's *Run it*.
   *
   * The plan is drawn afresh here rather than taken from the card, for the
   * reason `walkPlan` redraws a route: it is true from the room it was drawn
   * in, and the press may come a minute later. What the card showed and what
   * is run are the same plan whenever the character has not moved, and the
   * run's own progress says which steps it is on either way. Returns the
   * refusal for the press, or null once it is under way.
   */
  async questRun(block: number, marked: number | null): Promise<string | null> {
    const quest = this.world
      ?.quests()
      .find((each) => each.steps.some((step) => step.block === block));
    if (quest === undefined) return t('automation.quests.refusalUnknownStep', { block });
    const plan = await this.errands.questPlan(block, marked);
    if (plan === null) return t('automation.quests.refusalNoPlan');
    return this.questRunner.start(plan, quest, this.tracker.current);
  }

  /** The card's *Stop*: the run and whatever it started, put down out loud. */
  questStop(): void {
    this.questRunner.stop(t('automation.quests.whyStopped'));
  }

  /** How the quest run is going, for a window that has just attached. */
  get questRunProgress(): QuestRunProgress {
    return this.questRunner.progress;
  }

  /** Collect what the way needs, then walk it. See `Travel.collectThenWalk`. */
  collectThenWalk(
    items: Array<{ id: number; name: string }>,
    route: Route,
    run = false
  ): string | null {
    return this.travel.collectThenWalk(items, route, run);
  }

  /** The press on the plan the panel is showing. See `Travel.walkPlan`. */
  walkPlan(route: Route, run = false): WalkStart {
    return this.travel.walkPlan(route, run);
  }

  /** A route the player asked for, the supply list consulted first. See `Travel.walkRoute`. */
  walkRoute(route: Route, run = false): string | null {
    return this.travel.walkRoute(route, run);
  }

  /** One room back the way the character came. See `Travel.stepBack`. */
  stepBack(confirmed: number | null): MovementStart {
    return this.travel.stepBack(confirmed);
  }

  /** What this character is doing about going anywhere. See `movementOf`. */
  get movement(): Movement {
    return movementOf(this.walker.progress, this.loops.progress);
  }

  /** The one stop, whichever of the two is running. See `Travel.stopMoving`. */
  stopMoving(): void {
    this.travel.stopMoving();
  }

  /** The named loop, or whatever was stopped. See `Travel.startMoving`. */
  startMoving(loopName: string | null, confirmed: number | null): MovementStart {
    return this.travel.startMoving(loopName, confirmed);
  }

  /** A lap the player asked for. See `Travel.startLoop`. */
  startLoop(loop: Loop): MovementStart {
    return this.travel.startLoop(loop);
  }

  /**
   * Stands the arbiter down for as long as a form has the terminal.
   *
   * Cleared rather than paused: what is queued was decided for a character
   * standing in a room, and the character is not standing in one — the server
   * has already run `Player.Exits()` on them. The player's own keystrokes are
   * untouched, as they are everywhere else, and typing into the form is the
   * whole reason they are there; what is left of a talk-box line, which does
   * come through the queue, is dropped and said.
   *
   * Said out loud, once, with the refusal recorded beside every other one: a
   * client that silently stops automating looks exactly like a client that has
   * crashed.
   */
  private holdForStatScreen(because: string): void {
    if (this.queue.holding === null) this.dropTyped();
    if (!this.queue.hold(because)) return;
    this.sink.notice(t('session.stats.held'));
    this.publisher.noteSafety({
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

  /** The decision trace, for a renderer that mounted mid-session. See `Publisher.automation`. */
  get automation(): AutomationSnapshot {
    return this.publisher.automation;
  }

  /**
   * The character to the window, per change and never coalesced, with the
   * room's verdict and asks beside it (`Publisher.character`). The lease is
   * told between the two, where it always has been, and the reset watch last.
   */
  private publishCharacter(): void {
    this.publisher.character();
    this.combatLease.onCharacter(this.tracker.current, this.walker.walking);
    this.publisher.publishAsks();
    this.watchForReset();
    this.locating.onCharacter(this.tracker.current);
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
    this.questWatch.reset();
    this.publishCharacter();
    this.sink.notice(t('session.reset.forgotten'));
    return true;
  }

  /** What this room's occupants answer to, for this character. See `Appraisal.asks`. */
  get asks(): readonly RoomAsk[] {
    return this.appraisal.asks;
  }

  /** The room appraised against the character as it stands. See `Appraisal.verdict`. */
  get verdict(): RoomVerdict {
    return this.appraisal.verdict;
  }

  /** One monster each, by name, for the Reference card. See `Appraisal.appraise`. */
  appraise(names: readonly string[]): Record<string, Verdict> {
    return this.appraisal.appraise(names);
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
