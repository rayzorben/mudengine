/**
 * Owns one live game session: the transport, its observable state, and a
 * bounded diagnostic log. Everything it publishes goes through a sink supplied
 * by the caller, so it has no direct dependency on Electron's IPC.
 */
import { CommandQueue, type Intent } from '../automation/CommandQueue';
import { Routines } from '../automation/Routines';
import { Walker, cannotSneakHere } from '../automation/Walker';
import { splitOntoChannel } from '../../shared/talk';
import {
  CLASS_STEALTH_ABILITY,
  CONFUSE_MESSAGE_ABILITY,
  holdsAbility,
  poisonRefusesRest,
  restsInTheShadows
} from '../../shared/abilities';
import type { AutomationSnapshot, SafetyDecision } from '../../shared/automation';
import { LoginAutomator } from '../automation/LoginAutomator';
import { RuleEngine } from '../automation/RuleEngine';
import { HangUpWatch } from '../automation/HangUp';
import { AutoCombat } from '../automation/AutoCombat';
import { Recovery } from '../automation/Recovery';
import { AutoDeposit } from '../automation/AutoDeposit';
import { ChestOpening } from '../automation/ChestOpening';
import { AutoDrop } from '../automation/AutoDrop';
import { AutoSearch } from '../automation/AutoSearch';
import { AutoLoot } from '../automation/AutoLoot';
import { DeathSummons } from '../automation/DeathSummons';
import { FloorAfterKill } from '../automation/FloorAfterKill';
import { AutoLight } from '../automation/AutoLight';
import { LightAhead } from '../automation/LightAhead';
import { AutoStealth } from '../automation/AutoStealth';
import type { GearRecovery } from '../automation/GearRecovery';
import type { TrainErrand } from '../automation/TrainErrand';
import { StatScreen } from '../automation/StatScreen';
import { RestAway } from '../automation/RestAway';
import { AutoKeys } from '../automation/AutoKeys';
import { Supplies } from '../automation/Supplies';
import { Remotes } from '../automation/Remotes';
import { RecoveredCorpse } from '../automation/RecoveredCorpse';
import { GearLockWatch } from '../automation/GearLockWatch';
import { Afk } from '../automation/Afk';
import { Attendance } from '../automation/Attendance';
import type { RemoteName } from '../../shared/remotes';
import { AutoHeal } from '../automation/AutoHeal';
import type { AutoInvoke } from '../automation/AutoInvoke';
import { ItemCharges } from '../automation/ItemCharges';
import type { Blessings } from '../automation/Blessings';
import type { BlessingChoiceReport } from '../../shared/blessingchoice';
import { CastRound } from '../automation/CastRound';
import { RestSpell } from '../automation/RestSpell';
import { Cures } from '../automation/Cures';
import { PartyCures } from '../automation/PartyCures';
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
import type { OutgrownGear } from '../automation/OutgrownGear';
import { hostTrips, type HostTrips } from './hostTrips';
import { gearDesk, type GearDesk } from './gearDesk';
import { handReach } from './weaponReach';
import { placeDesk, type PlaceDesk } from './placeDesk';
import { questDesk, type QuestDesk } from './questDesk';
import type { AreaSearch } from '../automation/AreaSearch';
import { QuestRunner } from '../automation/QuestRunner';
import { EquipmentManager } from '../automation/EquipmentManager';
import { placeReads } from './placeReads';
import { Wards } from '../automation/Wards';
import { RealmMenu } from './RealmMenu';
import { RowOverrides } from '../automation/RowOverrides';
import { Grounded } from './Grounded';
import { Safety } from './Safety';
import { StatsBaseline } from './StatsBaseline';
import { FleeGoto } from './FleeGoto';
import { Events } from '../automation/Events';
import type { SessionModule } from '../automation/Module';
import type { Loop } from '../../shared/loops';
import {
  roomAddress,
  roomId,
  landingRooms,
  type Corridor,
  type RoomId,
  type Route,
  type WorldSpell
} from '../../shared/world';
import { CharacterTracker } from '../parse/CharacterTracker';
import { Classifier } from '../parse/Classifier';
import { actsOf, applyAct, readLine, type LineAct, type LineRead } from '../parse/lineActs';
import { LineTokenizer, plainText } from '../net/LineTokenizer';
import { DialCancelled, TelnetClient } from '../net/TelnetClient';
import { LinkWatch } from './LinkWatch';
import { isPrompt, type Block } from '../../shared/blocks';
import { type CharacterState, type FightSigns, type SessionPhase } from '../../shared/character';
import { wireItem } from '../../shared/entities';
import type { RouteOptions, Traveller, WorldGraph } from '../world/WorldGraph';
import { Errands, type RealmClass } from './Errands';
import { Claims } from './Claims';
import { Locating } from './Locating';
import { Marks } from './Marks';
import { RealmWordWatch } from './RealmWordWatch';
import { MarkBook, type LineMarks } from './MarkBook';
import { PromptDesign } from './PromptDesign';
import { QuestWatch } from './QuestWatch';
import { Records } from './Records';
import { StatlineReport } from './StatlineReport';
import { ERRAND_LEG, Travel } from './Travel';
import { RemoteMoves } from './RemoteMoves';
import { remoteHangUps } from './remoteHangUps';
import { trainTrip } from './trainPlanner';
import { huntPlanner } from './huntPlanner';
import { legPlanner, stopErrandLeg } from './legPlanner';
import { lightPlanner } from './lightPlanner';
import { outgrownTrip } from './outgrownPlanner';
import { questKeep } from './questKeep';
import { floorGearReader } from './floorGearReader';
import { areaSearchTrip, gearRecoveryTrip } from './collectPlanner';
import { CarryOver } from './CarryOver';
import { UNSTATED_WORDS, Vocabulary, type VocabularyParts } from './Vocabulary';
import { itemPlanner } from './itemPlanner';
import { RoomHazards } from './RoomHazards';
import { droppedNotice } from './macros';
import { MacroRunner } from './MacroRunner';
import { roomNamed, walkTo } from './roomWalk';
import { takeBackAtEnter } from './takeBack';
import { sessionExtensions, type ExtensionDeps } from './extensionWiring';
import type { SessionExtensions } from '../extensions/SessionExtensions';

