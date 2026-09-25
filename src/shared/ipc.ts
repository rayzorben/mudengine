/**
 * The single source of truth for the main <-> renderer contract.
 *
 * Channel names live here so main and preload cannot drift; the payload types
 * are declared alongside them so a mismatch is a compile error rather than a
 * runtime surprise.
 *
 * **Everything that belongs to a session says which one.** The client holds
 * more than one character at a time, so a chunk of output, a state transition
 * or a keystroke with no destination is meaningless — and the point of putting
 * the id in `Addressed<T>` rather than in a convention is that such a message
 * does not typecheck. See docs/profiles.md §5.
 *
 * App-level calls — the options file, the realm data, the log directory — take
 * no session, because they belong to the client rather than to a character.
 */
import type { AutomationSnapshot } from './automation';
import type { Block } from './blocks';
import type { LocalMap } from './map';
import type { Discovery } from './memory';
import type { Find } from './finds';
import type { CharacterIdentity, ResetSignal } from './reset';
import type { CharacterState } from './character';
import type { PlayerRegistry } from './players';
import type { DebugRecord } from './debug';
import type { GearAction, Wearer } from './gear';
import type {
  Quest,
  QuestErrand,
  QuestPlan,
  QuestRunProgress,
  QuestWatched,
  RoomAsk
} from './quests';
import type { HuntingAdvice } from './hunting';
import type {
  AlertsUiConfig,
  AutomationSwitch,
  AutomationSwitches,
  CombatConfig,
  ConfigSnapshot,
  HealthConfig,
  MovementConfig,
  LootConfig,
  DropConfig,
  SearchConfig,
  BankingConfig,
  HuntingAutomationConfig,
  GearConfig,
  QuestsConfig,
  TrainConfig,
  RemotesConfig,
  StatlineConfig,
  RewritesUiConfig,
  TalkConfig,
  AfkConfig,
  Server,
  SpellsConfig,
  RetreatStrategy,
  PartyConfig,
  PotionWhen,
  PvpAction,
  SuppliesConfig,
  SupplyItem
} from './config';
import type { GlobalDraft, LoginStepDraft, ProfileDraft, ServerDraft } from './drafts';
import type { RemoteGrant, RemoteName } from './remotes';
import type { CureGates, SpellServes, SpellTargeting } from './spellcraft';
import type { ThemePreference } from './themes';
import type { ProfileAccent } from './profiles';
import type { LocateWord } from './locate';
import type { InternalConfig } from './internal';
import type { Loop, LoopProgress, LoopScope, ScopedLoop } from './loops';
import type { WalkProgress } from './walk';
import type { MovementStart, WalkStart } from './movement';
import type { RoomVerdict } from './verdict';
import type {
  LoopDraft,
  RoomBrief,
  RoomId,
  Route,
  BankChoice,
  TrainerChoice,
  WardRule,
  WorldLookup,
  WorldNames,
  WorldRoom
} from './world';
import type { Visited } from './destinations';
import type {
  ConnectionState,
  ConnectionTarget,
  StreamChunk,
  StreamLine,
  TelnetEvent,
  TerminalActionName,
  TerminalSize
} from './types';

/**
 * Identifies one loaded session.
 *
 * Once profiles exist this is the profile id — the filename of the character's
 * YAML — which is why it is a plain string and not a counter: it has to survive
 * a restart, name a log file and be greppable.
 */
export type SessionId = string;

/**
 * The address the renderer uses while it has no character at all.
 *
 * Not a session: main holds nothing under it, and every handler answers an
 * unknown id with nothing (`host.get(id)?.…`), so whatever a window sends here
 * is dropped rather than dialled. It exists because a hundred call sites take a
 * `SessionId` and "no character yet" is a state the client is in for exactly as
 * long as it takes to make the first one — the new-character form opens on its
 * own. The anonymous `default` session this replaced (retired 2026-08-29) was
 * a second client with fewer parts, driven by `connection:` and carrying its
 * own credentials; making a character is step one.
 */
export const NO_SESSION: SessionId = '';

/** A payload and the session it came from. */
export interface Addressed<T> {
  session: SessionId;
  payload: T;
}

/**
 * What the window is running under.
 *
 * `electron` is the desktop client: a `BrowserWindow` with the preload as its
 * bridge, and the operating system behind it — a file manager to reveal a
 * path in, a native picker, a clipboard main can read. `web` is the same
 * renderer served over HTTP to a browser tab, bridged over a WebSocket
 * (`src/shared/rpc.ts`), with none of those: the window says so where it
 * matters rather than offering a control that cannot work.
 */
export type HostKind = 'electron' | 'web';

/**
 * What revealing a path did.
 *
 * On the desktop the operating system's file manager opens and that is the
 * whole answer. In a browser tab there is no file manager on the machine the
 * files are on — the client is running somewhere else — so the path is
 * *shown* instead, in a listing the window draws (`Invoke.browseHome`). Said
 * in the answer rather than guessed from the host kind, so the window acts on
 * what happened.
 */
export type Revealed = { how: 'opened' } | { how: 'listed'; path: string };

/** One row of a directory under the client's home. */
export interface DirectoryEntry {
  name: string;
  kind: 'file' | 'directory' | 'other';
  /** Bytes, for a file; null where the size means nothing. */
  size: number | null;
  /** Whether `RealmSource` could read this file as a realm database. */
  realm: boolean;
}

/**
 * A directory under the client's home, listed for the window to show.
 *
 * Names and sizes only — never contents. The options file and every profile
 * in this tree hold the player's realm password, and a listing that served
 * bytes would be serving that to whoever holds the browser tab.
 */
export interface HomeListing {
  /** The home root; nothing outside it is ever listed, and the picker says so. */
  root: string;
  /** The directory listed, absolute. */
  dir: string;
  /** Its parent, or null at the root. */
  parent: string | null;
  /** The file the request named, when it named one, so the window can mark it. */
  selected: string | null;
  entries: DirectoryEntry[];
  /** Why the listing is empty, when it is for a reason rather than a fact. */
  error: string | null;
}

/**
 * An engine message to surface inline in the terminal.
 *
 * `session` is null when the message is about the client rather than a
 * character — an options file that failed to parse belongs to no session, and
 * addressing it to one would be a small lie that gets confusing the moment
 * there are four.
 */
export interface Notice {
  session: SessionId | null;
  message: string;
}

/**
 * Everything a window needs to start drawing a session it has just attached to.
 *
 * One call, assembled synchronously in main, because the alternative — a
 * handful of separate invokes — leaves a window with a torn view: state from
 * one moment, character from the next, and any output in between belonging to
 * neither. It also closes a subtler hole. `data` and `line` are routed only to
 * windows that have attached, and attaching is a round trip; without a
 * snapshot, everything the session says during that trip is delivered to nobody
 * and is gone. The terminal survived on its backscroll replay while the framed
 * lines quietly did not, which is the kind of gap that reads as "parsing broke".
 */
