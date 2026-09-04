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
import type { CharacterState } from './character';
import type { GearAction, Wearer } from './gear';
import type {
  AlertsUiConfig,
  AutomationSwitch,
  AutomationSwitches,
  CombatConfig,
  ConfigSnapshot,
  HealthConfig,
  MovementConfig,
  RemotesConfig,
  TalkConfig,
  Server,
  SpellsConfig,
  RetreatStrategy,
  PartyConfig,
  PvpAction,
  SuppliesConfig,
  SupplyItem
} from './config';
import type { GlobalDraft, LoginStepDraft, ProfileDraft, ServerDraft } from './drafts';
import type { RemoteGrant, RemoteName } from './remotes';
import type { CureGates, SpellTargeting } from './spellcraft';
import type { ThemePreference } from './themes';
import type { ProfileAccent } from './profiles';
import type { InternalConfig } from './internal';
import type { Loop, LoopProgress, LoopScope, ScopedLoop } from './loops';
import type { WalkProgress } from './walk';
import type { Route, WorldLookup, WorldNames, WorldRoom } from './world';
import type { Visited } from './destinations';
import type {
  ConnectionState,
  ConnectionTarget,
  StreamChunk,
  StreamLine,
  TelnetEvent,
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
  walk: WalkProgress;
  loop: LoopProgress;
  automation: AutomationSnapshot;
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
  /** Resolved, so inherited values show. */
  hangUp: {
    enabled: boolean;
    belowHealth: number;
    onlyWhenClean: boolean;
    onPlayerInRoom: boolean;
  };
  retreat: {
    enabled: boolean;
    belowHealth: number;
    whenOutnumbered: number;
    strategy: RetreatStrategy;
    safeHavenRoom: string;
  };
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
  /**
   * Whether this character answers another player's `@` commands. Resolved.
   *
   * Per character, because *which* character is reachable is the decision
   * somebody actually makes: a pair run together answering each other, and the
   * one being played by hand left out of it.
   */
  remotes: RemotesConfig;
  /** What this character learns about other people. Resolved, like the rest. */
  talk: TalkConfig;
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
  diagnostics: 'client:diagnostics'
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
  /** Current character and room state, for a renderer that mounted mid-session. */
  getCharacter: 'session:get-character',
  /** A* route from where the character is to a chosen room. */
  routeTo: 'world:route',
  /** Walk a planned route. Returns why it could not start, or null. */
  walkRoute: 'walk:start',
  /** Abandon the walk in progress. */
  stopWalk: 'walk:stop',
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
  stopLoop: 'loop:stop',
  /** Hold the loop where it is, and end the leg being walked. */
  pauseLoop: 'loop:pause',
  /** Walk on from wherever the character actually is. */
  resumeLoop: 'loop:resume',
  /** Give up on the current stop and head for the next. */
  skipLoopStop: 'loop:skip',
  /** Turn a bounce loop round. Refused for a plain loop. */
  reverseLoop: 'loop:reverse',
  /** The loops the client ships, for the settings screen to offer. */
  loopCatalogue: 'loop:catalogue',
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
  /** Realm rooms matching a name fragment, for the destination picker. */
  searchRooms: 'world:search',
  /** How much realm data is loaded. */
  worldInfo: 'world:info',
  /** The rooms around a given one, laid out on a grid. */
  localMap: 'world:map',
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
  /**
   * Every name the realm knows, for the console to recognise. Once per
   * session: the list is a few thousand words, and a hover must not cost a
   * round trip.
   */
  names: 'world:names',
  /** A probe command asked for from a card, sent through the arbiter. */
  ask: 'session:ask',
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
  /** One classified line. */
  block: 'session:block',
  /** Character and room state, on change. */
  character: 'session:character',
  /** Route-walk progress, on change. */
  walk: 'walk:progress',
  loop: 'loop:progress',
  /** The decision trace, coalesced. See `AUTOMATION_PUBLISH_MS`. */
  automation: 'automation:trace',
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
  learned: 'world:learned'
} as const;

export interface IpcApi {
  clientReady(): void;
  input(session: SessionId, data: string): void;
  resize(session: SessionId, size: TerminalSize): void;
  /** This window started or stopped showing the diagnostics line feed. */
  diagnostics(on: boolean): void;

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
  getCharacter(session: SessionId): Promise<CharacterState>;
  routeTo(session: SessionId, map: number, room: number): Promise<Route>;
  /** Resolves to the reason the walk could not start, or null if it did. */
  walkRoute(session: SessionId, route: Route): Promise<string | null>;
  stopWalk(session: SessionId): Promise<void>;
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
  stopLoop(session: SessionId): Promise<void>;
  pauseLoop(session: SessionId): Promise<void>;
  /** Resolves to a refusal — not paused, not in the realm — or null. */
  resumeLoop(session: SessionId): Promise<string | null>;
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

  getConfig(): Promise<ConfigSnapshot>;
  /** The client's internal settings — the palette's pinned commands live here. */
  getInternal(): Promise<InternalConfig>;
  revealConfig(): Promise<void>;
  revealProfiles(): Promise<void>;
  revealLogs(): Promise<void>;
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
  worldInfo(session: SessionId): Promise<{ rooms: number; source: string }>;
  localMap(session: SessionId, map: number, room: number, radius?: number): Promise<LocalMap>;
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
  names(session: SessionId): Promise<WorldNames>;
  /** Whether the arbiter took it. */
  ask(session: SessionId, command: string): Promise<boolean>;
  /** A gear button. Resolves to how many commands were queued. See the channel. */
  gear(session: SessionId, action: GearAction, item?: string): Promise<number>;
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
  onBlock(handler: (message: Addressed<Block>) => void): () => void;
  onCharacter(handler: (message: Addressed<CharacterState>) => void): () => void;
  onWalk(handler: (message: Addressed<WalkProgress>) => void): () => void;
  onLoop(handler: (progress: Addressed<LoopProgress>) => void): () => void;
  onAutomation(handler: (message: Addressed<AutomationSnapshot>) => void): () => void;
  onNotice(handler: (notice: Notice) => void): () => void;
  onSessions(handler: (sessions: SessionSummary[]) => void): () => void;
  onProfiles(handler: (profiles: ProfileSummary[]) => void): () => void;
  onLearned(handler: (message: Addressed<Discovery[]>) => void): () => void;
  onConfig(handler: (snapshot: ConfigSnapshot) => void): () => void;
  onInternal(handler: (config: InternalConfig) => void): () => void;
}