import { NO_LORE, type RealmLoreView } from '../../shared/lore';
import { NO_SPELL_LORE, type SpellLore } from '../../shared/spell-messages';
import { spellHeals } from '../../shared/spellcraft';
import { NO_SHIPPED_SENTENCES, type ShippedSentences } from '../../shared/sentences';
import {
  NO_REALM_PLAYERS,
  recordOf,
  type PlayerRegistry,
  type RealmPlayers
} from '../../shared/players';
import { NO_RECORD, type CharacterRecord, type KeptRoom } from '../../shared/belongings';
import type { FledEntry } from '../../shared/fled';
import { NO_FIGHTS, type FightSink } from '../../shared/fights';
import { NO_HARM, type HarmSink } from '../../shared/harm';
import type { Discovery, RealmMemory } from '../../shared/memory';
import { NO_FINDS, type Find, type RealmFinds } from '../../shared/finds';
import { NO_SHOPS, type RealmShops } from '../../shared/shops';
import type { QuestWatched } from '../../shared/quests';
import { identityOf, resetSignals } from '../../shared/reset';
import { DEFAULT_INTERNAL, type InternalConfig } from '../../shared/internal';
import type { RealmFamily } from '../../shared/realm';
import { StatScreenHold } from './StatScreenHold';
import { STATUS_LINE } from '../parse/patterns';
import { answeringAfter } from '../parse/echo';
import { TerminalFeed } from './TerminalFeed';
import { Paint } from './Paint';
import { Appraisal } from './Appraisal';
import { editorInput } from './editorInput';
import { fightBook, type SessionOdds } from './OddsBook';
import type { FightSimulator } from '../../shared/simulator';
import { blessingsFor } from './BlessingChoice';
import { Publisher } from './Publisher';
import { Rewriter } from './Rewriter';
import {
  DEFAULT_CONFIG,
  type AutomationConfig,
  type AutomationSwitch,
  type LoginConfig,
  type RewritesUiConfig
} from '../../shared/config';
import { errorMessage } from '../../shared/values';
import { sameTarget } from '../../shared/types';
import { t } from '../app/i18n';
import type {
  ConnectionEnd,
  ConnectionState,
  ConnectionTarget,
  StreamLine,
  TelnetEvent,
  TerminalSize
} from '../../shared/types';
import { tuning } from '../app/tuning';
import { NOT_KEPT, type HuntingAdvice } from '../../shared/hunting';
import type { SessionSink } from './SessionSink';

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
   * Where what this character learns about the realm is kept; an interface, since
   * the file belongs to whoever wired it. Absent in every test and with no realm
   * data, where learning something and forgetting it beats refusing to play.
   */
  readonly memory?: RealmMemory;
  /** Where fights are written down; absent in tests and with `logging.fights` off (`shared/fights.ts`). */
  readonly fights?: FightSink;
  /** What each monster did to the character, kept beside the fights and absent likewise (todo 26). */
  readonly harm?: HarmSink;
  /**
   * What the realm knows about the other players on it, shared by every
   * character dialling the same address. Defaults to a realm that knows
   * nothing, which is what every test wants.
   */
  readonly players?: RealmPlayers;
  /** Where the character's record last placed it, drawn before any dial (`parse/lastRoom.ts`). */
  readonly lastRoom?: KeptRoom | null;
  /** What each marked line in the console is marked with, beside the backscroll; in memory where absent. */
  readonly marks?: LineMarks;
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
  /** Where each counter's `list` is written down, keyed like `finds`. */
  readonly shops?: RealmShops;
  /**
   * The server's own words for an emote and for a monster dying, shipped
   * (`resources/world/actions.csv`, `death-messages.csv`) and shared by
   * every session. Defaulting to none, which reads exactly as the frames
   * alone did.
   */
  readonly sentences?: ShippedSentences;
  /** The realm's own words (`Profile.locate`, `.coins`), read through so a reload lands. */
  readonly words?: VocabularyParts['words'];
  /** The installed extensions, and where their records go (todo 84). Absent in tests. */
  readonly extensions?: ExtensionDeps;
  /** Where fights' trials run: the app's workers; slices on this thread where absent. */
  readonly simulator?: FightSimulator;
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
  /** Whether the realm's word for its data matches the world loaded. See `RealmWordWatch`. */
  private readonly realmWord: RealmWordWatch;
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
  /** The macro running, waiting at a `{goto}` or a `{sneak}` (todo 134). */
  private readonly macros: MacroRunner;
  /** What the realm menu said a hang-up costs on the realm chosen (todo 01), and its name (todo 34). */
  private readonly realmMenu = new RealmMenu((realm) => this.sink.realmChosen?.(realm));
  /** Nothing automated on a character lying mortally wounded. See `Grounded`. */
  private readonly grounded: Grounded;
  /** The arbiter stood down while the stat screen has the terminal. */
  private readonly statHold: StatScreenHold;
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
  /** The room weighed against the character; the client reads it. See `Appraisal`. */
  readonly appraisal: Pick<Appraisal, 'verdict' | 'asks' | 'appraise'>;
  /** Every monster's and lair's fight, run in the background; the map reads it. See `OddsBook`. */
  readonly odds: SessionOdds;
  private automationConfig: AutomationConfig;
  /** What `configure` was last handed, so an extension's layer is laid again over it. */
  private configured: Parameters<SessionManager['configure']>;
  /** Each installed extension's session (todo 84). See `SessionExtensions`. */
  readonly extensions: SessionExtensions;
  private readonly login: LoginAutomator;
  private readonly recovery: Recovery;
  private readonly loot: AutoLoot;
  private readonly deathSummons: DeathSummons;
  private readonly drop: AutoDrop;
  /** Looking for what a room did not print. See `AutoSearch`. */
  private readonly search: AutoSearch;
  private readonly deposit: AutoDeposit;
  private readonly chest: ChestOpening;
  /** Readying a light before the dark. See `AutoLight`. */
  private readonly light: AutoLight;
  /** Getting back into the shadows between fights. See `AutoStealth`. */
  private readonly stealth: AutoStealth;
  /** Going back for the kit after a death. See `GearRecovery`. */
  private readonly recoverGear: GearRecovery;
  private readonly corpse: RecoveredCorpse;
  /** The saved gear held from a death until the corpse is recovered (todo 82). */
  private readonly gearLocks: GearLockWatch;
  /** Going to collect the level when the experience is there — todo 18. */
  private readonly trainLevel: TrainErrand;
  /** Stashing, selling or dropping gear the character has outgrown — todo 12. */
  private readonly outgrown: OutgrownGear;
  readonly hostTrips: HostTrips;
  /** The Gear and Quests cards' questions, and the places that take this character (todo 70). */
  readonly gearDesk: GearDesk;
  readonly questDesk: QuestDesk;
  readonly places: PlaceDesk;
  readonly areaSearch: AreaSearch;
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
  readonly supplies: Supplies;
  private readonly remotes: Remotes;
  private readonly roomHazards: RoomHazards;
  readonly statsBaseline: StatsBaseline;
  private readonly attendance: Attendance;
  private readonly afk: Afk;
  private readonly heal: AutoHeal;
  private readonly castRound: CastRound;
  private readonly potions: Potions;
  private readonly cures: Cures;
  private readonly restSpell: RestSpell;
  /** Blessings kept up by events on this character and the party. */
  private readonly blessings: Blessings;
  /** Asking a carried item for the blessing it can cast. See `AutoInvoke`. */
  private readonly invoke: AutoInvoke;
  /** The uses left on each charged item carried (todo 44), read by the use and the cash run. */
  readonly charges: ItemCharges;
  /** What Auto Choose Blessings last decided, for the Spells page. */
  readonly blessingChoice: BlessingChoiceReport;
  readonly loops: LoopRunner;
  /**
   * The character's own persisted record, as `useRealm` handed it over — the
   * same instance the tracker writes through. Held here so the blessing
   * watchdog can read the measured durations at the point of use.
   */
  private belongings: CharacterRecord = NO_RECORD;

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
  /** What this character writes down about the realm: ways through, finds and shops. See `Records`. */
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
  /** What was underway, kept in the character's record across a relaunch. See `CarryOver`. */
  private readonly carryOver: CarryOver;

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
      harm = NO_HARM,
      players = NO_REALM_PLAYERS,
      spellLore = NO_SPELL_LORE,
      finds = NO_FINDS,
      shops = NO_SHOPS,
      sentences = NO_SHIPPED_SENTENCES,
      words = UNSTATED_WORDS,
      marks = new MarkBook({ lines: DEFAULT_CONFIG.terminal.scrollback })
    } = deps;
    const notice: SessionSink['notice'] = (message, decision) => sink.notice(message, decision);
    this.tracker = new CharacterTracker(
      world,
      lore,
      (discovery) => this.records.remember(discovery),
      fights,
      players,
      spellLore,
      deps.lastRoom,
      harm
    );
    this.records = new Records({ tracker: this.tracker, world, memory, finds, shops }, sink);
    this.questWatch = new QuestWatch({ tracker: this.tracker, world }, sink);
    // Before `useRealm`, which tells it the family is unread again.
    this.errands = new Errands(
      { world, tracker: this.tracker, fightRecord: fights, lore },
      {
        config: () => this.automationConfig,
        rates: () => this.belongings.recallHuntRates(),
        family: () => this.vocabulary.family,
        watched: () => this.questWatch.watched,
        odds: () => this.odds,
        askAbilities: (state) => this.routines.askAbilities(state),
        backstabWeapon: () => this.gear.backstabWeapon(this.tracker.current),
        roomCoded: (code) => sink.roomCoded?.(code) ?? null,
        notice
      }
    );
    // A room's own spell against this character: a way's stoppers, a rest refused, a room walled.
    this.roomHazards = new RoomHazards({ world, tracker: this.tracker, errands: this.errands });
    this.vocabulary = new Vocabulary(
      { tracker: this.tracker, errands: this.errands, world, words },
      {
        locateRefused: () => [this.claims, this.locating].forEach((it) => it.locateRefused()),
        notice
      }
    );
    const tally = () => this.tracker.current.tally;
    this.statsBaseline = new StatsBaseline(tally, (base) => this.sink.statsBase?.(base), notice);
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
       * And how this realm's monsters die: what its own wire taught (todo 04) **beside** the
       * server's own table, which may name several (2026-09-14); the room settles it or
       * nothing does (`Classifier.asDeathSentence`).
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
      // And the rows a confusing spell prints on a fumble, in the realm's words.
      (row) => world?.spellsByMessage(CONFUSE_MESSAGE_ABILITY).has(row) ?? false,
      () => this.vocabulary.coins,
      (spell) => spellHeals(world?.spellNamed(spell))
    );
    this.world = world;
    this.realmWord = new RealmWordWatch(world, sink);
    this.promptDesign = new PromptDesign(
      { tracker: this.tracker, rewriter: this.rewriter },
      { notice }
    );
    this.statlineReport = new StatlineReport({ notice });
    this.marks = new Marks(
      { tracker: this.tracker, world, book: marks },
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
            wearer: this.errands.wearer()
          }),
        marks
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
    this.configured = [automation, login];
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
        // The arbiter's own `train stats` arms the hold as a typed one does. Safe
        // inside this callback: one drain sends one command, and the hold empties
        // what it would have scheduled next.
        this.statHold.noteSent(command, Date.now());
        this.statScreen.noteSent(command, 'automation');
        // `intent.secret` is the login's own answer about *this* command; the
        // latch below is about the last prompt, and the queue may hold the two
        // apart. See `Intent.secret`.
        const reported = this.publisher.reportable(command, intent.secret === true);
        this.sink.command?.(reported, 'automation');
        this.noteSent(command, 'automation', intent.decision);
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
      notice,
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
    const portraits = (): boolean => sink.portraits?.() ?? false;
    const realmSpeed = (): number => this.errands.realmSpeed;
    const fled = (): readonly FledEntry[] => this.belongings.recallFled();
    // Under a timed spell the way in cast, the walk moves and nothing else does (todo 104).
    const moveOnly = (state: CharacterState): boolean => this.underTimedSpell(state) !== null;
    const signs: FightSigns = {
      monsterSwung: (at) => this.hangUp.monsterSwung(at),
      quarry: (state) => this.combat.quarry(state)
    };
    this.routines = new Routines(automation, this.queue, {
      ...{ notice, onTheGround, portraits, roomLook: sink.roomLook },
      idle: () => !this.travel.goingSomewhere()
    });

    // `abandon` is a loss: `close` reports `graceful` false, so the loop is held.
    this.link = new LinkWatch({
      notice,
      hangUp: () => {
        this.hungUpDead = true;
        this.client.abandon();
      }
    });

    // What the light, errands and travel tell the session: a console line, a safety decision.
    const moveInFlight = (): boolean => this.tracker.pendingMoves > 0;
    const reports = {
      notice,
      decided: (decision: SafetyDecision): void => this.publisher.noteSafety(decision)
    };
    // A route offers the command queue one verified step at a time, like everything else.
    this.walker = new Walker(automation, this.queue, {
      realmSpeed,
      ended: (arrived, reason) => {
        this.travel.walkEnded(arrived);
        const trips = [this.loops, this.supplies, this.recoverGear, this.trainLevel, this.outgrown];
        const later = [this.hostTrips, this.areaSearch, this.hunt, this.questRunner, this.macros];
        for (const each of [...trips, ...later])
          each.onWalkEnded(arrived, reason, this.tracker.current);
      },
      stepping: (command, direction, to, landing) => {
        this.remotes.stepping(command, direction, to, this.tracker.current, landing);
        if (landing !== undefined && direction !== 'portal') {
          // An exit whose cast moves the character answers with two room blocks, the exit
          // table's and the spell's: both are this command's (`Expectations.hintCast`).
          this.tracker.hintCast(command, direction, landingRooms(landing));
          return;
        }
        if (direction === 'portal') {
          // A scripted teleport lands by the script's coordinates, never by an exit;
          // `to` is `map/room` by construction, parsed rather than trusted.
          const target = /^(\d{1,3})\/(\d{1,6})$/.exec(to);
          if (target) {
            this.tracker.hintTeleport(command, Number(target[1]), Number(target[2]));
          }
          return;
        }
        this.tracker.hintMove(command, direction);
      },
      ...this.errands.walkFacts(),
      // Every walk supersedes a journey owed from a lost connection; only an asked one is recent.
      destination: (room, name) => {
        if (this.travel.startingAskedWalk) this.sink.destination?.(room, name);
        this.travel.walkStarted();
      },
      // The tracker's queue: the typed moves and leftover legs a route cannot see.
      pendingMoves: () => this.tracker.pendingMoves,
      // A rest or a floor read asked and unanswered is a move in flight (todo 14; 814).
      restInFlight: () => this.recovery.restInFlight,
      floorInFlight: () => this.loot.floorInFlight,
      onTheGround,
      /*
       * A route that stood still for a fight plans again from wherever the fight left the
       * character: the answer needs the realm graph, the purse and the refused edges.
       */
      replan: (to, kind) => this.travel.replan(to, kind),
      moveOnly,
      // Where a draw put the character, when the room cannot say (`WalkerEvents.locate`).
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
      routeBetween: (from, to, kind) => this.errands.routeBetween(from, to, kind),
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
      beforeStep: (ahead, state) => {
        this.search.beforeStep(state);
        this.gear.beforeStep(state);
        this.light.beforeStep(ahead, state);
      },
      // And the ward the room ahead wants, off the pack (todo 105).
      wardFor: (to, state) => this.wards.beforeStep(to, state),
      // Whether a fight here is one auto-combat will fight: the walk waits out
      // nothing else (`Holds.canEndAFight`), and never past an escape's move.
      willFight: () => this.combat.wouldFight,
      escaping: () => this.travel.escapeUnanswered || this.travel.isRetreating(),
      // A light coming for this room, which a walk waits on; asked, as this runs after the walker.
      lightComing: (state) => this.light.couldReady(state),
      regrouping: (state) => this.remotes.regrouping(state),
      keyToUse: (keyId) => this.errands.keyToUse(keyId),
      askHand: (name, job, direction) => this.remotes.askHand(name, job, direction),
      notice,
      progress: (progress) => {
        // The Combat Stats' `Moving` clock: only the walker knows a route is in progress.
        this.tracker.noteMoving(progress.status === 'walking');
        this.carryOver.remember();
        this.sink.walk?.(progress);
      }
    });

    this.combat = new AutoCombat(
      automation.combat,
      automation.enabled,
      this.queue,
      {
        notice,
        // The choice found no book read: the routines ask once (todo 09).
        needBook: () => this.routines.askBook(this.tracker.current),
        // The round beat: the gear's off-round invocation (todo 00), the party listing (831).
        round: (state) => [this.gear, this.routines].forEach((it) => it.round(state)),
        // The trace, not the console: a refusal happens in every corridor (the Automation card).
        decided: (decision) => this.publisher.noteEngagement(decision),
        reach: handReach(
          this.errands,
          () => this.world,
          () => this.gearDesk.reads
        ),
        wield: (state, weapon, target) => this.gear.wieldFor(state, weapon, target),
        // The class row's `ClassStealth` (a Thief also has `Stealth`, todo 28); null never refuses.
        canHide: () => holdsAbility(this.errands.capabilities(), CLASS_STEALTH_ABILITY),
        // The words fought with, typed or chosen (todo 47).
        attackWord: (target) => this.errands.words.attack([target]).verb,
        openerWord: () => this.errands.words.opener(),
        onTheGround,
        realmSpeed
      },
      automation.spells,
      (name) => this.world?.spellNamed(name) ?? null,
      // The class, read at use (a sheet names it), on the server's family (`Vocabulary.noteFamily`).
      () => this.errands.realmClass(),
      lore,
      (id) => this.world?.spellById(id) ?? null,
      { fled }
    );

    // Sitting down: the run is `emergency` and this `probe`, so under both it runs, then rests.
    this.recovery = new Recovery(automation, this.queue, {
      notice,
      // GreaterMUD refuses `rest` while poisoned unless immune (`RestCommand.cs:28`; a Kang
      // is, todo 22): the server's branch, so a MajorMUD server on its realm has none.
      poisonRefusesRest: () =>
        poisonRefusesRest(this.errands.capabilities(), this.vocabulary.family),
      beforeRest: (state, restTo) => this.restSpell.beforeRest(state, restTo),
      roomHurts: (state) => this.roomHazards.hurtsHere(state),
      decided: reports.decided,
      signs
    });
    // Rows read at use (`this.world` comes with `useRealm`); the kill's room read is shared (57).
    const floor = new FloorAfterKill(this.queue, this.tracker, () => this.loot.taking());
    this.loot = new AutoLoot(automation.loot, automation.supplies, automation.enabled, this.queue, {
      realmItem: (name) => this.world?.buildItemEntity(name) ?? wireItem(name),
      notice,
      onTheGround,
      moveOnly,
      floor,
      coinWord: (coin) => this.vocabulary.coins.word(coin),
      floorGear: floorGearReader(this.world, this.errands, () => this.automationConfig)
    });
    this.deathSummons = new DeathSummons(floor);
    /*
     * The light, asked by the walker before every step (`beforeStep`) and by
     * the state on every arrival. Its refusals go to the safety trace, because
     * a torch not lit in a dark room is a decision somebody will ask about.
     */
    /*
     * And the ward a room wants, kept up off the pack (todo 105): the realm names the spell that
     * stops a room's effect and the item whose use casts it, used before the step and when the
     * spell lapses, on its own clock at the realm's speed. The stated countdowns are the router's.
     */
    this.wards = new Wards(
      automation.health,
      automation.enabled,
      this.queue,
      {
        hazardAt: (room) => this.errands.hazardAt(room),
        itemsCasting: (spell) => this.world?.itemsCasting(spell) ?? [],
        spellById: (id) => this.world?.spellById(id) ?? null,
        spellsUp: (state) => this.errands.spellsUp(state),
        realmSpeed
      },
      { notice }
    );
    this.light = new AutoLight(automation.movement, automation.enabled, this.queue, {
      ...reports,
      escaping: () => this.travel.isRetreating(),
      moveInFlight
    });
    /*
     * The shadows, asked for between fights. Told whether a lap or a route
     * has the character, because the answer is a different command: `sn` for
     * the step ahead, `hide` for standing still.
     */
    this.stealth = new AutoStealth(automation.combat, automation.enabled, this.queue, {
      notice,
      escaping: () => this.travel.isRetreating(),
      moving: () => this.walker.walking || this.loops.progress.status === 'running',
      moveInFlight,
      openerRefused: () => this.combat.openerRefused(),
      opener: () => this.errands.words.opener(),
      // Whether resting and hiding undo each other, off the realm's class row (Paradigm grants
      // `ShadowHome` to seven classes, MajorMUD none); the family gates GreaterMUD's behaviour.
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
        notice,
        escaping: () => this.travel.isRetreating(),
        /*
         * Standing still, which here means two facts. A move on the wire makes
         * `state.room` the room being *left*, so its floor belongs to
         * somewhere else — the refusal `Walker.start` and `LoopRunner.advance`
         * both make. A walk marching sends its step from the `movement` band,
         * which outranks the `probe` this proposes in, so a `get` behind it is
         * spent in the room after this one.
         */
        busy: () => moveInFlight() || this.walker.walking
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
     * The errand. Its planner is the loop's own (route planner, walker, moves
     * outstanding), plus whether something else has the character and a hold.
     */
    this.supplies = new Supplies(
      automation.supplies,
      automation.enabled,
      this.queue,
      {
        ...legPlanner(() => legs()),
        shopRoom: (item, passOver) => this.errands.shopRoom(item, passOver),
        priceAt: (item, shop) => this.errands.priceAt(item.name, shop),
        weightAt: (item, shop) => this.errands.weightAt(item.name, shop),
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
          // A trip, unsaid and not picked up after a fight: `Supplies` starts
          // afresh from the next pack listing, which is what it was ever about.
          this.walker.start(route, this.tracker.current, {
            ...ERRAND_LEG,
            quiet: true,
            resumeAfterFight: false
          }),
        walkingTo: () => this.walker.remaining.at(-1)?.to ?? null,
        busy: () => this.travel.isRetreating() || this.travel.retreatArmed,
        release: releaseErrand
      },
      reports
    );
    // And a light bought before the dark (todo 11), for a route, a lap or a trainer's trip.
    const light: LightAhead = new LightAhead(
      () => this.automationConfig,
      lightPlanner(() => legs()),
      reports
    );
    /*
     * And the trips to collect the level (todo 18) and to get rid of outgrown
     * gear (todo 12), the one thing an unattended client has to do and the
     * pack it fills: a leg's options, and the lap held rather than ended.
     */
    const legs = () => ({
      ...{ tracker: this.tracker, errands: this.errands, walker: this.walker, loops: this.loops },
      ...{ travel: this.travel, itemErrand: this.itemErrand, world: this.world, light },
      ...{ vocabulary: this.vocabulary, combat: this.combat, loot: this.loot },
      ...{
        deposit: this.deposit,
        questWatch: this.questWatch,
        signs,
        roomHazards: this.roomHazards
      }
    });
    const config = () => this.automationConfig;
    const charges = (this.charges = new ItemCharges(this.queue, () => this.world, config));
    const trip = { modules: legs, release: releaseErrand, charges, kept: questKeep(legs), config };
    // The gear after a death, a fetch from a stash and the area: walks and searches (`Collect`).
    const escaping = () => this.travel.escaping;
    this.recoverGear = gearRecoveryTrip(automation, this.queue, reports, {
      ...trip,
      busy: escaping
    });
    this.corpse = new RecoveredCorpse(automation, this.queue, () => this.tracker.current, reports);
    const releaseLocks = (slots: readonly string[], at: number): boolean => {
      const freed = this.tracker.releaseGearLocks(slots, at);
      if (freed) this.publishCharacter();
      return freed;
    };
    this.gearLocks = new GearLockWatch(automation.movement, releaseLocks, reports);
    const held = () => this.errandHeld();
    const tripReports = { ...reports, gearTrip: sink.gearTrip?.bind(sink) };
    this.hostTrips = hostTrips(automation, this.queue, tripReports, { ...trip, busy: held });
    this.areaSearch = areaSearchTrip(automation, this.queue, reports, { ...trip, busy: held });
    this.trainLevel = trainTrip(automation, this.queue, reports, trip);
    this.outgrown = outgrownTrip(automation, this.queue, reports, {
      ...{ ...trip, busy: held }
    });
    /*
     * And where the character should be at all (todo 05): the survey's best
     * lair within reach, walked to as a journey the card draws and then run as
     * a loop that is filed nowhere. Its planner is the errand's, with one
     * difference that is the whole point — the walk is a **route the player
     * asked for** rather than a leg, because a lair three maps away is a
     * journey and a journey drawn as nothing is a character crossing the realm
     * under a card that says *stopped*.
     */
    const hunting = { modules: () => ({ ...legs(), belongings: this.belongings }), stopLap };
    this.hunt = new AutoHunt(
      automation.hunting,
      automation.walk,
      automation.health,
      automation.enabled,
      huntPlanner({ ...hunting, busy: () => this.errandHeld() }),
      reports
    );
    /*
     * And going to get the thing a door wants (todo 07): bought where the
     * realm names a counter, hunted where it names a monster, and the route
     * the player asked for walked once the pack holds it.
     */
    this.itemErrand = new ItemErrand(
      itemPlanner({
        modules: () => ({
          tracker: this.tracker,
          errands: this.errands,
          supplies: this.supplies,
          loops: this.loops,
          travel: this.travel,
          loot: this.loot,
          walker: this.walker,
          queue: this.queue,
          questWatch: this.questWatch,
          combat: this.combat
        }),
        stopLap,
        config: () => this.automationConfig,
        notice
      }),
      reports
    );
    /*
     * And carrying a quest's plan (todos 102–103): the errands above, the walker
     * and auto-combat, driven a step at a time by the plan the card drew. Its
     * legs are an errand's (quiet, held for health, not owed across a lost
     * connection) and it holds the lap as the errands do. */
    this.questRunner = new QuestRunner(
      automation.quests,
      automation.enabled,
      this.queue,
      {
        ...legPlanner(() => legs()),
        /*
         * `abil` is GreaterMUD's alone, and the family is told by the banner
         * or by the listing having answered at all: a realm that has printed
         * its counters once prints them.
         */
        printsCounters: () =>
          this.vocabulary.family === 'greatermud' || this.tracker.current.abilities !== null,
        stopWalking: (reason) => stopErrandLeg(legs(), reason),
        busy: () => this.travel.escaping,
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
        combatOn: () => this.combat.switchedOn,
        warding: (on) => this.wards.lend(on),
        said: (command) => this.questWatch.noteSaid(command),
        watched: () => this.questWatch.watched
      },
      { ...reports, progress: (progress) => this.sink.questRun?.(progress) }
    );
    // And where a rest is taken: next door to a lair on a short clock (`Rooms.Delay`, as
    // `huntingGrounds` reads it) or a room whose spell hurts, in a neighbour looked into first.
    this.restAway = new RestAway(
      automation,
      this.queue,
      {
        here: () => roomAddress(this.tracker.current.room),
        lairClock: (room) => this.errands.lairClock(room),
        neighbours: (room) => this.errands.neighbours(room),
        roomHurts: (room) => this.roomHazards.roomHurts(room),
        moveInFlight,
        walking: () => this.walker.walking && this.walker.holding === null,
        looping: () => this.loops.progress.status === 'running',
        stayingReason: () => this.travel.stayingReason(this.tracker.current),
        busy: () => this.travel.escaping
      },
      reports
    );
    // And the character points, on the one screen the queue stands down for: the driver
    // writes past the queue, since the hold refuses every intent while the form is up.
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
        byExp: (state, current, limits) => this.errands.statsByExp(state, current, limits),
        write: (bytes) => {
          this.client.send(bytes);
          this.sink.command?.(bytes.replace(/\r?\n$/, ''), 'automation');
        }
      },
      reports
    );
    // And its opposite number: what the loot hoarded, the drop list sheds.
    this.drop = new AutoDrop(automation.drop, automation.enabled, this.queue, trip.kept, reports);
    this.search = new AutoSearch(automation.search, automation.enabled, this.queue, {
      stateNow: () => this.tracker.current,
      signs,
      moveInFlight,
      standsDown: (state) => moveOnly(state) || this.travel.isRetreating()
    });
    // And the purse over the threshold, banked at the resolved room's own counter, never by
    // its name: thirteen rooms can share one, and a `deposit` outside a bank is said out loud.
    this.deposit = new AutoDeposit(
      automation.banking,
      automation.enabled,
      this.queue,
      // The counter here as the realm's shop row, null off a bank, so *not your bank* can be said.
      (state) => {
        const at = roomAddress(state.room);
        const here = at === null ? undefined : this.world?.byId(at);
        if (!here || here.shop === undefined) return null;
        return this.world?.shop(here.shop)?.kind === 'bank' ? here.shop : null;
      },
      // A press that banks nothing has to say why, or it is indistinguishable
      // from a button that does not work — which is what it was.
      { notice }
    );
    this.chest = new ChestOpening(this.queue, { notice });
    /*
     * The other half of running several characters at once: `@health` over a
     * telepath costs no command, where the party roster costs one and gives a percentage.
     */
    // Whether anybody is at the keyboard: the telepath reply, the hang-up and the trace (todo 79).
    this.attendance = new Attendance(automation.afk.afterMinutes, () =>
      this.publisher.publishAutomation()
    );
    this.afk = new Afk(automation.afk, automation.enabled, this.queue, this.attendance, this.sink);
    // Write a switch to the character's file and read it back (`switchAutomationNow`).
    const switchNow = (name: AutomationSwitch, on: boolean): boolean =>
      this.sink.switchAutomationNow?.(name, on) ?? false;
    this.remotes = new Remotes(automation, this.queue, {
      notice,
      ...new RemoteMoves(this, this.errands, notice, {
        own: () => this.automationConfig.loops,
        shelf: () => sink.loopShelf?.() ?? []
      }).events,
      ...remoteHangUps(() => this.safety, sink),
      peer: (who) => recordOf(this.tracker.players, who),
      pace: (who, ready) => this.travel.pace(who, ready),
      switchAutomation: switchNow,
      // On their registry entry, which the Player card reads; pushed now, as nothing else moved.
      commanded: (from, raw, at) => {
        if (this.tracker.noteRemoteCall(from, raw, at)) this.publisher.players();
      },
      // A blessed party member says the spell wore off; recast on the event.
      blessExpired: (from, spell) => this.blessings.onPeerExpired(from, spell),
      stats: this.statsBaseline,
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
      // Which client a player runs, on their registry entry, pushed for `commanded`'s reason.
      clientNamed: (from, client, extended) => {
        const facts = { ...(client === undefined ? {} : { client }), extendedRemotes: extended };
        if (this.tracker.noteRemoteClient(from, Date.now(), facts)) this.publisher.players();
      },
      handAnswered: (from, answer) => this.walker.handAnswered(from, answer),
      placed: (from, map, room, name) => {
        const address = roomId(map, room);
        this.sink.notice(
          t('session.remotes.peerPlaced', {
            who: from,
            address,
            room: name ?? t('session.remotes.peerPlacedUnnamed')
          })
        );
        if (this.tracker.noteRemoteRoom(from, address, name, Date.now())) this.publisher.players();
      }
    });
    // One realm lookup for every caster, handing over the realm's whole row, read at the point of use.
    const realmSpell = (name: string): WorldSpell | null => this.world?.spellNamed(name) ?? null;
    this.castRound = new CastRound(reports, undefined, realmSpeed);
    this.heal = new AutoHeal(
      automation.spells,
      automation.enabled,
      this.queue,
      undefined,
      realmSpell,
      { notice },
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
      { notice },
      this.castRound,
      new PartyCures(automation.spells, automation.enabled, {
        queue: this.queue,
        realmSpell,
        gate: this.castRound,
        notice,
        family: () => this.vocabulary.family
      })
    );
    this.restSpell = new RestSpell(automation, this.queue, {
      realmSpell,
      realmClass: () => this.errands.realmClass(),
      speed: realmSpeed,
      notice,
      gate: this.castRound
    });
    // Which kit, with the room's armour; slot and hands are the pack's row (`realmSlot`) first.
    this.gear = new EquipmentManager(
      automation.gear,
      automation.enabled,
      this.queue,
      {
        ...placeReads(() => this.world, this.errands),
        slotOf: (name) => this.errands.gearSlotOf(name),
        handsOf: (name) => this.errands.gearHandsOf(name),
        opensWithBackstab: (weapons) => this.combat.opensWithBackstab(weapons),
        yieldSwap: () => this.invoke.yieldHand(),
        wantsRest: (state) => this.recovery.wouldRest(state) && this.mayRest(),
        wearer: () => this.errands.wearer(),
        refusesBackstabWith: (weapon) => this.combat.refusesBackstabWith(weapon)
      },
      { notice }
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
          return this.errands.planFromHere(roomId(found.map, found.room), {}, 'lap');
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
            kind: 'lap'
          }),
        moveInFlight,
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
        // Where the character stands as the lap stops (`LoopRunner.stoppedIn`).
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
        notice,
        progress: (progress) => {
          this.travel.noteLap(progress);
          this.carryOver.remember();
          this.sink.loop?.(progress);
        },
        locate: () => this.claims.askWhereIAm(),
        lapBegun: (stopName) => this.statsBaseline.lapBegun(stopName),
        wantsCombat: () => this.travel.combatOnForLap()
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
    // Built once every module it drives exists; its callbacks run only after the constructor.
    this.travel = new Travel(
      {
        tracker: this.tracker,
        world,
        errands: this.errands,
        queue: this.queue,
        walker: this.walker,
        loops: this.loops,
        combat: this.combat,
        supplies: this.supplies,
        trainLevel: this.trainLevel,
        ...{ outgrown: this.outgrown, recoverGear: this.recoverGear, remotes: this.remotes },
        roomHazards: this.roomHazards,
        ...{ hostTrips: this.hostTrips, areaSearch: this.areaSearch },
        hunt: this.hunt,
        itemErrand: this.itemErrand,
        questRunner: this.questRunner,
        light
      },
      {
        config: () => this.automationConfig,
        movement: () => this.movement,
        loopNamed: (name) => this.loopNamed(name),
        dropTyped: (died) => this.dropTyped(died),
        fled,
        keepFled: (entries) => this.belongings.rememberFled(entries),
        driven: () => this.extensions.driving,
        hangUpTakesOver: (state) => this.safety.takesOver(state),
        switchAutomation: switchNow,
        ...reports
      }
    );
    this.carryOver = new CarryOver(this.loops, this.travel, () => this.belongings);
    this.claims = new Claims(
      {
        tracker: this.tracker,
        queue: this.queue,
        combat: this.combat,
        vocabulary: this.vocabulary
      },
      { notice }
    );
    this.locating = new Locating({ tracker: this.tracker, claims: this.claims }, sink);

    // Rules propose; the queue disposes. Nothing here reaches the socket.
    this.rules = new RuleEngine(this.queue, { notice, onTheGround });
    this.rules.load(automation.rules, automation.combat.mobRules);

    const book = fightBook(
      { tracker: this.tracker, world, errands: this.errands, blessings: () => this.blessings },
      { config: () => this.automationConfig, ran: () => this.publisher.publishVerdict() },
      deps.simulator
    );
    this.odds = book.odds;
    ({
      blessings: this.blessings,
      invoke: this.invoke,
      choice: this.blessingChoice
    } = blessingsFor(
      { tracker: this.tracker, world, errands: this.errands, ...book, hunt: this.hunt },
      {
        ...{ queue: this.queue, realmSpell, onTheGround, castGate: this.castRound, signs, charges },
        due: this.hostTrips,
        durations: () => this.belongings.recallSpellDurations()
      },
      { ...reports, config: () => this.automationConfig },
      automation
    ));
    this.appraisal = new Appraisal(
      { tracker: this.tracker, world, errands: this.errands, ...book },
      { config: () => this.automationConfig, watched: () => this.questWatch.watched }
    );
    this.publisher = new Publisher(
      {
        tracker: this.tracker,
        appraisal: this.appraisal,
        ...{ queue: this.queue, times: this.walker.times },
        ...{ rules: this.rules, client: this.client, attendance: this.attendance }
      },
      { config: () => this.automationConfig, extensions: () => this.extensions },
      sink
    );
    this.grounded = new Grounded(this.publisher, sink);
    this.macros = new MacroRunner({
      send: (data) => this.send(data),
      queue: this.queue,
      connected: () => this.client.connected,
      notice,
      published: () => this.publisher.publishAutomation(),
      state: () => this.tracker.current,
      mob: (state) => this.combat.pick(state),
      automation: () => this.automationConfig,
      keys: () => sink.keys?.() ?? {},
      aliasFile: () => sink.aliasFile?.() ?? null,
      movesPending: moveInFlight,
      sneakBlocked: cannotSneakHere,
      roomNamed: (request) => roomNamed(request, this.errands),
      // The player's own route, as the palette's Go to walks it.
      walkTo: (at) => walkTo(at, this.errands, (way) => this.travel.walkForPlayer(way)),
      routeOwed: () => this.travel.owesRoute
    });
    this.statHold = new StatScreenHold(this.queue, this.publisher, sink, () => this.dropTyped());
    this.gearDesk = gearDesk({
      ...{ tracker: this.tracker, errands: this.errands, world: () => this.world },
      ...{ travel: () => this.travel, config: () => this.automationConfig },
      trip: () => this.hostTrips.gear
    });
    this.places = placeDesk({
      ...{ tracker: this.tracker, errands: this.errands, world: () => this.world }
    });
    this.questDesk = questDesk({
      ...{ world: () => this.world, errands: this.errands, runner: this.questRunner },
      ...{ state: () => this.tracker.current, watched: () => this.questWatch.watched }
    });
    this.extensions = sessionExtensions({
      ...{ tracker: this.tracker, errands: this.errands, hunt: this.hunt, walker: this.walker },
      blessings: this.blessings,
      ...{ supplies: this.supplies, trainLevel: this.trainLevel, queue: this.queue, fled },
      ...{ hostTrips: this.hostTrips, areaSearch: this.areaSearch, gear: this.gearDesk.reads },
      world: () => this.world,
      ...{ odds: this.odds, harm },
      config: () => this.automationConfig,
      busy: () => this.errandHeld() || moveInFlight() || this.walker.walking,
      safety: () => this.publisher.automation.safety,
      relayer: () => this.configure(...this.configured),
      notice,
      changed: () => this.publisher.publishAutomation(),
      deps: deps.extensions
    });
    const safetyParts = {
      tracker: this.tracker,
      hangUp: this.hangUp,
      realmMenu: this.realmMenu,
      queue: this.queue,
      travel: this.travel,
      client: this.client,
      publisher: this.publisher,
      grounded: this.grounded,
      ...{ attendance: this.attendance, recoverGear: this.recoverGear }
    };
    const safetySession = {
      config: () => this.automationConfig,
      disconnect: (by: ConnectionEnd) => this.disconnect(by),
      notice
    };
    this.safety = new Safety(safetyParts, safetySession);
    this.rowOverrides = new RowOverrides(automation, { notice });
    this.fleeGoto = new FleeGoto(safetyParts, safetySession);

    this.publisher.useSecret(login.password);
    this.login = new LoginAutomator(
      login,
      this.queue,
      { notice, promptOwed: () => this.link.owePrompt(), prompted: () => this.link.notePrompt() },
      automation.enabled
    );
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
      { module: this.recovery, configure: (a) => this.recovery.configure(a) },
      { module: this.restSpell, configure: (a) => this.restSpell.configure(a) },
      { module: this.loot, configure: (a) => this.loot.configure(a.loot, a.supplies, a.enabled) },
      { module: this.drop, configure: (a) => this.drop.configure(a.drop, a.enabled) },
      { module: this.search, configure: (a) => this.search.configure(a.search, a.enabled) },
      { module: this.deposit, configure: (a) => this.deposit.configure(a.banking, a.enabled) },
      { module: this.chest },
      { module: this.light, configure: (a) => this.light.configure(a.movement, a.enabled) },
      { module: this.wards, configure: (a) => this.wards.configure(a.health, a.enabled) },
      { module: this.gear, configure: (a) => this.gear.configure(a.gear, a.enabled) },
      { module: this.stealth, configure: (a) => this.stealth.configure(a.combat, a.enabled) },
      {
        module: this.recoverGear,
        configure: (a) => this.recoverGear.configure(a.movement, a.enabled)
      },
      { module: this.corpse, configure: (a) => this.corpse.configure(a) },
      { module: this.gearLocks, configure: (a) => this.gearLocks.configure(a.movement) },
      { module: this.trainLevel, configure: (a) => this.trainLevel.configure(a.train, a.enabled) },
      { module: this.outgrown, configure: (a) => this.outgrown.configure(a.outgrown, a.enabled) },
      { module: this.hostTrips, configure: (a) => this.hostTrips.configure(a.enabled) },
      { module: this.areaSearch, configure: (a) => this.areaSearch.configure(a) },
      {
        module: this.hunt,
        configure: (a) => this.hunt.configure(a.hunting, a.walk, a.health, a.enabled)
      },
      { module: this.itemErrand },
      { module: this.questWatch },
      { module: this.odds },
      {
        module: this.questRunner,
        configure: (a) => this.questRunner.configure(a.quests, a.enabled)
      },
      { module: this.restAway, configure: (a) => this.restAway.configure(a) },
      { module: this.statScreen, configure: (a) => this.statScreen.configure(a.train, a.enabled) },
      { module: this.keys, configure: (a) => this.keys.configure(a.movement, a.enabled) },
      { module: this.supplies, configure: (a) => this.supplies.configure(a.supplies, a.enabled) },
      { module: this.remotes, configure: (a) => this.remotes.configure(a) },
      { module: this.attendance, configure: (a) => this.attendance.configure(a.afk.afterMinutes) },
      { module: this.afk, configure: (a) => this.afk.configure(a.afk, a.enabled) },
      { module: this.heal, configure: (a) => this.heal.configure(a.spells, a.enabled) },
      { module: this.castRound },
      { module: this.potions, configure: (a) => this.potions.configure(a.health, a.enabled) },
      { module: this.cures, configure: (a) => this.cures.configure(a.spells, a.enabled) },
      { module: this.blessings, configure: (a) => this.blessings.configure(a.spells, a.enabled) },
      { module: this.extensions, configure: () => this.extensions.configure(this.configured[0]) },
      { module: this.invoke, configure: (a) => this.invoke.configure(a.spells, a.enabled) },
      { module: this.charges },
      { module: this.events, configure: (a) => this.events.configure(a.events, a.enabled) },
      { module: this.hangUp },
      { module: this.rowOverrides, configure: (a) => this.rowOverrides.configure(a) },
      { module: this.safety },
      { module: this.fleeGoto },
      { module: this.locating },
      { module: this.macros },
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
    // Said, and so captured, so a dial with no answer names the address it went to (todo 22).
    this.client.on('resolved', (host, address) =>
      this.sink.notice(t('session.connection.resolved', { host, address }))
    );

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
       * hung up. They are the two facts `Reconnect.lost` reads first; here
       * they decide only who ended it and what the lease is told.
       */
      const walkedOut = this.login.standDown !== null;
      const lost = !graceful && !walkedOut;
      /*
       * Whoever closed it, the lap is held and the route kept (todo 01,
       * 2026-09-30): the character stands wherever the socket went, and the
       * next dial picks both up once it is placed (`pickUpAfterLoss`), within
       * this launch or after a relaunch (`CarryOver`). Disconnect and quit are
       * not Stop; Stop is, and so is typing the way out. A different realm
       * drops both at `connect`. The loop before the walker: stopping a walk
       * reports `ended`, which a running loop would book as a failed leg. The
       * errand after the loop, so the loop hears it end silently; `Supplies`
       * starts afresh from the next pack listing.
       */
      if (walkedOut) this.loops.stop(t('session.loop.stoppedLeftRealm'));
      else this.loops.noteOffline();
      this.supplies.abandon(t('automation.supplies.abandonedConnectionClosed'));
      if (!walkedOut) this.travel.carryJourney();
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

  /** The class row's combat and magery and the wire's family, read once. See `Errands.realmClass`. */
  get realmClass(): RealmClass {
    return this.errands.realmClass();
  }

  /** The attack and opener fought with, typed or chosen (todo 47). See `FightWords`. */
  get fightWords(): Errands['words'] {
    return this.errands.words;
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
    this.carryOver.dial();
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
    this.carryOver.takeUp();
    this.realmMismatchSaid = false;
    this.publisher.reset();
    // Off the list: leaving the realm lands at the menu, where the login has
    // already been made and what the menu said a hang-up costs still holds.
    this.login.reset();
    this.realmMenu.reset();
    this.outbound = '';
    this.playerMove = null;
    this.phaseWas = 'unknown';
    this.realmWord.forget();
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
      this.login.opened();
    } catch (error) {
      if (error instanceof DialCancelled) return this.publisher.state; // `close` reports it
      this.publisher.patch({ phase: 'error', detail: errorMessage(error) });
      this.sink.notice(t('session.connection.failed', { detail: errorMessage(error) }));
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
    if (!this.client.connected && !this.client.dialling) return this.publisher.state;
    this.endedBy = by;
    this.publisher.patch({ phase: 'closing' });
    this.client.disconnect();
    return this.publisher.state;
  }

  send(data: string): void {
    // A line the client reads itself is erased at Enter, not committed (`takeBack.ts`).
    const reads = this.queue.holding === null && this.tracker.current.phase === 'in-game';
    const back = reads ? takeBackAtEnter(this.outbound, data, this.automationConfig.aliases) : null;
    if (back !== null) {
      this.send(back.erase);
      this.sendMacro(back.line);
      return;
    }
    /*
     * A pasted run split onto the channel the player has already named: `-`
     * then three pasted lines was one broadcast and two bare commands said in
     * the room (todo 03). Rewritten before anything else reads `data`, so all
     * see the lines that reach the socket; `null` for an ordinary keystroke.
     */
    const outgoing = splitOntoChannel(this.outbound, data) ?? data;
    this.attendance.note(); // Any key, not only a committed line: the first key ends away (todo 79).

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
        // Armed off what the player typed, before the bytes reach the socket.
        this.statHold.noteSent(command, Date.now());
        this.statScreen.noteSent(command, 'user');
        this.noteSent(command, 'user');
        this.questWatch.noteSaid(command);
        this.remotes.noteTyped(command);
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
    const sent = this.client.send(outgoing);

    // A line typed while the socket dials or after it closed went nowhere, so nothing is owed.
    if (committed && sent) this.link.noteSent();
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

  /** A talk-box line, a key's or an alias: a macro, run step by step. See `MacroRunner`. */
  sendMacro(line: string): void {
    this.macros.run(line);
  }

  /**
   * What is still waiting of the talk box's lines, gone and said. The box's own Drop, and a
   * death: the rest of a path walked from a temple is a walk nobody asked for.
   */
  dropTyped(died = false): void {
    this.macros.drop();
    const count = this.queue.cancel((intent) => intent.typed === true);
    if (count === 0) return;
    // The box's count is read off the snapshot, and nothing else may move soon.
    this.publisher.publishAutomation();
    this.sink.notice(droppedNotice(count, died));
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
    // Entering the realm starts the away clock (`Attendance`).
    if (was !== 'in-game' && state.phase === 'in-game') this.attendance.note();
    this.realmWord.note(state);
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
  private noteSent(command: string, from: 'user' | 'automation', kind?: Intent['decision']): void {
    if (this.tracker.current.phase !== 'in-game') return;
    this.feed.sent(command, from, kind);
    this.chest.sent(command, this.tracker.current);
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
    own: AutomationConfig,
    login: LoginConfig,
    rewrites: RewritesUiConfig = DEFAULT_CONFIG.ui.rewrites
  ): void {
    this.configured = [own, login, rewrites];
    // Every extension's settings over the character's own, while they are laid.
    const automation = this.extensions.over(own);
    this.automationConfig = automation;
    this.rewriter.configure(rewrites);
    this.promptDesign.noteDesign();
    this.errands.forgetPreferred();
    this.queue.configure(automation);
    this.combat.configure(
      automation.combat,
      automation.enabled,
      automation.spells,
      automation.party
    );
    for (const { configure } of this.modules) configure?.(automation);
    this.loops.configure(automation.health, automation.movement, automation.walk);
    this.login.configure(login, automation.enabled);
    this.publisher.useSecret(login.password);
  }

  /**
   * What the realm about to be dialled knows of its players, and its speed last read (`kept`).
   *
   * The host calls this before `connect` and again when the menu's choice is
   * read (todo 34), because what is learned belongs to the realm dialled and
   * chosen. The previous realm is unsubscribed first and the roster re-seeded
   * (pushed after the next line), so no session shows or absorbs two realms'.
   *
   * What another character on this realm learns about a player lands here and
   * is pushed, so the flyout on this tab says what the realm knows; no module
   * is told, since a fact absorbed is not a fact this character observed.
   */
  useRealm(players: RealmPlayers, belongings: CharacterRecord = NO_RECORD, kept = NOT_KEPT): void {
    this.forgetPlayers();
    this.errands.useSpeed(kept);
    // What the realm said it lacks, and its family. See `Vocabulary.forgetRealm`.
    this.vocabulary.forgetRealm();
    this.tracker.useRealm(players);
    // A vault and a kit are the server's: re-keyed with the roster, re-seeded in place (todo 34).
    this.tracker.useBelongings(belongings);
    if (belongings !== this.belongings) this.carryOver.leave(this.belongings);
    this.belongings = belongings;
    this.statsBaseline.useStore(belongings);
    this.tracker.forgetBelongings();
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
    this.carryOver.dispose();
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
    this.sink.block(block, step.collecting);
    if (batch) this.sink.block(batch, true);
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

    // The stat screen's hold, ahead of every module: none may propose while it is up.
    this.statHold.onBlock(block, Date.now());
    // The one thing that reads the screen, fed every block: the dump, each
    // keystroke's echo, and the sentence the server prints on SAVE alone.
    this.statScreen.onBlock(block);

    // Ahead of the login script, which answers the realm prompt inside its own
    // `onBlock`: the menu has to know it was asked before the answer goes.
    this.realmMenu.onBlock(block);
    this.login.onBlock(block);
    /*
     * An unrecognised command is *said out loud* by this server (`exits`,
     * `time` came back as `You say "..."`). The Alerts card keeps it; the
     * console is not told twice. Only the automation's own word is acted on:
     * a realm with no locate command has just said so in front of the room,
     * so it is not asked again, and that is said once.
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
      this.wards.died();
    }

    this.noticeRealmMismatch(block);
    this.rules.onBlock(block);
    this.walker.onBlock(block);
    this.macros.onBlock(block);
    this.wards.onBlock(block, this.tracker.current);
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
    this.deathSummons.onBlock(block, this.tracker.current);
    // A floor listing the server wrapped arrives as a batch, and the loot
    // reads the floor; without this a pile long enough to wrap — which is the
    // pile worth having — was one the loot was never told about (todo 03).
    if (batch) this.loot.onBlock(batch, this.tracker.current);
    this.light.onBlock(block, this.tracker.current);
    this.supplies.onBlock(block, this.tracker.current);
    this.remotes.onBlock(block, this.tracker.current);
    this.travel.outfitBlock(block);
    this.afk.onBlock(block, this.tracker.current);
    /*
     * The spellbook ask correcting itself (a wrong-book refusal names the right
     * listing, a level-up voids the one on file), and each listing's answer (835).
     */
    for (const read of batch ? [block, batch] : [block]) this.routines.onBlock(read);
    this.extensions.onBlock(block);
    this.charges.onBlock(block); // First: the cash run and the use read the count it takes.
    for (const each of [this.hostTrips, this.areaSearch, this.errands]) each.onBlock(block);
    this.corpse.onBlock(block);
    /*
     * Before `tracker.apply`, deliberately: a wear-off is about to take the
     * buff off the list, and the entry — with the caster's name on it — is
     * the only record of whom to notify.
     */
    for (const each of [this.blessings, this.invoke]) each.onBlock(block, this.tracker.current);
    this.castRound.onBlock(block);
    /*
     * A party forming or breaking up is the moment its roster becomes worth
     * having — and the moment it is emptiest, because nothing has asked.
     */
    const partyChanged =
      block.type === 'party-joined' ||
      block.type === 'party-left' ||
      block.type === 'party-rank-changed';
    if (partyChanged) this.routines.onPartyChanged();
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
      this.chest.onListing(this.tracker.current);
      this.light.onListing();
      // And the quest run and the item errand, which read only the listing
      // their own ask answered.
      this.questRunner.noteListing(this.answering);
      this.itemErrand.noteListing(this.answering);
    }

    // After `apply`: what a search or a counter said, written down. See `Records.noted`.
    this.records.noted(block, batch);

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
    } else if (block.type === 'command-fumbled' || block.type === 'command-ignored') {
      /*
       * The server threw the command away before it looked at it — todo 02;
       * `command-ignored` is `GMUDInGameState.Process` at twenty queued (todo 65).
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
      // Walking out to the menu is a character leaving: said before the modules
      // below read the state, or half of them act once on a character gone.
      this.noteRealmPhase(state);
      // A walk or loop the player steered out from under stands down now, so the
      // walker says "you moved the character yourself", not a wrong-room stop.
      this.notePlayerSteering(state);
      this.restAway.noteRoom();
      this.marks.onCharacter(state);
      // The saved gear's hold after a death: bookkeeping, under no switch (todo 82).
      this.gearLocks.onCharacter(state);
      // What a lost connection left owed first, so walk and lap decide on the line placing it.
      this.travel.pickUpAfterLoss(state);
      this.extensions.onCharacter(state);
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
      this.errands.onCharacter(state, block);
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
      // And the ward this room wants, when its spell has lapsed (todo 105).
      this.wards.onCharacter(state, roomAddress(state.room));
      // And the key to a way out of this room, off this room's floor.
      this.keys.onCharacter(state);
      this.events.onCharacter(state);
      // Telling a leader this character sat down or stood up; and, leading, whom to wait for.
      this.remotes.onCharacter(state);
      this.travel.watchParty(state);
      this.travel.outfitTick(state);
      // Then running away, walked and then the realm's teleport (todo 813): both free.
      this.travel.considerEscape(state);
      this.fleeGoto.consider(state);
      // The walk home a `safe-haven` escape armed, after the fight; a walk held for `i` (todo 02).
      this.travel.walkHomeIfDue(state);
      this.travel.walkOnceListed(state);
      if (!moveOnly) {
        // Shopping, which yields to every one of the above (`Supplies.consider`).
        this.supplies.onCharacter(state);
        // And the kit after a death, on the same terms as the errand.
        this.recoverGear.onCharacter(state);
        this.trainLevel.onCharacter(state);
        this.outgrown.onCharacter(state);
        for (const trip of [this.hostTrips, this.areaSearch]) trip.onCharacter(state);
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
      // A blessing marked prioritizeOverHeal goes ahead of the heal: a caster's shield first.
      if (!this.travel.isRetreating()) this.blessings.urgent(state);
      // Healing before resting: a number a spell can fix now is not one to sit down over.
      if (!this.travel.isRetreating()) this.heal.onCharacter(state);
      // A potion beside the spell; nothing drunk on the way out (the move is the escape).
      if (!this.travel.isRetreating()) this.potions.onCharacter(state);
      // A cure is a heal chosen by a sentence; a buff refuses combat itself. Not on the way out.
      if (!this.travel.isRetreating()) {
        this.cures.onCharacter(state);
        this.blessings.onCharacter(state);
        // The pack's blesses, after the casts: the book's bless is the one configured.
        this.invoke.consider(state);
        // Shedding named junk off the pack listing; it refuses combat and rest itself.
        this.drop.onCharacter(state);
        // And the coins the player asked to be rid of, off the listing that counts them.
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
      // And the kit, outside the escape guard: a swap queues behind an escape in a
      // lower band and is asked again where it lands; it never crosses a move of ours.
      if (this.tracker.pendingMoves === 0) {
        this.gear.onCharacter(
          state,
          this.walker.walking || this.loops.progress.status === 'running'
        );
      }
      // The kit is dressed above the rest, so a resting set's `wear` goes ahead of
      // the `rest` in `probe` (todo 60). Not while a route marches: see `mayRest`.
      /*
       * The shadows before the rest: `hide` then `rest` is the order a
       * backstabber wants, since a class with `ShadowHome` keeps its stealth
       * through the rest and every other class has it broken by the `rest`
       * itself. Refuses a fight, a monster, a move in flight and a rest for
       * itself.
       */
      this.stealth.onCharacter(state);
      /*
       * And *where* the rest is taken, before whether (todo 08): not in a lair
       * on a short clock while a neighbour, the room the character came from
       * first (noted above), is found empty. `took-over` is the step out;
       * `rest-here` is a lair with no safe neighbour, said once.
       */
      const away = this.restAway.consider(state, this.recovery.wouldRest(state) && this.mayRest());
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

  /**
   * Nothing else in the middle of something: the escapes, and **the errands**,
   * each of which has phases where nothing is walking and nothing is looping (a
   * shop errand waiting for its listing, a trainer errand waiting for the level
   * to move), during which a hunt or a plan would walk the character away from
   * what it came for.
   */
  private errandHeld(): boolean {
    return this.travel.escaping || this.travel.holdsTrips();
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
     *
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
   * Re-decide, with nothing new to decide from: the modules whose answer
   * changes on a clock of their own (a heal or potion off cooldown, a cure's
   * thirty seconds, a `rest` whose in-flight window lapsed). Each re-derives
   * from the state and refuses for itself, so a tick where nothing moved
   * proposes nothing. Not driven here: `Blessings`, which owns this clock
   * already (two would recast twice as often); the walker, the loop, the
   * rules, auto-combat and both escapes, which decide from a fact the wire
   * delivers, so a re-run against a stale state acts twice on one event; and
   * shedding, searching and banking, driven by a listing. The order is the
   * block path's, less those; `blessings.urgent`'s priority means nothing on
   * a tick with nothing else being decided.
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
    const away = this.restAway.consider(state, this.recovery.wouldRest(state) && this.mayRest());
    if (away !== 'took-over' && this.mayRest()) this.restNow(state);
  }

  /** `Recovery`, told first the health a walk held for health wants (`restingFor`). */
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
   * The realm said where the character is, and the world database has no such
   * room: the wrong map is loaded for this server. A Paradigm database against
   * stock GreaterMUD answered `rm` with `Location: 1,289`, a room the data
   * lacked, and every route from there failed with nothing to say why.
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

  /** The loops this character's options define. */
  get heldLoops(): readonly Loop[] {
    return this.automationConfig.loops;
  }

  /** What this character costs to move, as the router prices it. See `Errands.travellerNow`. */
  travellerNow(state: CharacterState): Traveller {
    return this.errands.travellerNow(state);
  }

  /** A walk (or with `lap`, a lap's leg) between two rooms. See `Errands.routeBetween`. */
  leg(from: RoomId, to: RoomId, options: RouteOptions & { lap?: true } = {}): Route | string {
    return this.errands.routeBetween(from, to, options.lap ? 'lap' : 'walk', options);
  }

  /** What a lap's leg costs to move. See `Errands.lapTraveller`. */
  lapTraveller(state: CharacterState): Traveller {
    return this.errands.lapTraveller(state);
  }

  /** Where this character should hunt. See `Errands.huntingGrounds`. */
  huntingGrounds(radius: number | null, measure: string | null = null): HuntingAdvice {
    return this.errands.huntingGrounds(radius, measure);
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
  stopMoving(by: string | null = null): void {
    this.travel.stopMoving(by);
    this.extensions.playerStopped();
  }

  /** The player walks on without the party. See `PartyRegroup.release`. */
  walkOnWithoutParty(): void {
    this.remotes.releaseRegroup();
  }

  /** The named loop, or whatever was stopped. See `Travel.startMoving`. */
  startMoving(loopName: string | null, confirmed: number | null): MovementStart {
    return this.travel.startMoving(loopName, confirmed);
  }

  /** A lap the player asked for. See `Travel.startLoop`. */
  startLoop(loop: Loop): MovementStart {
    return this.travel.startLoop(loop);
  }

  /** The decision trace, for a renderer that mounted mid-session. See `Publisher.automation`. */
  get automation(): AutomationSnapshot {
    return this.publisher.automation;
  }

  /**
   * The character to the window, per change and never coalesced, with the
   * room's verdict and asks beside it (`Publisher.character`), and the reset
   * watch last.
   */
  private publishCharacter(): void {
    this.odds.refresh(this.tracker.current);
    this.publisher.character();
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
    // The persisted fields are re-seeded from the now empty record, and the
    // book is listed again; the room, the roster and the phase are left as they are.
    this.tracker.forgetBelongings();
    this.routines.characterForgotten(this.tracker.current);
    this.statsBaseline.useStore(this.belongings);
    this.questWatch.reset();
    this.publishCharacter();
    this.sink.notice(t('session.reset.forgotten'));
    return true;
  }
}