export interface AttachSnapshot {
  /** Retained bytes for the terminal, escape sequences intact. */
  backscroll: string;
  /** Retained framed lines, for the diagnostics stream card. */
  lines: StreamLine[];
  state: ConnectionState;
  character: CharacterState;
  /** The registry when the window attached; `Push.players` carries every change after. */
  players: PlayerRegistry;
  walk: WalkProgress;
  loop: LoopProgress;
  automation: AutomationSnapshot;
  /** The room as appraised when the window attached; `Push.verdict` carries every change after. */
  verdict: RoomVerdict;
  /** What the occupants answer to when the window attached; `Push.asks` carries every change. */
  asks: RoomAsk[];
  /** Negotiation history, for the traffic card. */
  telnet: TelnetEvent[];
  /**
   * What this character has learned about the realm that the realm data does
   * not have. In the snapshot rather than fetched separately for the reason
   * everything else here is: a window with state from one moment and a record
   * from the next has a torn view and no way to tell.
   */
  learned: Discovery[];
  /**
   * What a `search` has turned up in this realm, oldest first. Here for the
   * reason `learned` is: a window that fetched it separately would show a log
   * from one moment beside a room from another.
   */
  finds: Find[];
  /**
   * The rank each quest has been seen to reach from what this character was
   * watched doing this session, and when each was seen. See `Push.questSaid`.
   */
  questSaid: QuestWatched;
  /** How a run of a quest's plan is going, or how the last one ended. See `QuestRunner`. */
  questRun: QuestRunProgress;
  /**
   * The Talk card's history — the conversation log's tail, oldest first, so a
   * restart restores the conversation instead of starting the card empty.
   * Empty when `logging.conversations` is off.
   */
  talk: Block[];
}

/**
 * A character on disk, whether or not a session is open for it.
 *
 * The tab rail shows what is *loaded*; this is what *exists*, so the palette can
 * offer to open one that has been closed. A profile file is never removed by
 * unloading — closing a tab is a statement about this window, not about disk.
 */
export interface ProfileSummary {
  id: SessionId;
  name: string;
  accent: string;
  /** The theme this character resolves to — its own `ui.theme` over the options file's. */
  theme: ThemePreference;
  /** Whether a session is open for it. */
  loaded: boolean;
  /** Where it connects, for the palette's hint line. */
  target: ConnectionTarget;
  /**
   * The realm this character plays on, by the name a `servers/` directory is
   * filed under.
   *
   * Needed by anything offering to write into that realm's scope — the Loops
   * modal's *To realm* destination names it, and main resolves it back to the
   * directory. Carried here rather than fetched from the settings snapshot
   * because the renderer already holds these, and pulling a whole snapshot
   * (every character, every server, every loop) to label one button is a great
   * deal of work to answer a question this object was already the right place
   * for.
   */
  serverName: string;
  /**
   * Which of another player's `@` commands this character answers, and for
   * whom — `automation.remotes`, resolved the way `theme` above is.
   *
   * Here rather than fetched per card because it is a *resolved* value: a
   * character's own file states it sparsely over the options file's, and the
   * renderer has only the global config. The Player flyout's Access face and
   * the Gang card both have to say what is currently getting through, and that
   * question cannot be answered from the global block alone.
   */
  remotes: RemotesConfig;
  /**
   * Every `automation:` boolean the toolbar can flip, resolved.
   *
   * Beside `remotes` and for its reason exactly: these are *resolved* values —
   * a character's own file states them sparsely over the options file's, and
   * the renderer holds only the global config, so a toolbar drawn from that
   * would show the global answer on every character. Pushed rather than
   * fetched per card because a toolbar that draws a moment late draws the
   * switch the player just pressed in its old position.
   */
  switches: AutomationSwitches;
  /**
   * The ceiling a stretch of resting is carried on to — `automation.health`'s
   * `restTo`, resolved, as a fraction; 0 where the character rests only at the
   * floor.
   *
   * Beside `remotes` and `switches` for their reason exactly: it is a
   * *resolved* value, and the tab rail reporting `resting to 90%` off the
   * global block would say the same figure for every character whatever their
   * own file states. The rail is the surface that reports on the characters
   * nobody is looking at, so the number it prints has to be the one that
   * character is actually resting to.
   */
  restTo: number;
  /**
   * What this character keeps in its pack — `automation.supplies`, resolved,
   * for the Self card's Supplies face and the item panel's controls. Beside
   * `remotes` for its reason: a list drawn off the global block would show
   * every character the same one.
   */
  supplies: SuppliesConfig;
}

/**
 * One character as a settings screen needs it: the fields a form edits, read
 * back off disk.
 *
 * Not a `Profile`. A resolved profile carries the whole merged `AppConfig`,
 * which is the *result* of the file rather than what is in it — editing a form
 * populated from that would write every inherited global setting into the
 * character's own file and make it a copy rather than an overlay, which is
 * exactly the failure `profiles.ts` rule 1 exists to prevent.
 */
/**
 * One spell a settings picker can offer: the name a cast command sends, the
 * realm's own casting word beside it so `mihe` finds `minor healing`, and who
 * the realm lets it be cast on.
 *
 * `targeting` is classified in main rather than crossing as `Spells.Targets`
 * raw, because the reading of that column belongs in one place
 * (`spellTargeting`) and a renderer re-deriving it is a second copy to keep in
 * step. `'unknown'` is a realm this build cannot read the column of, and every
 * picker treats it as *offer it anyway* — see `castsOnSelf`.
 */
export interface SpellOption {
  name: string;
  short: string | null;
  targeting: SpellTargeting;
  /**
   * Which conditions the realm says this spell serves — `spellServes` over its
   * ability rows, carried so a picker can offer only the spells that answer
   * the question it is asking (todo 00).
   *
   * The cure fields all drew the whole spellbook before this, so *Cure
   * Poison* offered every spell the character knows and the blindness field
   * only looked filtered because its **gate** happened to close more often.
   * Absent for a realm this build cannot read the columns of, which every
   * reader treats as *offer it anyway*: unknown must never empty a picker.
   */
  serves?: SpellServes;
}

export interface ProfileEditable {
  id: string;
  name: string;
  accent: ProfileAccent;
  /** `ui.theme` as this character's file states it; '' follows the options file. */
  theme: ThemePreference | '';
  autoConnect: boolean;
  /** Dial it again when a connection is *lost*. On unless the file says no. */
  autoReconnect: boolean;
  /** The name it refers to, or null when it spells the address out inline. */
  serverName: string | null;
  target: ConnectionTarget;
  username: string;
  /**
   * Whether a password is on file — **never the password itself**.
   *
   * A settings screen has to say whether one is set, and a password that has
   * crossed to a renderer is one that can end up in a devtools snapshot, a
   * crash report or a screenshot. The form starts blank and blank means
   * "leave it alone".
   */
  hasPassword: boolean;
  /**
   * This character's own menu script, empty when it uses its server's.
   *
   * A list rather than the four named menus it used to be: those were
   * *Paradigm's*, and naming them made one BBS's layout part of the client's
   * vocabulary. See `LoginConfig.steps`.
   */
  login: LoginStepDraft[];
  /** This character's own locate word, from the file as written; null where it follows its realm. */
  locate: LocateWord | null;
  /** Resolved, so inherited values show; `penalties` alone is this character's own, null where it inherits. */
  hangUp: {
    enabled: boolean;
    belowHealth: number;
    penalties: boolean | null;
    onPlayerInRoom: boolean;
  };
  retreat: {
    enabled: boolean;
    belowHealth: number;
    /** MegaMUD's `ManaRun%`; 0 never. */
    belowMana: number;
    whenOutnumbered: number;
    strategy: RetreatStrategy;
    safeHavenRoom: string;
  };
  /** Resolved; `command` alone is this character's own, empty where it follows the realm. */
  fleeGoto: { enabled: boolean; belowHealth: number; command: string };
  /** What to do when a player opens on this character. Resolved, like the two above. */
  pvp: { notifyGang: boolean; action: PvpAction };
  /**
   * Fighting on this character's behalf. Resolved, like the two above.
   *
   * The whole block rather than a switch, because every field of it is a thing
   * the form asks: what to swing with, what to open on, what never to touch.
   * See `CombatConfig`.
   */
  combat: CombatConfig;
  party: PartyConfig;
  /** Resting and meditating — MegaMUD's Health tab. Resolved, like the rest. */
  health: HealthConfig;
  /** What a route is allowed to do on the way — MegaMUD's Movement. */
  movement: MovementConfig;
  /** Going hunting on its own — where this character should be. Resolved. */
  hunting: HuntingAutomationConfig;
  /** Spending character points on the stat screen. Resolved, like the rest. */
  train: TrainConfig;
  /** Running a quest's plan (todo 102). Resolved, like the rest. */
  quests: QuestsConfig;
  /** Which kit to be in, and when. See `GearConfig`. */
  gear: GearConfig;
  /*
   * What the character picks up, puts down, searches for and banks — resolved,
   * like the rest (todo 03, 2026-09-12). They were reachable only on the
   * Global page, so `automation.loot` was a client-wide answer to a question
   * two characters on one realm rarely answer the same way.
   */
  loot: LootConfig;
  drop: DropConfig;
  search: SearchConfig;
  banking: BankingConfig;
  /**
   * Whether this character answers another player's `@` commands. Resolved.
   *
   * Per character, because *which* character is reachable is the decision
   * somebody actually makes: a pair run together answering each other, and the
   * one being played by hand left out of it.
   */
  remotes: RemotesConfig;
  /** Answering for an absent player. Resolved, like the rest. */
  afk: AfkConfig;
  /** What this character learns about other people. Resolved, like the rest. */
  talk: TalkConfig;
  /** Whether the client sets the prompt's shape on the way in. Resolved, like the rest. */
  statline: StatlineConfig;
  /** The status line and listings this player designed for this character. Resolved, like the rest. */
  rewrites: RewritesUiConfig;
  /**
   * The loops this character alone may walk: `profiles/<id>/loops/`.
   *
   * Its *own*, not the resolved list. Scope is the directory a loop file sits
   * in, so a character's page edits one of the three and shows the other two
   * beside it — a form that offered the inherited ones as though they were
   * this character's would write a copy of everybody's loops into one
   * character the first time it was saved.
   */
  loops: Loop[];
  /** The loops it walks without asking: its server's, then the global ones. */
  inherited: ScopedLoop[];
  /** The one spell that is not a rule, because a rule cannot say *when*. */
  spells: SpellsConfig;
  /**
   * What the `sp`/`pow` listing last said this character knows, from its own
   * persisted record — offered to the form's spell pickers while offline too.
   * **Null is *never read*, not *knows nothing*:** the form shows a note and
   * disables no cure on null, where an empty book would honestly disable all
   * three.
   */
  spellbook: SpellOption[] | null;
  /**
   * Whether the book holds a spell the realm marks as curing each condition
   * — `cureGates` over the known spells' ability rows, null while the book is
   * unread. See `shared/spellcraft.ts` for why `disease` is a negative gate.
   */
  cureGates: CureGates | null;
  /** Which alerts this character raises. Resolved, like the rest. */
  alerts: AlertsUiConfig;
  /** Why this character cannot currently be loaded, if it cannot. */
  error?: string;
}

/** Everything a settings screen draws itself from. */
export interface SettingsSnapshot {
  characters: ProfileEditable[];
  servers: Server[];
  /**
   * The loops on disk, by the scope that owns them.
   *
   * Each is edited where it lives — the global ones on the client's own page,
   * a server's on that server's — because the scope *is* the directory and a
   * screen that let one be moved by ticking a box on another page would be
   * inventing a fourth representation of something the tree already states.
   * Servers are keyed by name, which is what a character refers to.
   */
  loops: { global: Loop[]; servers: Record<string, Loop[]> };
  /**
   * The options file everything is inherited from, as a form holds it.
   *
   * Carried with the snapshot rather than asked for separately: unlike the loop
   * catalogue, it is small, and the screen that needs it is the screen that
   * already asked for this.
   */
  global: GlobalDraft;
  /**
   * Every castable spell the shipped realm names, for the Global page's
   * pickers — the starting point a new character copies, where there is no
   * character whose own book could narrow the list.
   */
  realmSpells: SpellOption[];
  /** Where the files are, so the screen can offer to reveal them. */
  home: string;
  configPath: string;
  profilesDir: string;
}

/** What a window needs to render a session it is not necessarily showing. */
export interface SessionSummary {
  id: SessionId;
  /**
   * Who this is.
   *
   * The character's own name once the realm has said it, because that is what a
   * player calls them — the profile's display name is a filename until then,
   * and "Main" tells nobody anything.
   */
  name: string;
  /** Where they play, for telling two characters on two realms apart. */
  server: string;
  /** Identity colour for the tab and the focused pane's edge. */
  accent: string;
  state: ConnectionState;
  /**
   * Whether a lost connection is being dialled back right now.
   *
   * On the summary rather than in `ConnectionState`, because it is the host's
   * fact and not the socket's: the phase during a retry's wait is `closed`,
   * which is indistinguishable from *offline, nobody dialling*. Without it the
   * rail cannot say a character is coming back, and the tab's dial — which
   * branches on `connected` — offers **Connect** while a ladder is running,
   * so nothing anywhere in the client means *stop trying*.
   */
  retrying: boolean;
}

/** Renderer -> main, fire and forget. */
export const Send = {
  /** This window finished mounting and is ready to receive output. */
  clientReady: 'client:ready',
  /** Bytes typed by the user, already assembled into a line or raw key. */
  input: 'session:input',
  /**
   * A talk-box line that stands for several commands (`src/shared/macro.ts`),
   * as typed: main parses it again and queues each command (todo 04).
   */
  macro: 'session:macro',
  /** Drop what is still waiting of the talk box's lines. */
  dropMacro: 'session:macro:drop',
  /** Terminal geometry changed; drives Telnet NAWS. */
  resize: 'session:resize',
  /**
   * Whether this window is showing the diagnostics line feed.
   *
   * `Push.line` is per framed line — the one push that arrives at stream rate
   * — and only the Stream card reads it, which is hidden by default. Main
   * sends it only to windows that have declared interest, so the common case
   * pays no serialisation per line; a window catching up re-asks with
   * `Invoke.getLines`, which is authoritative.
   */
  diagnostics: 'client:diagnostics',
  /**
   * Whether this window is showing the debug view.
   *
   * Its **own** flag rather than `diagnostics`, and that is not tidiness:
   * `Push.debug` produces several records per framed line where `Push.line`
   * produces one, and only `DebugView` subscribes to it. Sharing the flag,
   * opening the diagnostics rail — or leaving a Stream float pinned — paid
   * three or four extra serialisations per line of output for a window that
   * discarded every one of them on arrival.
   */
  debugFeed: 'client:debug-feed'
} as const;

/** Renderer -> main, request/response. */
export const Invoke = {
  // -- per session
  connect: 'session:connect',
  disconnect: 'session:disconnect',
  getState: 'session:get-state',
  getTelnetLog: 'session:get-telnet-log',
  /** Framed lines retained for a renderer that mounted mid-session. */
  getLines: 'session:get-lines',
  /** The debug ring, for a window that has just opened the debug view. */
  getDebug: 'session:get-debug',
  /**
   * Write the debug ring out as a bug report and answer with the path.
   *
   * Main writes it rather than the window, for the reason main owns the
   * clipboard and the logs: the renderer has no filesystem, and the path has to
   * be the same `logs/` directory `check:secrets` already walks — a report
   * saved somewhere that check does not look is a report nobody can promise
   * carries no password.
   */
  saveDebug: 'session:save-debug',
  /** Current character and room state, for a renderer that mounted mid-session. */
  getCharacter: 'session:get-character',
  /** A* route from where the character is to a chosen room. */
  routeTo: 'world:route',
  /** Walk a planned route. Returns why it could not start, or null. */
  walkRoute: 'walk:start',
  /**
   * Collect the item a route's door needs, then walk the route (todo 07).
   *
   * The route panel's *collect it first*, on the alternative that needs one.
   * Returns why it could not start, or null. See `SessionManager.collectThenWalk`.
   */
  collectThenWalk: 'walk:collect',
  /**
   * Start moving: begin the loop named, or pick back up whatever was stopped.
   *
   * The one play button. A character is routing, looping or stopped
   * (`src/shared/movement.ts`), so there is one channel for *go* and one for
   * *stop* rather than the five this replaced.
   */
  startMoving: 'move:start',
  /** Stop moving, whichever of the two is running. The place is kept. */
  stopMoving: 'move:stop',
  /**
   * One room back the way the character came, per press.
   *
   * A route to the previous room on the trail, never the opposite of the last
   * direction. Answers as `move:start` does, because it asks the same kind of
   * question back: the way back is not always one step. See
   * `SessionManager.stepBack`.
   */
  stepBack: 'move:back',
  listLoops: 'loop:list',
  startLoop: 'loop:start',
  /**
   * Walk a loop given whole, rather than one named in the character's options.
   *
   * The Loops modal's `Don't keep it`: a loop off the shipped shelf that was
   * never written into any scope, so there is no name to resolve. See the
   * handler in main.
   */
  runLoop: 'loop:run',
  /** Give up on the current stop and head for the next. */
  skipLoopStop: 'loop:skip',
  /** Turn a bounce loop round. Refused for a plain loop. */
  reverseLoop: 'loop:reverse',
  /** The loops the client ships, for the settings screen to offer. */
  loopCatalogue: 'loop:catalogue',
  /**
   * Plan a loop being built by hand: the picks in order, each pair routed by
   * the realm this character is on, reduced to the fewest waypoints. The
   * builder card asks on every pick, so what it draws is what would be walked.
   */
  draftLoop: 'loop:draft',
  /** Walk progress, for a renderer that mounted mid-walk. */
  getWalk: 'walk:get',
  /** The decision trace, for a renderer that mounted mid-session. */
  getAutomation: 'automation:get',

  // -- sessions and windows
  /** Every loaded session, for a window that has just mounted. */
  listSessions: 'sessions:list',
  /** Every character on disk, loaded or not. */
  listProfiles: 'profiles:list',
  /** Open a session for a character that has been closed. */
  loadProfile: 'profiles:load',
  /**
   * Close a character's session. Returns the reason it refused, or null.
   *
   * Refuses while connected unless forced: a tab closed by accident must not be
   * able to drop a character in a dangerous room without a question first.
   */
  unloadProfile: 'profiles:unload',
  /**
   * This window is now showing that session.
   *
   * Resolves with an `AttachSnapshot` — everything needed to draw it from cold.
   * Main owns the backscroll precisely so that attaching is lossless: see
   * docs/profiles.md §6.
   */
  attach: 'sessions:attach',
  /** This window is no longer showing that session. */
  detach: 'sessions:detach',
  /**
   * The rail, in the order somebody dragged it into.
   *
   * Stated whole rather than as a move: the renderer already knows the order it
   * is drawing, and re-deriving a move from two lists in main would be a second
   * copy of the rule that decides where a dropped tab lands.
   *
   * Addressed by the *asking window*, like `gatherWindows` and for the same
   * reason — a rail belongs to the window it is drawn in, and a window may not
   * reorder tabs that live somewhere else.
   */
  reorderSessions: 'sessions:reorder',
  /**
   * Move a character's tab into a window of its own, or back to the main one.
   *
   * The **session does not move**. It never moves: it is in main, and a pop-out
   * is a `detach` from one window and an `attach` to another (docs/profiles.md
   * §7.4). No socket is touched and no state is rebuilt — the backscroll
   * replays on attach exactly as it does for a renderer reload.
   *
   * Each resolves to why it refused, or null.
   */
  popOut: 'windows:pop-out',
  popIn: 'windows:pop-in',
  /**
   * Bring every character back to the asking window, closing the rest.
   *
   * A separate call from `popIn` because a window cannot ask for characters it
   * does not know about: its roster is only what it holds tabs for, which is
   * the whole point. Main knows where everybody is, so main does it.
   */
  gatherWindows: 'windows:gather',
  /**
   * Bring the asking window to the front.
   *
   * For one caller: somebody clicking a desktop notification about a character
   * whose window is behind everything else. A notification that cannot be
   * acted on is a notification that gets turned off, and `window.focus()` in a
   * renderer does not raise a `BrowserWindow` — only the host can.
   *
   * Answered in the window itself over the web bridge, where the tab is on the
   * viewer's machine and main is not.
   */
  raiseWindow: 'windows:raise',

  // -- app level
  /** Current options plus the path they were read from. */
  getConfig: 'config:get',
  getInternal: 'internal:get',
  /** Reveal the options file in the OS file manager. */
  revealConfig: 'config:reveal',
  /** Reveal the profiles directory, creating it if it does not exist yet. */
  revealProfiles: 'config:reveal-profiles',
  /** Reveal the session log directory in the OS file manager. */
  revealLogs: 'log:reveal',
  /**
   * List one directory under the client's home, for a window that cannot
   * open a file manager on the machine the files are on.
   *
   * Confined to the home root: a path that resolves outside it is refused
   * with a reason, never listed. See `HomeListing`.
   */
  browseHome: 'home:browse',

  /*
   * The system clipboard, read and written in main.
   *
   * Not `navigator.clipboard`. Reading it through the async clipboard API is
   * permission-gated in Chromium, and Ctrl/Cmd V only reaches the terminal at
   * all because the browser happens to bind that accelerator to an editing
   * command — this app sets no application menu, so on macOS there is nothing
   * behind Cmd V whatsoever. Main has Electron's `clipboard` module, which
   * needs neither a permission nor a menu, so copy and paste behave the same
   * on every platform and are driven from one place.
   *
   * App level, not addressed: there is one clipboard, and which character was
   * on screen when something was copied out of it says nothing about where it
   * may be pasted back in.
   */
  copyText: 'clipboard:write',
  pasteText: 'clipboard:read',

  /*
   * Writing settings back.
   *
   * Every one of these turns into a file the user owns, holding credentials, so
   * every payload is *parsed* at the boundary rather than trusted — see
   * `src/shared/drafts.ts`. They resolve to the reason they refused, or null:
   * a save that cannot produce a file the client would load is refused where
   * somebody can still fix it.
   */
  saveProfile: 'settings:save-profile',
  deleteProfile: 'settings:delete-profile',
  saveServer: 'settings:save-server',
  /** Write the options file everything is inherited from. */
  saveGlobal: 'settings:save-global',
  /**
   * Allow or block one player's `@` commands on one character.
   *
   * Its own channel rather than a `saveProfile` from the card, because the two
   * are different acts: a profile save writes every field a form holds, and the
   * card holds one name. Sending a whole draft to change a permission would
   * make the card responsible for every other setting on that character — and a
   * card that saves a stale copy of a form it never showed is how a setting
   * somebody changed in Settings gets silently reverted by a click on a card.
   */
  setRemoteGrant: 'settings:remote-grant',
  /**
   * What anybody in this character's gang may ask for, one remote at a time.
   *
   * Separate from the stance channel above because the two write different
   * things — one name's grant, and the gang's whole list — and folding them
   * into one payload would need a discriminator whose only job is to say which
   * of two fields is meaningful. See `setRemoteGrant` for why neither is a
   * `saveProfile`.
   */
  setGangRemotes: 'settings:gang-remotes',
  /** Whether this character answers `@` commands on the gangpath at all. */
  setRemoteGangpath: 'settings:remote-gangpath',
  /**
   * One automation switch, flipped from the toolbar.
   *
   * The narrow write the Gang card's two already are, and for the identical
   * reason: the toolbar shows one boolean and nothing else about the
   * character, so one boolean is what it sends. A `saveProfile` from a control
   * that can see only this would write every inherited global setting into the
   * character's own file and turn an overlay into a copy.
   */
  setAutomationSwitch: 'settings:automation-switch',
  /**
   * This character's whole supplies list, from the Self card or the item
   * panel — `automation.supplies.items`, written whole for the reason the
   * gang list is: the surface shows the whole list, and a min changed on one
   * row is one write rather than a race between two.
   */
  setSupplies: 'settings:supplies',
  deleteServer: 'settings:delete-server',
  /**
   * Files one loop in one scope's directory, from the Loops modal.
   *
   * Additive and idempotent by name — deliberately not `saveProfile`, which
   * reconciles a whole set and would take every other loop in that scope with
   * it. See `SettingsEditor.addLoop`.
   */
  addLoop: 'settings:add-loop',
  /** What a settings screen needs to draw itself: characters and servers. */
  settingsSnapshot: 'settings:snapshot',
  /**
   * A native file picker for a realm database.
   *
   * A path typed by hand is a path typed wrong, and the failure — a realm that
   * cannot be read — is only visible after connecting. Resolves to the chosen
   * path, or null if the dialog was dismissed.
   */
  chooseRealm: 'settings:choose-realm',
  /** Where to hunt from here: the lairs within reach, priced for this character. */
  huntingGrounds: 'world:hunt',
  trainers: 'world:trainers',
  banks: 'world:banks',
  itemsServing: 'world:serving',
  /** The realm's own *use this item there* rules, for the same list. */
  wards: 'world:wards',
  /** Realm rooms matching a name fragment, for the destination picker. */
  searchRooms: 'world:search',
  /** Every monster this realm names, for the priority list's picker. */
  mobNames: 'world:mobs',
  /** How much realm data is loaded. */
  worldInfo: 'world:info',
  questBook: 'world:quests',
  /** The order one quest step's several items are best fetched in. */
  questErrand: 'world:quest-errand',
  /** The steps still to do to reach one quest step, from where the character stands. */
  questPlan: 'world:quest-plan',
  /**
   * Run the plan to one step (todo 102): the card's *Run it*. Answers the
   * refusal for the press, or null once it is under way. See
   * `SessionManager.questRun`.
   */
  questRun: 'world:quest-run',
  /** Stop the run, and everything it started. */
  questStop: 'world:quest-stop',
  /** The rooms around a given one, laid out on a grid. */
  localMap: 'world:map',
  /** Everything the realm knows about one room, for a room nobody is in. */
  roomBrief: 'world:room',
  wearer: 'world:wearer',
  /**
   * Everything the realm knows about a name — monster, item or spell — for
   * the Reference card. One channel rather than one per kind, because the
   * caller has a *name* and should not have to know which table answers it.
   */
  lookup: 'world:lookup',
  /**
   * Strike an observation out of what this character has learned about the
   * realm. The player's call — an observation is one sample of one walk, and
   * a mistyped direction the server accepted looks exactly like a discovery.
   */
  forget: 'world:forget',
  forgetFind: 'world:forget-find',
  forgetCharacter: 'session:forget-character',
  /**
   * Every name the realm knows, for the console to recognise. Once per
   * session: the list is a few thousand words, and a hover must not cost a
   * round trip.
   */
  names: 'world:names',
  /** A probe command asked for from a card, sent through the arbiter. */
  ask: 'session:ask',
  /**
   * The Room card's locate button (todo 811). Its own channel rather than
   * `ask('rm')`, so main chooses the realm's word (`locate:`, `none` refused
   * out loud) and it shares the one locate ask's coalesce key.
   */
  locate: 'session:locate',
  /**
   * A gear button: put the kit back on, put it all on, take it all off, or one
   * item.
   *
   * Its own channel rather than `ask`, which takes a bare verb of at most eight
   * lowercase letters and no argument — deliberately, because that is what lets
   * it accept a string from a renderer at all. These need an *item name*, and
   * the answer is not to widen that gate but to make main decide: it holds the
   * pack, the remembered loadout and the realm's own word on what can be worn,
   * so what crosses is an action from a closed list and, for one item, a name
   * that is checked against the pack before it becomes a command.
   *
   * Resolves to how many commands were queued. The rest of the outcome — kit
   * the pack no longer holds, a list cut short by the cap — is said out loud as
   * a notice, because those are the two things a player pressing this most
   * needs to know and a number cannot carry either.
   */
  gear: 'gear:act',
  /**
   * A button beside a room's name that main runs: `Deposit All`.
   *
   * `gear:act`'s rule applied to the console, and for a sharper reason than
   * "main holds the facts". The banking sequence has to *read a fact and then
   * act on it* — send `i`, wait for the listing that answers it, and only then
   * name a figure — and a list of strings composed when the line was drawn
   * cannot express that: the `Deposit All` that shipped as `['i', 'deposit
   * 192600', 'bank']` had its number fixed before its own refresh was sent.
   * See `TerminalIntentAction`.
   *
   * Whether the client took it. False is either a refusal that has already
   * said itself out loud — the realm does not call this room a bank, and a
   * `deposit` typed anywhere else is broadcast to everybody in it — or a press
   * that rode the request already in flight, which reports its own outcome.
   */
  terminalAct: 'terminal:act',
  /**
   * A question for another player's client — `@health` at somebody, by name.
   * From the palette: `Remotes.ask` was reachable only from a party
   * forming, and a command nobody can find does not exist.
   */
  askRemote: 'remote:ask'
} as const;

/** Main -> renderer, pushed. */
export const Push = {
  /** A decoded chunk of server output. */
  data: 'session:data',
  /** Full connection state after any transition. */
  state: 'session:state',
  /** A Telnet negotiation exchange, for the diagnostics pane. */
  telnet: 'session:telnet',
  /** Engine-generated notice to display inline in the terminal. */
  notice: 'session:notice',
  /** Options were re-read from disk after the file changed. */
  config: 'config:changed',
  internal: 'internal:changed',
  /** One framed line of server output. Framing is not CRLF; see LineTokenizer. */
  line: 'session:line',
  /**
   * One record for the debug window: a chunk in, a command out, a framed line,
   * a classification, a state change, a decision.
   *
   * Rides the same diagnostics route as `Push.line` and for the same reason —
   * it arrives at stream rate and *several* records per line, so a window that
   * is not showing the view must not pay a serialisation for any of them. Main
   * records regardless; a window opening the view catches up with
   * `Invoke.getDebug`.
   */
  debug: 'session:debug',
  /** One classified line. */
  block: 'session:block',
  /** Character and room state, on change. */
  character: 'session:character',
  /**
   * What is known about the other players, whole, when it changed — never
   * with the character: the registry grows with the realm (1,200 players cost
   * 6.75ms to clone, each side, per status line) and moves far less often.
   */
  players: 'session:players',
  /** Route-walk progress, on change. */
  walk: 'walk:progress',
  loop: 'loop:progress',
  /** The decision trace, coalesced. See `AUTOMATION_PUBLISH_MS`. */
  automation: 'automation:trace',
  /**
   * The room appraised — *can I fight this?* for every monster in it and for
   * the room as a whole — on change. Beside `character` rather than inside
   * it: the state is the tracker's reading of the wire, and this is arithmetic
   * over it that needs the class row and the server's family, which only main
   * holds. See `RoomVerdict`.
   */
  verdict: 'session:verdict',
  /**
   * What the things standing in this room can be asked, for this character as
   * it stands — on change, beside the verdict and for the same reason. The
   * quest book, the counters `abil` stated, the asks this session watched and
   * the listed pack are all main's. See `asksHere`.
   */
  asks: 'session:asks',
  /** A session was loaded or unloaded. */
  sessions: 'sessions:changed',
  /** The set of characters on disk changed. */
  profiles: 'profiles:changed',
  /**
   * This character proved the realm data wrong, and wrote it down.
   *
   * The whole record, not the addition — a window that missed one push would
   * otherwise hold a record with a hole in it and no way to notice.
   */
  learned: 'world:learned',
  /**
   * What a `search` has turned up in this realm, after one turned up something.
   *
   * The whole log, for the reason `learned` sends the whole record — and
   * realm-wide rather than room-wide, because the face that reads it is a log
   * with a `Where` column and the map marks every room in it at once.
   */
  finds: 'world:finds',
  /**
   * The character in the realm may not be the one this client's records are
   * about — a different race or class, level 1 after higher, experience a
   * fraction of what it was.
   *
   * A **report**, never an instruction: what crosses is both characters and
   * what was noticed, and the answer is the player's (`Invoke.forgetCharacter`).
   * Once per session.
   */
  characterReset: 'session:character-reset',
  /**
   * The rank each quest has been *seen* to reach: a line the player typed at
   * the step's asker, or the death of the monster the step is owned by.
   *
   * Nothing on the wire announces a quest counter moving — that is what `abil`
   * is for — so this is the character's own action and nothing more, and the
   * card ranks it **under** the realm's own count. See `stepSaid` and
   * `stepKilled`.
   */
  questSaid: 'world:quest-said',
  /**
   * How a run of a quest's plan is going, on every change — which step it is
   * on, what it is doing, and why it stopped. See `QuestRunProgress`.
   */
  questRun: 'world:quest-run-progress'
} as const;

/** Both characters, and why the client thinks they are two. See `Push.characterReset`. */
export interface ResetNotice {
  signals: ResetSignal[];
  before: CharacterIdentity;
  after: CharacterIdentity;
}

export interface IpcApi {
  /**
   * Which host this window is running under. A fact the bridge states about
   * itself — the preload is only ever Electron's, the web bridge only ever a
   * browser's — so the window can decline to offer what the host cannot do.
   */
  readonly host: HostKind;

  clientReady(): void;
  input(session: SessionId, data: string): void;
  /** A talk-box line of several commands, paced by main (todo 04). */
  macro(session: SessionId, line: string): void;
  /** Drop what is still waiting of the talk box's lines. */
  dropMacro(session: SessionId): void;
  resize(session: SessionId, size: TerminalSize): void;
  /** This window started or stopped showing the diagnostics line feed. */
  diagnostics(on: boolean): void;
  /** This window started or stopped showing the debug view. */
  debugFeed(on: boolean): void;

  /**
   * Dial a character.
   *
   * The target is optional and usually omitted: a character's address is in its
   * profile, which is where a player edits it. Passing one is the ad-hoc path —
   * the palette's saved-server entries — and it does not change the profile.
   */
  connect(session: SessionId, target?: ConnectionTarget): Promise<ConnectionState>;
  disconnect(session: SessionId): Promise<ConnectionState>;
  getState(session: SessionId): Promise<ConnectionState>;
  getTelnetLog(session: SessionId): Promise<TelnetEvent[]>;
  getLines(session: SessionId): Promise<StreamLine[]>;
  /** Everything the debug ring holds, and how much it has already dropped. */
  getDebug(session: SessionId): Promise<{ records: DebugRecord[]; dropped: number }>;
  /** Writes the bug report and answers with where it went, or the failure. */
  saveDebug(session: SessionId): Promise<{ path: string } | { error: string }>;
  getCharacter(session: SessionId): Promise<CharacterState>;
  routeTo(session: SessionId, map: number, room: number): Promise<Route>;
  /**
   * Walks the plan the panel is showing.
   *
   * Resolves to what happened: walking, a refusal, or **the plan drawn again**
   * — the character moved between the drawing and the press, so the way from
   * where it now stands is what comes back, for the reader to read and press
   * again. See {@link WalkStart}. `run` is *Run it*: auto-combat turned off
   * before the first step and left off (todo 06).
   */
  walkRoute(session: SessionId, route: Route, run?: boolean): Promise<WalkStart>;
  /**
   * Start moving. `loop` names the loop the card's picker shows — null is the
   * picker's resume entry, and the name of the lap already stopped means
   * *resume it*.
   *
   * Resolves to what happened: walking, a refusal, or a question about how far
   * the character has wandered from what it was walking. `confirmed` answers
   * that question with **the figure the player was shown** — main measures
   * again and asks afresh if the journey has grown since, so a dialog left
   * standing through a death cannot become a blank cheque. See
   * {@link MovementStart}.
   */
  startMoving(
    session: SessionId,
    loop: string | null,
    confirmed: number | null
  ): Promise<MovementStart>;
  /**
   * Go and get what this route needs — every item, in turn — then walk it.
   *
   * Resolves to why it could not start, or null. The items are the ones the
   * route itself named (`itemsWanted`), by the realm's own ids and names.
   */
  collectThenWalk(
    session: SessionId,
    items: Array<{ id: number; name: string }>,
    route: Route,
    run?: boolean
  ): Promise<string | null>;
  /** Stop moving, whichever of the two is running. Keeps its place. */
  stopMoving(session: SessionId): Promise<void>;
  /**
   * Walk one room back the way the character came.
   *
   * Resolves to what happened, as {@link startMoving} does: walking, a
   * refusal, or a question — the way back needs more than one step and the
   * player is asked before a press becomes a journey. `confirmed` is the
   * figure they were shown; main measures again.
   */
  stepBack(session: SessionId, confirmed: number | null): Promise<MovementStart>;
  /**
   * The loops this session's *resolved* config defines. Asked per session
   * because a profile overlay replaces `automation.loops` — the global file's
   * list is the wrong answer for any character that states its own.
   */
  listLoops(session: SessionId): Promise<Array<{ name: string; stops: number }>>;
  /**
   * Walk a loop handed over whole, without filing it anywhere.
   *
   * Resolves to a refusal, or null, like every other loop control.
   */
  runLoop(session: SessionId, loop: Loop): Promise<string | null>;
  /** Start a named loop from `automation.loops`. Resolves to a refusal, or null. */
  startLoop(session: SessionId, name: string): Promise<string | null>;
  /** Resolves to a refusal — nothing looping — or null. */
  skipLoopStop(session: SessionId): Promise<string | null>;
  /** Resolves to a refusal — nothing looping, or not a bounce loop — or null. */
  reverseLoop(session: SessionId): Promise<string | null>;
  /**
   * Every loop the client ships, for the settings screen to choose from.
   *
   * Not addressed to a session, unlike {@link listLoops}: this is what is on
   * the shelf rather than what a character has, and the character being edited
   * may have no session at all. Asked when the picker opens rather than with
   * the rest of the settings snapshot — it is four hundred loops, and most
   * visits to that screen are about a password.
   */
  loopCatalogue(): Promise<Loop[]>;
  /**
   * The picks of a loop being built, planned. Addressed, like every world
   * query: the picks name rooms on this character's realm.
   */
  draftLoop(session: SessionId, rooms: RoomId[]): Promise<LoopDraft>;
  getWalk(session: SessionId): Promise<WalkProgress>;
  getAutomation(session: SessionId): Promise<AutomationSnapshot>;

  listSessions(): Promise<SessionSummary[]>;
  listProfiles(): Promise<ProfileSummary[]>;
  loadProfile(id: SessionId): Promise<void>;
  /** Resolves to why it refused, or null if the session was closed. */
  unloadProfile(id: SessionId, force?: boolean): Promise<string | null>;
  /** Resolves with everything needed to draw the session from cold. */
  attach(session: SessionId): Promise<AttachSnapshot>;
  detach(session: SessionId): Promise<void>;
  /** The rail's own order, remembered across restarts. See the channel. */
  reorderSessions(order: SessionId[]): Promise<void>;
  /** Each resolves to why it refused, or null. */
  popOut(session: SessionId): Promise<string | null>;
  popIn(session: SessionId): Promise<string | null>;
  gatherWindows(): Promise<string | null>;
  /** Bring this window to the front. See the channel. */
  raiseWindow(): Promise<void>;

  getConfig(): Promise<ConfigSnapshot>;
  /** The client's internal settings — the palette's pinned commands live here. */
  getInternal(): Promise<InternalConfig>;
  /** Each resolves to what happened: opened on the desktop, or a path to list. */
  revealConfig(): Promise<Revealed>;
  revealProfiles(): Promise<Revealed>;
  revealLogs(): Promise<Revealed>;
  /**
   * A directory under the client's home, or the one holding the file named.
   * Null means the root. Never contents — see `HomeListing`.
   */
  browseHome(target: string | null): Promise<HomeListing>;
  /** Put the terminal's selection on the system clipboard. */
  copyText(text: string): Promise<void>;
  /** What is on the system clipboard, for a paste into the terminal. */
  pasteText(): Promise<string>;

  /** Each resolves to why it refused, or null if it was written. */
  saveProfile(id: string, draft: ProfileDraft): Promise<string | null>;
  deleteProfile(id: string): Promise<string | null>;
  saveServer(previousName: string | null, draft: ServerDraft): Promise<string | null>;
  deleteServer(name: string): Promise<string | null>;
  /**
   * Writes the options file everything is inherited from.
   *
   * Resolves to *why it refused*, or null, like every other save here: a
   * settings screen that throws at the renderer takes every character's socket
   * with it.
   */
  saveGlobal(draft: GlobalDraft): Promise<string | null>;
  /**
   * Writes one player's whole grant — what they may ask for and what they may
   * never — or removes them when it is empty.
   *
   * The **whole grant** rather than one remote at a time, because the surface
   * that sends it shows the whole grant: a flyout that had to send twenty
   * messages to answer one press of *Allow all* would be twenty rewrites of the
   * user's YAML racing each other, and the last one to land would win.
   *
   * Resolves to why it refused, or null, like every other save here.
   */
  setRemoteGrant(session: SessionId, name: string, grant: RemoteGrant): Promise<string | null>;
  /** Writes this character's whole gang list, for the same reason. */
  setGangRemotes(session: SessionId, remotes: RemoteName[]): Promise<string | null>;
  /** Turns gangpath answering on or off for one character. */
  setRemoteGangpath(session: SessionId, on: boolean): Promise<string | null>;
  /**
   * Flips one `automation:` boolean in a character's own file.
   *
   * `name` is an {@link AutomationSwitch}; anything else is refused in main
   * rather than trusted, because this crossed the wire.
   */
  setAutomationSwitch(
    session: SessionId,
    name: AutomationSwitch,
    on: boolean
  ): Promise<string | null>;
  /** Writes this character's whole supplies list. See `Invoke.setSupplies`. */
  setSupplies(session: SessionId, items: SupplyItem[]): Promise<string | null>;
  /**
   * Puts one loop into one scope, and reports why not.
   *
   * `owner` names the character or realm for the two narrow scopes and is
   * ignored for `global`. Resolves to a refusal, or null — the same shape
   * every other write from a card takes.
   */
  addLoop(scope: LoopScope, owner: string | null, loop: Loop): Promise<string | null>;
  settingsSnapshot(): Promise<SettingsSnapshot>;
  chooseRealm(): Promise<string | null>;
  /*
   * Addressed, like every push: with a realm per character, an unaddressed
   * query would answer from whichever realm happened to be the client's — and a
   * destination found on one character's realm and walked on another's is a
   * route to a room that does not exist.
   */
  /*
   * The realm's own row, whole -- the route panel's head reads its exits, its
   * shop and its lair off this same answer -- plus when this machine last
   * walked there, which is what puts the recent ones on top.
   */
  searchRooms(session: SessionId, query: string): Promise<Array<WorldRoom & Visited>>;
  /**
   * The monsters this realm names, for the priority list.
   *
   * Addressed like every other world query: two characters may play different
   * realms, and a monster ranked from one realm's list means nothing on
   * another's. Suggestions only — the field stays typable, as the potion
   * picker's does, so a realm the client holds no data for can still be
   * ranked by hand.
   */
  mobNames(session: SessionId): Promise<string[]>;
  worldInfo(session: SessionId): Promise<{ rooms: number; source: string }>;
  /**
   * Every quest this realm scripts, assembled from its own text blocks.
   *
   * Asked for when the card is opened rather than pushed with the character:
   * it is 39 quests of 251 steps on the shipped realm, it changes only when
   * the realm file does, and most of what a session pushes is about the
   * fight. The same reasoning the loop catalogue's own query records.
   */
  questBook(session: SessionId): Promise<Quest[]>;
  /**
   * The order one step's several items are best fetched in, from where this
   * character is standing now (todo 01).
   *
   * Addressed and asked on demand, for `huntingGrounds`' reasons and one more:
   * it is a travelling salesman's path over the realm's own graph, it costs a
   * sweep per place, and it is only worth asking about the step the character
   * is actually on. Null where the step demands fewer than two things the
   * realm places anywhere, which is where there is no walk to order.
   */
  questErrand(session: SessionId, block: number): Promise<QuestErrand | null>;
  /**
   * The plan to reach one step: what each step gathers, where it happens and
   * whether the way there exists — steps, never rooms. `marked` is the rank
   * the player has said they are at, handed in so main ranks the three
   * readings exactly as the card does. Null for a block no quest holds.
   */
  questPlan(session: SessionId, block: number, marked: number | null): Promise<QuestPlan | null>;
  /** Run the plan to one step. The refusal for the press, or null once under way. */
  questRun(session: SessionId, block: number, marked: number | null): Promise<string | null>;
  /** Stop the run, and everything it started. */
  questStop(session: SessionId): Promise<void>;
  localMap(session: SessionId, map: number, room: number, radius?: number): Promise<LocalMap>;
  /**
   * The realm's whole answer about one room — its ways out, the place it
   * holds, what its lair spawns, the spell it casts on whoever stands in it.
   *
   * Asked on demand rather than pushed, unlike the same facts about the room
   * the character is standing in: this is about a room on the *map* or on a
   * route list, so which room it is changes with the pointer, and there are
   * fifty-seven thousand of them. Null for a room the realm does not hold.
   */
  roomBrief(session: SessionId, map: number, room: number): Promise<RoomBrief | null>;
  /**
   * Where this character should hunt: every lair the exits reach from where
   * it stands, priced by the realm's own respawn clock and the same
   * arithmetic the Room card prices a fight with, the loop sized to the clock
   * and filled from the lairs beside it, best first. Addressed, and asked on
   * demand — the sweep and the pricing are work, and the steps move with the
   * character. `measure` names one row past the measured few to measure too.
   */
  huntingGrounds(session: SessionId, measure: string | null): Promise<HuntingAdvice>;
  /**
   * The trainers that will take this character, cheapest first (todo 18).
   *
   * Addressed, because the answer depends on this character's level and
   * class, and asked on demand — the settings screen's picker is the reader,
   * and a list that would be stale the moment the character levels has no
   * business on a push.
   *
   * Empty where the realm states no bands (a world built before format 35),
   * where the character's level is unread, or where nothing takes it. All
   * three are the same answer to the player: there is nowhere to send you,
   * and the picker says so rather than offering a room that will refuse.
   */
  trainers(session: SessionId): Promise<TrainerChoice[]>;
  /**
   * Every bank counter this character's realm places (todo 00).
   *
   * Addressed, like `trainers`, because which realm is loaded is a property of
   * the session — the shipped worlds place different counters, and a row id
   * means nothing across two of them.
   */
  banks(session: SessionId): Promise<BankChoice[]>;
  /**
   * The items the realm says would serve each condition a potion rule can
   * name — the picker's suggestions (todo 19).
   *
   * One call for every condition rather than one per row: the answer is a
   * property of the realm, not of the character, and the settings screen draws
   * several rows at once. Keyed by condition, empty where the realm names
   * nothing or holds no data.
   *
   * Addressed only to find the realm this character is on; nothing about the
   * character narrows it. Suggestions, never a gate: a derivative realm may
   * hold an item the shipped data lacks, and the field stays typable.
   */
  itemsServing(session: SessionId): Promise<Partial<Record<PotionWhen, string[]>>>;
  /**
   * The realm's own half of the same list: a room spell, the spell that
   * stops it, and the item whose use casts that spell (todo 02).
   *
   * A property of the realm exactly as `itemsServing` is, and addressed for
   * the same reason — to find which realm this character is on. Empty where
   * no world is loaded, which draws no rows and leaves the switch alone.
   */
  wards(session: SessionId): Promise<WardRule[]>;
  /**
   * Who this character is, in the realm's own row ids, for deciding what may
   * go on.
   *
   * Its own query, and the one world lookup the renderer still makes: it is
   * a fact about the *character* rather than about a room or a thing, so it
   * has no entity to ride on and changes when a stat sheet prints.
   *
   * The four that used to sit beside it — `shopHere`, `lairHere`,
   * `answersHere`, `itemsKnown` — are gone (2026-09-02): every one of them
   * asked main for a fact main already had at the moment the room or the
   * listing was parsed, and each was a React effect that ran *after* the
   * card had drawn once without the answer. They are fields on the entities
   * in `CharacterState` now.
   *
   * Resolved in main because the race and class tables live there — see
   * `WorldGraph.raceId`. Every field is null until a stat sheet has printed,
   * and null means *unknown*, which never refuses.
   */
  wearer(session: SessionId): Promise<Wearer>;
  lookup(session: SessionId, query: string): Promise<WorldLookup>;
  /** Whether there was such an observation to strike. The push that follows carries the rest. */
  forget(session: SessionId, discovery: Pick<Discovery, 'from' | 'command'>): Promise<boolean>;
  /** Whether there was such a find to strike. The push that follows carries the rest. */
  forgetFind(session: SessionId, find: Pick<Find, 'room' | 'name'>): Promise<boolean>;
  /**
   * Throws away what this client kept about the character that was here before.
   *
   * Only ever from a player answering the reset prompt. What goes is what is
   * about a *character*; what is about the realm stays, because none of it
   * stopped being true. Whether there was anything to throw away.
   */
  forgetCharacter(session: SessionId): Promise<boolean>;
  names(session: SessionId): Promise<WorldNames>;
  /** Whether the arbiter took it. */
  ask(session: SessionId, command: string): Promise<boolean>;
  /** Asks the realm where the character stands, in its own word. False is a refusal already said. */
  locate(session: SessionId): Promise<boolean>;
  /** A gear button. Resolves to how many commands were queued. See the channel. */
  gear(session: SessionId, action: GearAction, item?: string): Promise<number>;
  /** A console button main runs. Whether it was taken; a refusal says so itself. */
  terminalAct(session: SessionId, action: TerminalActionName): Promise<boolean>;
  /**
   * Telepaths `@<name>` at `who`, on this character's behalf. Whether the
   * arbiter took it: false at a menu, and false for a repeat of a question
   * still waiting to go, which is coalesced into the one already queued.
   */
  askRemote(session: SessionId, who: string, name: RemoteName): Promise<boolean>;

  onData(handler: (message: Addressed<StreamChunk>) => void): () => void;
  onState(handler: (message: Addressed<ConnectionState>) => void): () => void;
  onTelnet(handler: (message: Addressed<TelnetEvent>) => void): () => void;
  onLine(handler: (message: Addressed<StreamLine>) => void): () => void;
  onDebug(handler: (message: Addressed<DebugRecord>) => void): () => void;
  onBlock(handler: (message: Addressed<Block>) => void): () => void;
  onCharacter(handler: (message: Addressed<CharacterState>) => void): () => void;
  onPlayers(handler: (message: Addressed<PlayerRegistry>) => void): () => void;
  onWalk(handler: (message: Addressed<WalkProgress>) => void): () => void;
  onLoop(handler: (progress: Addressed<LoopProgress>) => void): () => void;
  onAutomation(handler: (message: Addressed<AutomationSnapshot>) => void): () => void;
  onVerdict(handler: (message: Addressed<RoomVerdict>) => void): () => void;
  onAsks(handler: (message: Addressed<RoomAsk[]>) => void): () => void;
  onNotice(handler: (notice: Notice) => void): () => void;
  onSessions(handler: (sessions: SessionSummary[]) => void): () => void;
  onProfiles(handler: (profiles: ProfileSummary[]) => void): () => void;
  onLearned(handler: (message: Addressed<Discovery[]>) => void): () => void;
  onFinds(handler: (message: Addressed<Find[]>) => void): () => void;
  onCharacterReset(handler: (message: Addressed<ResetNotice>) => void): () => void;
  onQuestSaid(handler: (message: Addressed<QuestWatched>) => void): () => void;
  onQuestRun(handler: (message: Addressed<QuestRunProgress>) => void): () => void;
  onConfig(handler: (snapshot: ConfigSnapshot) => void): () => void;
  onInternal(handler: (config: InternalConfig) => void): () => void;
}
