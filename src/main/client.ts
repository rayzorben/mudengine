/**
 * The client: every session, every store, the realm data and every handler
 * behind `IpcApi` — built once by `startClient`, for whichever host
 * `src/main/index.ts` chose.
 *
 * Responsibilities are deliberately narrow: own one `SessionHost`, and bridge
 * it to the renderer over the typed IPC contract in `@shared/ipc`. No
 * parsing, no game logic — and, since 2026-09-07, **no `electron`**: what a
 * desktop window, a file manager, a native picker or a clipboard is has to be
 * asked of the `Host` (`host/Host.ts`), because the same client is served to
 * a browser tab (`host/WebHost.ts`) where none of those exist. A host that
 * cannot do something says so, and every refusal below is worded for the
 * window that will show it.
 */
import fs from 'node:fs/promises';
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';

import { ConfigStore } from './config/ConfigStore';
import { reconcileWithTemplate } from './config/reconcile';
import { InternalStore } from './config/InternalStore';
import { setTuning, tuning } from './app/tuning';
import { ProfileStore, type ProfileSnapshot } from './config/ProfileStore';
import { ServerStore } from './config/ServerStore';
import { LoopStore } from './config/LoopStore';
import { SettingsEditor, type SettingsEditorOptions } from './config/SettingsEditor';
import { LoopCatalogue } from './config/LoopCatalogue';
import { migrateHome } from './config/Migration';
import { homeAt, homeRoot, type Home } from './app/home';
import { WorldGraph, type Traveller } from './world/WorldGraph';
import { RealmLibrary } from './world/RealmLibrary';
import { REALM_EXTENSIONS } from './world/RealmSource';
import { WorldMemory } from './world/WorldMemory';
import { FindBook } from './world/FindBook';
import { WorldBook } from './world/WorldBook';
import { SplitMemory } from './world/SplitMemory';
import type { RealmMemory } from './session/SessionManager';
import { RealmLore, realmKey } from './world/RealmLore';
import { PlayerBook, realmAddress } from './world/PlayerBook';
import { cureGates, spellTargeting } from '../shared/spellcraft';
import { DestinationBook, type RealmDestinations } from './world/DestinationBook';
import { bareName } from '../shared/items';
import { nameAnswersTo } from '../shared/world';
import {
  dropAllPlan,
  equip,
  equipAllPlan,
  GEAR_ACTIONS,
  restorePlan,
  equipBlock,
  isWearable,
  unequip,
  type GearAction,
  type GearPlan,
  type Wearer
} from '../shared/gear';
import { Belongings, peekSpellbook } from './session/Belongings';
import type { BelongingsSink } from '../shared/belongings';
import { NO_LORE, type MobLore } from '../shared/lore';
import { SpellMessageBook, spellLoreOf, type SpellLore } from '../shared/spell-messages';
import { loadSpellMessages } from './world/SpellMessages';
import { NO_REALM_PLAYERS, type RealmPlayers } from '../shared/players';
import { NO_FIGHTS, type FightSink } from '../shared/fights';
import { FightLog } from './session/FightLog';
import { NO_TALK, TalkLog, type TalkSink } from './session/TalkLog';
import type { MobLoreEntry } from '../shared/lore';
import type { MovementStart } from '../shared/movement';
import type { FightSummary } from '../shared/fights';
import { localMap } from './world/localMap';
import { roomBrief } from './world/roomBrief';
import type { HuntingAdvice } from '../shared/hunting';
import { SessionHost } from './session/SessionHost';
import { WindowRegistry } from './windows/WindowRegistry';
import { Workspace } from './windows/Workspace';
import { quitGuard, type QuitAnswer } from './app/quit';
import { t } from './app/i18n';
import { listHome } from './app/browse';
import { claimHome, type HomeLock } from './app/homeLock';
import type { Caller, Host } from './host/Host';
import {
  Invoke,
  Push,
  Send,
  type AttachSnapshot,
  type HomeListing,
  type Notice,
  type ProfileSummary,
  type Revealed,
  type SessionId
} from '../shared/ipc';
import {
  asAutomationSwitch,
  type SupplyItem,
  automationSwitches,
  DEFAULT_CONFIG,
  type AppConfig
} from '../shared/config';
import { DEFAULT_INTERNAL } from '../shared/internal';
import { isRemoteName, REMOTE_NAMES, type RemoteGrant, type RemoteName } from '../shared/remotes';
import type { Profile } from '../shared/profiles';
import type { SessionSummary } from '../shared/ipc';
import { EMPTY_CHARACTER } from '../shared/character';
import { IDLE_WALK } from '../shared/walk';
import { isLoopScope, mergeLoops, NO_LOOP } from '../shared/loops';
import { EMPTY_AUTOMATION } from '../shared/automation';
import { EMPTY_ROOM_VERDICT } from '../shared/verdict';
import { EMPTY_MAP } from '../shared/map';
import {
  asRoomIds,
  asRoomReference,
  asRoute,
  EMPTY_LOOP_DRAFT,
  roomId,
  type MobPlaces,
  type ShopPlace
} from '../shared/world';
import { LoopDraftCache } from './world/loopDraft';
import { errorMessage } from '../shared/values';
import { formatDebugReport } from '../shared/debug';
import { fileSlug } from '../shared/files';
/*
 * The one field, by name. A default import would inline the whole manifest into
 * the main chunk — the maintainer's email address and every dependency's name
 * along with it — for one string. Vite turns a JSON module into named exports,
 * so this tree-shakes to the version and nothing else. Same instinct as the
 * comment stripping in `electron.vite.config.ts`: what ships is what somebody
 * is handed.
 */
import { version as APP_VERSION } from '../../package.json';
import {
  asConnectionTarget,
  TERMINAL_ACTIONS,
  type ConnectionTarget,
  type TerminalActionName,
  type TerminalSize
} from '../shared/types';
import {
  asGlobalDraft,
  asLoop,
  asProfileDraft,
  asProfileId,
  asServerDraft,
  LOOP_LIMITS
} from '../shared/drafts';

/**
 * What is hosting this client. Assigned first thing in `startClient`, before
 * anything below can run: every function in this module is reached from a
 * handler, a store callback or a timer, and none of those exists until the
 * host has been handed over.
 */
let platform: Host;

/**
 * Where everything the client owns lives. Decided once, before anything reads.
 *
 * Not lazily and not per record: five different places used to join a path onto
 * `path.dirname(the options file)`, and a record written to the wrong directory
 * is not an error — it is a file nobody ever reads again. See `app/home.ts`.
 * Set beside `platform`, from the host's answer for the platform's own place.
 */
let asked: ReturnType<typeof homeRoot>;
let home: Home;
/**
 * The home, held for the life of the process. Taken before anything reads a
 * file and released last; see `app/homeLock.ts` for why a host's own
 * instance lock is not enough.
 */
let homeLock: HomeLock | null = null;

/** What a session that has never been dialled reports. Keeps `attach` total. */
const IDLE_STATE = {
  phase: 'idle' as const,
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

let config: ConfigStore | null = null;
/** The client's own settings, beside the options file. See `shared/internal.ts`. */
let internal: InternalStore | null = null;
let profiles: ProfileStore | null = null;
/** The servers on disk: `servers/<id>/server.yaml`. See `ServerStore`. */
let servers: ServerStore | null = null;
/** The loops on disk, at all three scopes. See `LoopStore`. */
let loops: LoopStore | null = null;
/**
 * Every realm the client has been asked for.
 *
 * One graph per realm *file*, shared by every character that names it — 55,806
 * rooms indexed twice is a cost nobody asked for, and two characters on one
 * realm is the ordinary case.
 */
let realms: RealmLibrary | null = null;
let worldBook: WorldBook | null = null;
/**
 * Monster health learned by fighting, for every realm played.
 *
 * One store rather than one per character: it is keyed by realm, and two
 * characters on one realm should share what either of them learns. The file is
 * resolved from the options file's own directory so `MUDENGINE_CONFIG`
 * relocates it with everything else.
 */
let lore: RealmLore | null = null;
/** The shipped spell message table, read once on first use. See `spellLoreFor`. */
let spellMessages: SpellMessageBook | null = null;
/**
 * What is known about the other players on every realm dialled.
 *
 * One store, keyed by the address a character dials, so every character on a
 * realm shares what any of them sees — Soul's kit is Soul's whichever
 * character looked — and none inherits another realm's people. See `PlayerBook`.
 */
let playerBook: PlayerBook | null = null;
/**
 * Where characters on this machine have walked, per realm.
 *
 * One store, keyed on the realm *file* rather than on the address dialled — the
 * opposite of `playerBook` above, and deliberately: a destination is a room
 * **id**, and an id only means a place within the realm data that defines it.
 * Two servers sharing one map share these rooms; one server whose map was
 * swapped underneath it does not. See `DestinationBook`.
 */
let destinations: DestinationBook | null = null;
/** Which window shows which characters. See `Workspace`. */
let workspace: Workspace | null = null;

/**
 * Windows are views; sessions are the app's. Neither owns the other, which is
 * what makes closing a window safe and popping a tab out possible.
 */
const windows = new WindowRegistry();
let host: SessionHost | null = null;

/**
 * The realm knowledge base, loaded once.
 *
 * 55,806 rooms from a 655 KB gzipped file; the parse is well under a second and
 * happens before the window is shown. Querying it per line, which is what the
 * CoffeeScript engine did against SQLite, is the thing this exists to avoid.
 */
/**
 * Monster health learned by fighting.
 *
 * Beside the options file, so `MUDENGINE_CONFIG` relocates it along with the
 * characters and the realm cache — and so a smoke run cannot write into the
 * developer's own. Created after the config is resolved for exactly that
 * reason: the directory is not known until then.
 */
function createLore(): RealmLore {
  return new RealmLore({
    file: home.state('mob-lore.json'),
    notify: (message) => announce('lore', message)
  });
}

/** Beside the lore, for the same reasons `createLore` gives. */
function createDestinations(): DestinationBook {
  return new DestinationBook({
    file: home.state('destinations.json'),
    notify: (message) => announce('world', message)
  });
}

/** Beside the lore, for the same reasons `createLore` gives. */
function createPlayerBook(): PlayerBook {
  return new PlayerBook({
    file: home.state('players.json'),
    notify: (message) => announce('players', message)
  });
}

/** Which world each address has said it runs. Beside the lore, like the rest. */
function createWorldBook(): WorldBook {
  return new WorldBook({
    file: home.state('worlds.json'),
    notify: (message) => announce('world', message)
  });
}

function createRealms(): RealmLibrary {
  return new RealmLibrary({
    shippedDir: path.join(resourcesDir(), 'world'),
    /*
     * So a realm can name a database **beside the client's own files**,
     * relatively. No shipped realm does today -- the six that ship are Paradigm
     * and the built-in world is Paradigm's own database -- but `GMUD (5X)` did
     * until 2026-09-05, and the rule it established stands: an absolute path in
     * a shipped file exists on the one computer that wrote it, so the answer
     * for a database carried alongside the client is a relative path and
     * `RealmLibrary.resolve` is the one place that knows what it resolves
     * against.
     */
    resourcesDir: resourcesDir(),
    // Beside the options file, so `MUDENGINE_CONFIG` relocates it too and the
    // smoke test needs no second variable to forget.
    cacheDir: home.state('realms'),
    // Converting a realm takes a couple of seconds and happens while somebody
    // is watching a blank terminal wondering whether it worked.
    notify: (message) => announce('world', message, 'log')
  });
}

/**
 * The realm a character plays against.
 *
 * The **server's** database, not the character's: two characters on one realm
 * walk one map, so it is stated once beside the host and the menu script. See
 * `Server.database`. A realm stating none walks whichever bundled world it
 * named at its menu on an earlier connection (`WorldBook`), and the default
 * one, announced, until it has.
 *
 * Read through `profileFor` rather than captured, so an edited realm takes
 * effect on the next session rather than on the next restart. A session with no
 * profile — one whose file went while it was connected — gets the default
 * world, which is the honest answer when there is nothing left to ask.
 */
function worldFor(id: SessionId): WorldGraph | undefined {
  const profile = profileFor(id);
  const learned = profile ? (worldBook?.at(realmAddress(profile.target)) ?? null) : null;
  return realms?.load(profile?.database ?? '', learned).graph;
}

/**
 * What is known about the monsters this character will meet.
 *
 * Keyed on the realm rather than on the character: how much health a giant rat
 * has is a fact about the world, so four characters on one realm share what any
 * of them learns and none of them inherits another realm's monsters. See
 * `RealmLore`.
 */
function loreFor(id: SessionId): MobLore {
  const world = worldFor(id);
  // Before the store exists there is nothing to learn from and nowhere to
  // learn to, which is the honest answer rather than a reason to throw.
  return lore?.forRealm(world?.info.source ?? 'none', world) ?? NO_LORE;
}

/**
 * The sentences a spell prints when it lands and when it ends.
 *
 * The shipped half is one file for every realm (`resources/world/
 * spell-messages.csv`, the server's message data by spell name); the learned
 * half is kept by `RealmLore` beside the monster health, keyed on the realm
 * for the same reason — a sentence the server prints for a spell is a fact
 * about the world. Before the store exists the shipped table is still read,
 * and what is learned then goes nowhere, which is the honest answer.
 */
function spellLoreFor(id: SessionId): SpellLore {
  spellMessages ??= loadSpellMessages(
    path.join(resourcesDir(), 'world', 'spell-messages.csv'),
    (message) => announce('world', message)
  );
  const world = worldFor(id);
  return (
    lore?.spellsFor(world?.info.source ?? 'none', spellMessages) ??
    spellLoreOf(spellMessages, new SpellMessageBook())
  );
}

/**
 * Where this character's realm has been walked to.
 *
 * Keyed on the realm file, exactly as `loreFor` is, because a destination is a
 * room **id** and an id only means a place within the data that defines it.
 * Before the store exists there is nowhere to write and nothing to read, and a
 * pair of no-ops is the honest answer rather than a reason to throw.
 */
function destinationsFor(id: SessionId): RealmDestinations {
  const world = worldFor(id);
  return (
    destinations?.forRealm(world?.info.source ?? 'none') ?? {
      remember: () => {},
      matching: () => []
    }
  );
}

/**
 * What is known about the other players at one address.
 *
 * Keyed on the **address dialled**, not on the world file the lore uses: Soul
 * on GreaterMUD is not Soul on a MajorMUD board that ships the same map data,
 * and two server entries that dial one address are one realm. The host asks
 * with the address each connection actually goes to.
 */
function playersAt(target: ConnectionTarget): RealmPlayers {
  return playerBook?.forRealm(realmAddress(target)) ?? NO_REALM_PLAYERS;
}

/** The same, for where a character's own file says it plays — what a session starts seeded from. */
function playersFor(id: SessionId): RealmPlayers {
  const target = profileFor(id)?.target;
  return target ? playersAt(target) : NO_REALM_PLAYERS;
}

/**
 * Where what a character has learned about its realm is kept.
 *
 * One file per character, beside the options file and the profiles — which is
 * what makes `MUDENGINE_CONFIG` relocate it with everything else, and what keeps
 * a test run from writing into somebody's real record.
 *
 * Kept open for the life of the session and closed on quit, so the deferred
 * write has somewhere to land. Built lazily rather than per call: a store
 * constructed on every block would re-read the file on every block.
 */
const memories = new Map<SessionId, WorldMemory>();
/**
 * The realm-wide half of each character's memory, one store per realm.
 *
 * What a shop turns out to stock is a fact about the *world*, not about
 * whichever character walked in and typed `list` — the same reasoning that puts
 * learned monster health in `RealmLore` and other players in `PlayerBook`. Kept
 * per character it was re-learned by every character in turn, each spending the
 * command that teaches it. Keyed on the realm file, like the lore, because the
 * room numbers only mean the same places within one map.
 */
const realmMemories = new Map<string, WorldMemory>();

/** The shared half for a realm, created on first use. See `realmMemories`. */
function realmMemoryFor(realm: string): WorldMemory {
  const existing = realmMemories.get(realmKey(realm));
  if (existing) return existing;
  const store = new WorldMemory(
    home.state('memory', `realm-${realmKey(realm)}.json`),
    realm,
    (message) => announce('memory', message)
  );
  realmMemories.set(realmKey(realm), store);
  return store;
}

/**
 * One find log per realm, created on first use.
 *
 * Keyed exactly as `realmMemories` is and for the same reason: a room number
 * only means a place within one map, so a find written against the shipped
 * realm says nothing about a private one.
 */
const realmFinds = new Map<string, FindBook>();

function findsFor(id: SessionId): FindBook | undefined {
  const realm = worldFor(id)?.info.source;
  // Nothing to be wrong about and nothing to write against: see `memoryFor`.
  if (realm === undefined) return undefined;
  return findsForRealm(realm);
}

function findsForRealm(realm: string): FindBook {
  const existing = realmFinds.get(realmKey(realm));
  if (existing) return existing;
  const store = new FindBook(
    home.state('memory', `finds-${realmKey(realm)}.json`),
    realm,
    (message) => announce('memory', message)
  );
  realmFinds.set(realmKey(realm), store);
  return store;
}

function memoryFor(id: SessionId): WorldMemory | undefined {
  const existing = memories.get(id);
  if (existing) return existing;

  const world = worldFor(id);
  /*
   * Keyed by realm, because an edge learned on the shipped realm says nothing
   * about a private one — the room numbers do not even mean the same places.
   * With no realm data at all there is nothing to be wrong about and nothing
   * to learn against, so nothing is kept.
   */
  const realm = world?.info.source;
  if (realm === undefined) return undefined;

  const store = new WorldMemory(home.state('memory', `${id}.json`), realm, (message) =>
    announce('memory', message)
  );
  memories.set(id, store);
  return store;
}

/**
 * What a session learns about its realm — its own exits, and the realm's shops.
 *
 * See `SplitMemory`: an exit is this character's exploration and a shop's stock
 * is the world's, so the two halves are kept in two files and routed by reason.
 */
function splitMemoryFor(id: SessionId): RealmMemory | undefined {
  const own = memoryFor(id);
  if (!own) return undefined;
  const realm = worldFor(id)?.info.source;
  // `memoryFor` already returned undefined without a realm, so this is only
  // reachable with one; checked rather than asserted because the two reads are
  // separate calls and an unchecked `!` here would be a claim about that.
  if (realm === undefined) return own;
  return new SplitMemory(own, realmMemoryFor(realm));
}

/**
 * Where a character's fights are written down.
 *
 * Beside the options file like the memory and the lore, so `MUDENGINE_CONFIG`
 * relocates every record together and a test run cannot write into somebody's
 * real one. Kept open for the life of the session and flushed on quit, because
 * the write is deferred and quitting is exactly when a deferred write has not
 * happened yet.
 *
 * Off when `logging.fights` is off, and then it writes nothing rather than
 * writing an empty file: a setting that leaves a file behind has not been
 * turned off.
 */
const fightLogs = new Map<SessionId, FightLog>();

function fightsFor(id: SessionId): FightSink {
  if (!(config?.config.logging.fights ?? DEFAULT_CONFIG.logging.fights)) return NO_FIGHTS;
  const existing = fightLogs.get(id);
  if (existing) return existing;
  const log = new FightLog(home.state('fights', `${id}.jsonl.gz`), {
    notice: (message) => announce('fights', message)
  });
  fightLogs.set(id, log);
  return log;
}

/**
 * The Talk card's history, per character, beside the fights and for the same
 * reason: what somebody said outlives the socket, and a restart that started
 * the card empty was a conversation lost.
 *
 * Off when `logging.conversations` is off, and then nothing is written and
 * nothing restored — the FightLog's rule. Retention is read at creation,
 * which is when the prune happens; a config edit reaches the next launch.
 */
const talkLogs = new Map<SessionId, TalkLog>();

function talkFor(id: SessionId): TalkSink {
  if (!(config?.config.logging.conversations ?? DEFAULT_CONFIG.logging.conversations)) {
    return NO_TALK;
  }
  const existing = talkLogs.get(id);
  if (existing) return existing;
  const log = new TalkLog(
    home.state('talk', `${id}.jsonl`),
    config?.config.logging.conversationDays ?? DEFAULT_CONFIG.logging.conversationDays,
    { notice: (message) => announce('talk', message) }
  );
  talkLogs.set(id, log);
  return log;
}

/**
 * A character's own record — what each bank holds, and what was in each worn
 * slot.
 *
 * Beside the memory and the fights, and keyed on **both** the character and the
 * address it dialled: what is in Rand's vault is not in Probe's, neither is the
 * kit on Rand's back, and both belong to the server — so a character dialled at
 * a saved realm from the palette must not be shown either from somewhere else.
 * That second key is why this is built at connect rather than at session
 * creation like `memoryFor`: the address is not known until then.
 *
 * A session that re-dials a *different* realm gets a different record, and the
 * one it had is closed on the way out so its deferred write lands.
 */
const belongings = new Map<SessionId, Belongings>();

function belongingsAt(id: SessionId, target: ConnectionTarget): BelongingsSink {
  const realm = realmAddress(target);
  const existing = belongings.get(id);
  if (existing) {
    if (existing.realm === realm) return existing;
    existing.close();
  }
  const record = new Belongings({
    file: home.state('belongings', `${id}.json`),
    realm,
    notify: (message) => announce('belongings', message)
  });
  belongings.set(id, record);
  return record;
}

/**
 * Whether the realm says an item goes in a slot, **and that this character may
 * have it**.
 *
 * The realm's own `Worn` code, read through the item table, and **not** a guess
 * from the name or from the item's kind. Without it *Equip all* would send
 * `wear healing potion` once per potion, each answered with a refusal, out of
 * the same budget. An item the realm does not carry answers no: a private
 * realm's own item is exactly where the client knows nothing, and refusing
 * costs a button where guessing costs a broadcast.
 *
 * The restriction half is the same `equipBlock` the pack's own row button
 * draws from, for the reason `shared/gear.ts` exists at all: a bulk action that
 * sent `wear` at the four items the card had just struck through would spend
 * four commands to be refused four times, and the two halves of one question
 * would disagree on screen. Unknown still refuses nothing — a character whose
 * stat sheet has not printed gets the same *Equip all* it always had.
 */
function wearableIn(session: SessionId, name: string): boolean {
  const world = worldFor(session);
  if (!world) return false;
  const key = bareName(name);
  const item = world.itemsNamed([key])[key];
  if (!isWearable(item)) return false;
  return equipBlock(item, wearerIn(session)) === null;
}

/**
 * Who this character is, in the realm's own row ids.
 *
 * Shared by the `wearer` query the pack asks and by `wearableIn` above, so the
 * card and the bulk action cannot resolve the same character two ways.
 */
function wearerIn(session: SessionId): Wearer {
  const state = host?.get(session)?.manager.character;
  const world = worldFor(session);
  return {
    classId: world && state?.className ? world.classId(state.className) : null,
    raceId: world && state?.race ? world.raceId(state.race) : null,
    level: state?.progress.level ?? null,
    strength: state?.progress.strength ?? null,
    classNames: world?.namedClasses() ?? {},
    raceNames: world?.namedRaces() ?? {}
  };
}

/** Where session logs go: the configured directory, or the per-user data dir. */
/**
 * How a character should be named on screen and in a file it produces.
 *
 * A top-level function rather than a closure inside the host's options because
 * a bug report has to name the character it is about, and that is asked from an
 * IPC handler rather than from the rail.
 *
 * The name the *realm* gave them wins, because that is who the player thinks
 * they are: a profile's display name is a filename until the stat sheet
 * arrives, and "Main" identifies nobody. The server comes along so that two
 * characters on two realms are told apart at a glance.
 */
function labelOf(id: SessionId): { name: string; server: string; accent: string } {
  const profile = profileFor(id);
  const learned = host?.get(id)?.manager.character.name ?? null;
  const target = host?.get(id)?.manager.state.target;
  return {
    name: learned ?? profile?.name ?? id,
    server: profile?.serverName ?? target?.host ?? '',
    accent: profile?.accent ?? 'cyan'
  };
}

/**
 * Which mudengine this is.
 *
 * **Not `app.getVersion()` alone.** In a package that reads the version
 * electron-builder wrote into the app's `package.json`; in development the app
 * path is not this project's, so it answers with *Electron's* version — the
 * first report this wrote said `version 33.4.11` next to `Electron 33.4.11`,
 * which tells whoever is diagnosing it nothing at all. The repository's own
 * `package.json` is bundled at build time and is the same file electron-builder
 * takes the packaged version from, so the two cannot disagree.
 */
function appVersion(): string {
  return APP_VERSION;
}

function logDirectory(): string {
  const configured = config?.config.logging.directory ?? '';
  return configured.length > 0 ? configured : home.state('logs');
}

/**
 * The bundled resources directory.
 *
 * electron-builder flattens `resources/` into the app's own resources root, so
 * the `resources/` path segment exists only in the source tree.
 *
 * In development this cannot be derived from one path: launching the built
 * main directly puts it at `<root>/out`, while `electron-vite dev` puts it at
 * `<root>`. Depending on one of those silently found no resources under the
 * other — the realm data failed to load and the annotated config template was
 * quietly replaced by an empty file. The host names its candidates and they
 * are probed here for a file that must be there.
 */
function resourcesDir(): string {
  if (platform.resourcesPath !== null) return platform.resourcesPath;

  const candidates = platform.resourceCandidates();
  const found = candidates.find((dir) => existsSync(path.join(dir, 'config', 'default.yaml')));
  if (!found) console.warn(`resources: none of ${candidates.join(', ')} look right`);
  return found ?? candidates[0]!;
}

/**
 * The client's own icon, as a file on disk.
 *
 * Beside the realm data in `resources/`, which electron-builder flattens into
 * the package's resources root — so one path answers for a package and for a
 * development run alike. `build/icon.png` is the *packaging* copy and is never
 * shipped inside the app; this is the one the running window uses.
 */
function appIcon(): string {
  return path.join(resourcesDir(), 'icon.png');
}

/**
 * Where an options file may be sitting from before the tree existed.
 *
 * Two places, and both of them are history: `<userData>/config.yaml` is where a
 * packaged build kept it, and `resources/config/user.yaml` is where a
 * development run did — inside the source checkout, which is how a player's
 * real characters and their real passwords came to live in a git working tree.
 * `migrateHome` moves the first of these that exists, with everything beside
 * it, and then this list never matches again.
 */
function legacyOptionsFiles(): string[] {
  return [
    path.join(home.root, 'config.yaml'),
    platform.packaged ? '' : path.join(resourcesDir(), 'config', 'user.yaml')
  ];
}

function configTemplate(): string {
  return path.join(resourcesDir(), 'config', 'default.yaml');
}

/**
 * Puts the realms on disk the first time, so a fresh client has somewhere to
 * play rather than an empty Realms page.
 *
 * Six of them, one directory each: Paradigm's four game realms and its two
 * test realms, which is what the client ships for — `resources/world/` is
 * built from Paradigm's own database. The same reasoning as the options
 * template being copied on first run, and the same failure it avoids: a
 * feature nobody can find is one that was never built.
 *
 * Copied **only when the directory does not exist at all** — not per file —
 * so somebody who deleted a realm does not get it back on every launch, which
 * is a client arguing with a decision they made.
 */
function seedServers(): void {
  if (existsSync(home.serversDir)) return;
  const shipped = path.join(resourcesDir(), 'servers');
  if (!existsSync(shipped)) return;
  try {
    cpSync(shipped, home.serversDir, { recursive: true });
  } catch (error) {
    console.warn(`servers: could not copy the shipped realms: ${String(error)}`);
  }
}

function profileTemplate(): string {
  return path.join(resourcesDir(), 'config', 'profile.default.yaml');
}

/** The client's own settings template, copied beside the options on first run. */
function internalTemplate(): string {
  return path.join(resourcesDir(), 'config', 'internal.yaml');
}

/** The shipped loops, read once. See `LoopCatalogue`. */
let catalogue: LoopCatalogue | null = null;

/*
 * Lazily, and not at startup like the realm data: the realm is announced on the
 * way up precisely so a package that cannot find it says so, and it is needed
 * to route anywhere. This is needed only by a screen somebody has to open.
 */
function loopCatalogue(): LoopCatalogue {
  catalogue ??= new LoopCatalogue(path.join(resourcesDir(), 'loops', 'megamud.yaml'));
  return catalogue;
}

/** The character with this id, if a profile file defines one. */
function profileFor(id: SessionId): Profile | undefined {
  return profiles?.profiles.find((profile) => profile.id === id);
}

/**
 * The options one session runs under: its profile's overlay.
 *
 * The global file answers only for a session whose file has gone while it was
 * connected — deleting a file is an edit, and an edit must not cut a socket —
 * and that session keeps the client's defaults until it is idle and closes.
 * Nothing else runs without a profile.
 */
function configFor(id: SessionId): AppConfig {
  return profileFor(id)?.config ?? config?.config ?? DEFAULT_CONFIG;
}

/** Pushes an app-level payload to every live window. */
function push(channel: string, payload: unknown): void {
  windows.toAll(channel, payload);
}

/** An engine message. A null session means it is about the client, not a character. */
function notice(message: string, session: SessionId | null = null): void {
  const payload: Notice = { session, message };
  push(Push.notice, payload);
  /*
   * And to stdout.
   *
   * A notice is the client explaining itself — an options file that will not
   * parse, a character that cannot load, a realm that had to be fallen back
   * from. It reaches the terminal, which xterm draws to a *canvas*: not in the
   * DOM, not in a log file, and gone the moment the window is closed. When
   * somebody asks why the client did something, this is the record, and a
   * packaged app's stdout is where it can actually be read from.
   */
  console.log(session === null ? `notice: ${message}` : `notice[${session}]: ${message}`);
}

/**
 * A subsystem explaining itself, in both places at once: the terminal gets the
 * notice, and stdout gets the same line with who is speaking in front — the
 * record that survives the window closing. One helper because the nine stores
 * that report this way had each restated the pair inline.
 */
function announce(prefix: string, message: string, level: 'log' | 'warn' = 'warn'): void {
  /*
   * The push, then the record — the same two places `notice` writes to, and
   * deliberately not by calling it. It did, and so every line a store reported
   * appeared on stdout **twice**: once as `world: Converting the realm
   * database…` and again as `notice: Converting the realm database…`. The
   * subsystem prefix is what this helper exists to add, so it is the one that
   * stays; `notice` keeps its own for the callers that speak for the client
   * rather than for a store.
   */
  const payload: Notice = { session: null, message };
  push(Push.notice, payload);
  console[level](`${prefix}: ${message}`);
}

function createConfig(): ConfigStore {
  /*
   * Bring the file up to the template before anything reads it.
   *
   * The client used to *report* the gap instead, on every reload, and the
   * report was the thing people actually saw: a file that had correctly
   * dropped `servers:` when realms became directories was told it was out of
   * date every few seconds, for ever. Filling the gap leaves nothing to say —
   * see `reconcileWithTemplate`, which only ever adds a block that is absent.
   */
  const brought = reconcileWithTemplate(home.options, configTemplate());
  // Said once, when something actually changed. This is the only code besides
  // `migrateHome` that edits a file somebody else wrote, and a client that
  // rewrites your options silently is one you cannot trust with them.
  if (brought.added.length > 0) {
    notice(t('app.config.templateAdded', { added: brought.added.join(', ') }));
  }
  if (brought.error !== null) {
    notice(t('app.config.templateReconcileFailed', { error: brought.error }));
  }

  const store = new ConfigStore({
    /*
     * One place, always. There is no search any more: `home` decided where the
     * tree is before anything read from it, and `migrateHome` has already
     * brought an older layout across, so a file that is not there is a first
     * run rather than a file somewhere else.
     */
    override: home.options,
    searchPaths: [home.options],
    template: configTemplate()
  });

  store.on('change', (snapshot) => {
    push(Push.config, snapshot);
    /*
     * Profiles are overlays on this file, so a reload has to be reapplied to
     * every character before anything reads it back. `refresh` re-resolves them
     * against the new base and emits, which is what reconfigures the sessions.
     */
    if (profiles) profiles.refresh();
    else host?.reconfigure();
    /*
     * Only when something went wrong.
     *
     * A parse error has to be visible or a silently ignored edit reads as a
     * broken watcher. A *successful* reload does not: the file is polled twice
     * a second and every save an editor makes is a reload, so announcing them
     * put three identical lines in the console for one Ctrl-S and pushed the
     * game off the screen. What changed is already visible in the thing that
     * changed.
     */
    if (snapshot.error) notice(t('app.config.reloadFailed', { error: snapshot.error }));
  });

  store.watch();
  return store;
}

/**
 * Brings the set of live sessions in line with the set of profile files.
 *
 * Adding a character is dropping a YAML file in; removing one is deleting it.
 * The asymmetry is deliberate: **a file disappearing never disconnects a live
 * character.** Deleting a file is an edit, and an edit must not be able to cut
 * a socket out from under someone who is standing in a dangerous room. The
 * session stays until it is idle, and says so.
 */
function syncSessions(snapshot: ProfileSnapshot): void {
  if (!host) return;

  for (const profile of snapshot.profiles) {
    if (unloaded.has(profile.id)) continue;
    host.ensure(profile.id);
  }

  /*
   * With no profiles at all there is no session. There used to be one — an
   * anonymous session driven by `connection:`, the shape the client had before
   * profiles existed — and every feature since had to carve a case out for it
   * (retired 2026-08-29; see `NO_SESSION`). Making a character is step one, so
   * the renderer opens the new-character form, and this says so once.
   *
   * Once per launch: a message repeated on every profile poll is a message
   * nobody reads. To stdout as well as the window, because with no session
   * there is no console for it to land in.
   */
  if (snapshot.profiles.length === 0 && !saidHowToAddACharacter) {
    saidHowToAddACharacter = true;
    notice(t('app.onboarding.noCharactersYet'));
  }

  const known = new Set(snapshot.profiles.map((profile) => profile.id));
  for (const id of host.ids) {
    if (known.has(id)) continue;

    const phase = host.get(id)?.manager.state.phase;
    if (phase !== undefined && !DORMANT_PHASES.has(phase)) {
      notice(t('app.profiles.fileGoneStillConnected', { id }), id);
      continue;
    }
    host.remove(id);
  }

  // Profiles are overlays, so any change to one — or to the file underneath it
  // — has to reach the running session.
  host.reconfigure();

  for (const error of snapshot.errors) notice(t('app.profiles.loadFailed', { error }));
}

/**
 * Whether the "no characters yet" line has been said this launch.
 *
 * Profiles are polled, so without this it would be said every poll — and a
 * message repeated forever is one nobody reads, including the times it matters.
 */
let saidHowToAddACharacter = false;

/** Phases in which a session is not holding a socket and can safely be dropped. */
const DORMANT_PHASES = new Set(['idle', 'closed', 'error']);

/**
 * Characters the player has closed.
 *
 * A profile file is the statement that a character *exists*; a tab is the
 * statement that they are playing it now. Without this set, closing a tab would
 * be undone by the next directory poll, which is a close button that does not
 * close. Kept for the life of the process — which window layout persists across
 * restarts is step 5's problem, not this one's.
 */
const unloaded = new Set<SessionId>();

/**
 * A list of remotes off the wire, or `null` if any of it is not one.
 *
 * **Refused whole, never filtered.** Dropping the unrecognised entries and
 * writing the rest would silently write a permission somebody did not choose —
 * and the direction that is safe in an options file (drop, narrow) is the wrong
 * one for a click, where the honest answer is that the client did not
 * understand and nothing was written.
 */
function asRemoteNames(value: unknown): RemoteName[] | null {
  if (!Array.isArray(value)) return null;
  const names: RemoteName[] = [];
  for (const entry of value) {
    if (!isRemoteName(entry)) return null;
    names.push(entry);
  }
  return names;
}

/**
 * A supplies list off the wire, or `null`. Parse, do not validate: every row
 * is rebuilt from the fields this accepts, so nothing else on the payload
 * reaches the file. Bounded as the normaliser bounds it.
 */
function asSupplyItems(value: unknown): SupplyItem[] | null {
  if (!Array.isArray(value) || value.length > 200) return null;
  const items: SupplyItem[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const row = entry as Record<string, unknown>;
    const name = typeof row['name'] === 'string' ? row['name'].trim().slice(0, 60) : '';
    if (name.length === 0) return null;
    const min = Number(row['min']);
    const max = Number(row['max']);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 0) return null;
    if (min > 1000 || max > 1000) return null;
    const shop = typeof row['shop'] === 'string' ? row['shop'].trim().slice(0, 80) : '';
    let at: SupplyItem['at'] = null;
    if (row['at'] !== null && row['at'] !== undefined) {
      if (typeof row['at'] !== 'object') return null;
      const place = row['at'] as Record<string, unknown>;
      const map = Number(place['map']);
      const room = Number(place['room']);
      if (!Number.isInteger(map) || !Number.isInteger(room) || map < 0 || room < 0) return null;
      at = { map, room };
    }
    items.push({ name, min, max: Math.max(min, max), shop, at });
  }
  return items;
}

/** One player's grant off the wire, or `null`. */
function asGrant(value: unknown): RemoteGrant | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const allow = asRemoteNames(record['allow']);
  const deny = asRemoteNames(record['deny']);
  if (allow === null || deny === null) return null;
  return { allow, deny };
}

/** Every character on disk, and whether a session is open for it. */
function profileSummaries(): ProfileSummary[] {
  return (profiles?.profiles ?? []).map((profile) => ({
    id: profile.id,
    name: profile.name,
    accent: profile.accent,
    theme: profile.config.ui.theme,
    loaded: host?.has(profile.id) ?? false,
    target: profile.target,
    serverName: profile.serverName,
    remotes: profile.config.automation.remotes,
    switches: automationSwitches(profile.config.automation),
    restTo: profile.config.automation.health.restTo,
    supplies: profile.config.automation.supplies
  }));
}

/**
 * The characters whose *tabs* live in one window.
 *
 * Not the same question as which sessions a window is attached to: attachment
 * is about where bytes are pushed, ownership is about whose rail a character
 * appears in. A window can show a character it does not own — that is a pane —
 * and must not have a tab for one that lives somewhere else.
 */
function summariesFor(windowId: number): SessionSummary[] {
  const all = host?.summaries ?? [];
  if (!workspace) return all;
  /*
   * In the *workspace's* order, not the host's.
   *
   * This used to filter `all` against a `Set`, which quietly threw away the one
   * thing `sessionsFor` is documented to return — the characters "in rail
   * order". The rail could be dragged into an order, the order was written to
   * `workspace.json`, and every republish put it back the way the profile
   * directory happened to sort.
   */
  const summaries = new Map(all.map((entry) => [entry.id, entry] as const));
  return workspace
    .sessionsFor(windowId)
    .map((id) => summaries.get(id))
    .filter((entry): entry is SessionSummary => entry !== undefined);
}

/**
 * Republishes both rosters.
 *
 * The session roster is per window and the profile roster is not: which
 * characters *exist* is the same everywhere, and which of them this window
 * shows tabs for is not.
 */
function publishRosters(): void {
  for (const windowId of windows.ids()) {
    windows.toWindow(windowId, Push.sessions, summariesFor(railOf(windowId)));
  }
  push(Push.profiles, profileSummaries());
}

/**
 * Whose rail a view draws.
 *
 * On the desktop a window's rail is its own: ownership is per window, and
 * that is what popping a character out moves. A host with no second window
 * (`platform.windows === null`) has one rail and every view is a view of it
 * — a second browser tab is another look at the same client, not another
 * window to own characters — so every view draws the rail the workspace
 * calls main. Asked here, once, rather than at each of the seven places a
 * window id reaches the workspace.
 */
function railOf(windowId: number): number {
  if (platform.windows !== null) return windowId;
  return platform.mainWindowId() ?? windowId;
}

/** The roster for whoever asked: their rail's, or everybody's for a caller no window claims. */
function rosterFor(caller: Caller): SessionSummary[] {
  if (caller.windowId === -1) return host?.summaries ?? [];
  return summariesFor(railOf(caller.windowId));
}

/**
 * Hands the options store what the directories beside it say.
 *
 * Servers and the loops everybody may walk are files now, and everything that
 * reads a configuration asks `ConfigStore` for one — so they are folded in
 * there rather than at each call site, and a change to either republishes the
 * configuration exactly as an edit to the options file does.
 */
function publishTree(): void {
  config?.setExtras({
    servers: servers?.servers ?? [],
    loops: loops?.globalLoops ?? []
  });
}

function createServers(): ServerStore {
  const store = new ServerStore(home, (message) => announce('servers', message));
  store.on('change', publishTree);
  store.watch();
  return store;
}

function createLoops(): LoopStore {
  const store = new LoopStore(home, (message) => announce('loops', message));
  store.on('change', () => {
    publishTree();
    // A server's or a character's loops are not part of the base, so a change
    // to one reaches the characters only by re-resolving them.
    profiles?.refresh();
  });
  store.watch();
  return store;
}

function createProfiles(): ProfileStore {
  const store = new ProfileStore({
    directory: home.profilesDir,
    base: () => config?.source ?? {},
    /*
     * What the two narrower directories lend this character: its server's
     * loops, then its own. Read through rather than captured, so a file
     * written while the client is running reaches the next resolution.
     */
    loopsFor: (id, serverName) => {
      const serverId = servers?.idFor(serverName);
      return mergeLoops(
        serverId === undefined ? [] : (loops?.forServer(serverId) ?? []),
        loops?.forProfile(id) ?? []
      );
    }
  });

  store.ensureDirectory();
  store.on('change', (snapshot) => {
    // A file that has come back is a character the player wants again; leaving
    // it in `unloaded` would make re-adding it silently do nothing.
    for (const id of [...unloaded]) {
      if (!snapshot.profiles.some((profile) => profile.id === id)) unloaded.delete(id);
    }
    syncSessions(snapshot);
    publishRosters();
  });
  store.watch();
  return store;
}

/**
 * The internal settings file: beside the options file, like everything the
 * client keeps, so `MUDENGINE_CONFIG` relocates it too. Hot-reloaded, and a
 * change reaches every session the way an options change does.
 */
function createInternal(): InternalStore {
  /*
   * Brought up to the template first, exactly as the options file is.
   *
   * This file is copied once and never again, so every block added to the
   * template afterwards was invisible to anybody who had already run the
   * client — and the block *is* the documentation here: `toolbar.pinned` names
   * every button there is and says how to change the row. The defaults still
   * applied, which is the shape this project has a name for: a setting nobody
   * can see is a setting nobody uses.
   *
   * `reconcileWithTemplate` only ever adds a whole absent top-level block, so
   * nothing the user has written is touched.
   */
  const brought = reconcileWithTemplate(home.internal, internalTemplate());
  if (brought.added.length > 0) {
    notice(t('app.config.internalTemplateAdded', { added: brought.added.join(', ') }));
  }
  if (brought.error !== null) {
    notice(t('app.config.templateReconcileFailed', { error: brought.error }));
  }

  const store = new InternalStore({
    file: home.internal,
    template: internalTemplate(),
    onError: (message) => announce('internal', message)
  });
  /*
   * The tuning block is process-wide rather than threaded, so it is set here
   * on the first read and again on every change — see `app/tuning.ts` for why
   * it is a lookup rather than a constructor argument.
   */
  setTuning(store.config.tuning);
  store.on('change', () => {
    setTuning(store.config.tuning);
    host?.reconfigure();
    // The palette reads it too, so a saved edit reaches every window.
    push(Push.internal, store.config);
  });
  store.watch();
  return store;
}

function createHost(): SessionHost {
  return new SessionHost({
    worldFor,
    internal: () => internal?.config ?? DEFAULT_INTERNAL,
    loreFor,
    spellLoreFor,
    memoryFor: splitMemoryFor,
    fightsFor,
    talkFor,
    belongingsAt,
    playersFor,
    destinationsFor,
    playersAt,
    findsFor,
    // What the realm called itself, by the address it was dialled at, so the
    // next session built for it starts on the right world.
    realmTold: (_id, target, realm) => worldBook?.learn(realmAddress(target), realm),
    // Not a domain concern: see `keepSignalsWorking`.
    onConnected: keepSignalsWorking,
    // Per window: which characters have tabs where is the one roster question
    // that differs between them.
    publishRoster: publishRosters,
    // Read through rather than captured: the options file is hot-reloaded and
    // profiles are watched, so a captured snapshot would pin every session to
    // the values it started with.
    configFor,
    /*
     * Whether a lost connection is dialled back, per character, read through
     * for the reason `configFor` is: profiles are watched, so switching it off
     * has to reach a session that is already counting down.
     */
    autoReconnect: (id) => profileFor(id)?.autoReconnect ?? false,
    /*
     * What to call a character.
     *
     * The name the *realm* gave them wins, because that is who the player
     * thinks they are: a profile's display name is a filename until the stat
     * sheet arrives, and "Main" identifies nobody. The server comes along so
     * that two characters on two realms are told apart at a glance.
     */
    label: labelOf,
    logDirectory,
    toAttached: (channel, message) => windows.toAttached(channel, message),
    toDiagnostics: (channel, message) => windows.toDiagnostics(channel, message),
    toDebugging: (channel, message) => windows.toDebugging(channel, message),
    toAll: (channel, payload) => windows.toAll(channel, payload),
    notice: (payload) => push(Push.notice, payload)
  });
}

/**
 * Whether the window is drawn by the GPU, said out loud when it is not.
 *
 * Nothing about the client changes when Chromium falls back to software
 * compositing — the same code runs, the same frames are asked for — and
 * nothing on screen says so. What changes is that every frame is composed on
 * a CPU: the console's WebGL canvas is read back, every glass surface is
 * blurred in software, and a typed character comes back a hundred and fifty
 * milliseconds later. Measured on a virtual display with `npm run
 * profile:ui`, where that is the whole of the difference between the window
 * being fluid and the window crawling; a driver, a sandbox or a launch flag
 * can put a real desktop in the same state, and somebody in it would
 * otherwise read the client as slow rather than the machine as unaccelerated.
 *
 * Once per window, because each window has its own console and a character
 * popped out later deserves the same sentence; once per process on stdout,
 * because the record needs it once. Only a status Chromium has actually
 * *decided* is software counts — `disabled_software`, `unavailable_software`
 * and their kin. `unknown` is not a decision, and stating it as one would be
 * the reassuring guess in the other direction: an alarm nobody can clear.
 * A host with nothing composing here — a browser tab draws itself on its own
 * machine — answers null, and nothing is said: absence is not a verdict.
 */
const compositingReportedTo = new Set<number>();
let compositingLogged = false;
function reportSoftwareCompositing(to: Caller): void {
  if (compositingReportedTo.has(to.windowId)) return;
  const status = platform.gpu();
  if (status === null) return;
  if (!/^(disabled|unavailable)/.test(status.compositing)) return;
  compositingReportedTo.add(to.windowId);
  const message = t('app.gpu.softwareCompositing', {
    compositing: status.compositing,
    rasterization: status.rasterization,
    webgl: status.webgl
  });
  const payload: Notice = { session: null, message };
  to.send(Push.notice, payload);
  if (!compositingLogged) {
    compositingLogged = true;
    console.warn(`gpu: ${message}`);
  }
}

function registerIpc(): void {
  const { handle, on } = platform.transport;

  on(Send.clientReady, (caller) => {
    /*
     * Replay to the window that just mounted, not to all of them: this is the
     * state a fresh renderer is missing, and the others already have it.
     */
    if (host) caller.send(Push.sessions, rosterFor(caller));
    caller.send(Push.profiles, profileSummaries());
    if (config) {
      caller.send(Push.config, config.snapshot);
    }
    reportSoftwareCompositing(caller);

    /*
     * Connect on launch, and only on launch.
     *
     * `clientReady` is "a renderer is mounted and can receive output", and a
     * renderer can mount more than once: React's StrictMode deliberately runs
     * every effect twice in development, a reload or hot update mounts a fresh
     * one, and — now — a second window mounts another. Treating each of those
     * as a reason to dial meant `npm run dev` opened two connections a
     * millisecond apart; the second tore down the first mid-handshake and the
     * server dropped it, which read as the server refusing the first connection
     * every time the app started.
     *
     * Autoconnect is a property of *starting the app*, so it is latched here by
     * session id rather than guarded further down. A window appearing is never
     * a reason to reconnect behind the player's back, even if it worked.
     */
    if (launched) return;
    launched = true;

    /*
     * Nothing to dial without a character, and nothing said here either:
     * `syncSessions` already said it, once. Two identical lines on the same
     * launch is how a message people ought to read becomes one they learn to
     * scroll past.
     */
    for (const profile of profiles?.profiles ?? []) {
      if (!profile.autoConnect || autoConnected.has(profile.id)) continue;
      autoConnected.add(profile.id);
      void host?.connect(profile.id, profile.target);
    }
  });

  on(Send.input, (_caller, session: SessionId, data: string) => {
    host?.get(session)?.manager.send(data);
  });

  on(Send.resize, (_caller, session: SessionId, size: TerminalSize) => {
    host?.get(session)?.manager.resize(size);
  });

  // Whether this window is showing the per-line diagnostics feed. Per window,
  // like attachment: the flag lives in the registry so a destroyed window
  // takes its interest with it.
  on(Send.diagnostics, (caller, showing: boolean) => {
    windows.setDiagnostics(caller.windowId, showing === true);
  });

  // The debug view's own feed. See `Send.debugFeed` for why it is not this
  // window's diagnostics flag.
  on(Send.debugFeed, (caller, showing: boolean) => {
    windows.setDebugging(caller.windowId, showing === true);
  });

  // ------------------------------------------------------------- per session

  /*
   * Where a character connects is a property of the character, so the renderer
   * does not have to know an address to dial one. An explicit target is the
   * ad-hoc path — the palette's saved servers — and it is not written back to
   * the profile: connecting somewhere once is not the same as moving house.
   */
  handle(Invoke.connect, (_caller, session: SessionId, target?: unknown) => {
    /*
     * An explicit target is parsed before it reaches the socket layer, where a
     * malformed port is a throw rather than a refusal. Omitting it is the
     * ordinary path — the character's own file says where it plays.
     */
    const asked = target === undefined ? null : asConnectionTarget(target);
    if (target !== undefined && asked === null) {
      notice(t('app.connect.invalidTarget'), session);
      return host?.get(session)?.manager.state ?? null;
    }
    /*
     * No target and no file to say where this character plays is a refusal,
     * not a fallback onto the global `connection:` block: that block is what a
     * *new realm* starts with, and a tab that quietly dialled it would be a tab
     * dialling somewhere the player never chose. Reachable only for a session
     * whose file has gone while it was connected.
     */
    const where = asked ?? profileFor(session)?.target ?? null;
    if (where === null) {
      notice(t('app.connect.noCharacterFile', { id: session }), session);
      return host?.get(session)?.manager.state ?? null;
    }
    return host?.connect(session, where);
  });
  /*
   * Through the host rather than straight at the manager, because pressing
   * Disconnect also calls off a redial that is already scheduled. A character
   * sitting at a closed socket with a retry pending has nothing for the manager
   * to close, and this is the one way to say *stop trying*. See `Reconnect`.
   */
  handle(Invoke.disconnect, (_caller, session: SessionId) => host?.disconnect(session) ?? null);
  handle(
    Invoke.getState,
    (_caller, session: SessionId) => host?.get(session)?.manager.state ?? null
  );
  handle(
    Invoke.getTelnetLog,
    (_caller, session: SessionId) => host?.get(session)?.manager.log ?? []
  );
  handle(Invoke.getLines, (_caller, session: SessionId) => host?.get(session)?.manager.lines ?? []);
  handle(Invoke.getDebug, (_caller, session: SessionId) => {
    const slot = host?.get(session);
    if (!slot) return { records: [], dropped: 0 };
    return { records: [...slot.debug.all], dropped: slot.debug.lost };
  });

  /*
   * The bug report, written by main.
   *
   * Main writes it for the reason main owns the clipboard: the window has no
   * filesystem. It goes into the same `logs/` directory the session logs and
   * captures do, which is the directory `npm run check:secrets` already walks —
   * a report saved anywhere else would be one nobody can promise carries no
   * password, and this is a file whose whole purpose is being sent to somebody
   * else.
   *
   * Named after the character and the moment, because a player reporting two
   * problems in an evening has to be able to say which file is which.
   */
  handle(Invoke.saveDebug, async (_caller, session: SessionId) => {
    const slot = host?.get(session);
    if (!slot) return { error: t('app.debug.noSession') };
    const who = labelOf(session);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const directory = logDirectory();
    const file = path.join(directory, `debug-${fileSlug(who.name)}-${stamp}.txt`);
    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        file,
        formatDebugReport(
          {
            title: t('app.debug.reportTitle'),
            version: appVersion(),
            platform: `${process.platform} ${process.arch}, ${platform.runtime}`,
            character: who.name,
            realm: who.server.length > 0 ? who.server : t('app.debug.realmUnknown'),
            at: Date.now(),
            dropped: slot.debug.lost
          },
          slot.debug.all
        ),
        'utf8'
      );
      return { path: file };
    } catch (error) {
      // Said out loud rather than swallowed: a save button that quietly did
      // nothing is worse than one that reports why it could not.
      return { error: errorMessage(error) };
    }
  });

  handle(
    Invoke.getCharacter,
    (_caller, session: SessionId) => host?.get(session)?.manager.character ?? EMPTY_CHARACTER
  );
  handle(
    Invoke.getWalk,
    (_caller, session: SessionId) => host?.get(session)?.manager.walker.progress ?? IDLE_WALK
  );
  handle(
    Invoke.getAutomation,
    (_caller, session: SessionId) => host?.get(session)?.manager.automation ?? EMPTY_AUTOMATION
  );

  /**
   * Who is walking, for pricing a route against them.
   *
   * One reading for every route a window asks for — the route panel's and the
   * loop builder's — so a door graded one way on the panel and another way in
   * the builder cannot happen. A character nobody has read the sheet of is
   * priced as one that can force nothing, which is `edgePenalty`'s own rule.
   */
  const travellerOf = (session: SessionId, preferring: boolean): Traveller => {
    const manager = host?.get(session)?.manager;
    // The session's own statement of what its character costs to move — the
    // stats off the sheet, the purse, what the server refused and, for every
    // caller but the builder, the corridors it prefers — so a door graded one
    // way on the panel and another way in a loop's leg cannot happen. The
    // builder plans plainly on purpose: see the header of `loopDraft.ts`. A
    // character with no session yet is priced as one that can force nothing,
    // which is `edgePenalty`'s own rule.
    if (manager) return manager.travellerNow(manager.character, preferring);
    return { level: null, strength: null, pickSkill: undefined, wealth: null };
  };

  /*
   * One remembered set of drafts per session, so a pick costs its own leg
   * rather than a plan of the whole way from scratch on main's thread.
   */
  const drafts = new Map<SessionId, LoopDraftCache>();

  handle(Invoke.routeTo, (_caller, session: SessionId, map: number, room: number) => {
    const manager = host?.get(session)?.manager;
    // This character's realm, not the client's: routing against the wrong one
    // sends somebody to a room that does not exist.
    const world = worldFor(session);
    if (!world || world.size === 0) {
      return { steps: [], cost: 0, blocked: true, reason: t('app.route.noRealmData') };
    }
    const here = manager?.character.room;
    if (!here || here.map === null || here.number === null) {
      // Routing from an unknown position would be a guess dressed as a plan.
      return { steps: [], cost: 0, blocked: true, reason: t('app.route.unknownRoom') };
    }
    // With the alternatives a reader chooses between: this is the one route
    // planned to be read rather than walked.
    return world.route(
      roomId(here.map, here.number),
      roomId(map, room),
      travellerOf(session, true),
      { alternatives: true }
    );
  });

  /*
   * A loop being built by hand, planned. Parsed rather than trusted: every
   * room on the way is one A* pass on this thread, so the list is bounded by
   * the same ceiling a loop payload has (the card refuses the click before
   * it gets here), and an entry that is not a room is refused outright —
   * skipping it would plan a different loop from the one on the screen.
   * Priced against the character's stats as the route panel prices, and
   * plainly — without the corridors it prefers — so the way drawn is the way
   * the reduction reproduces; see the header of `loopDraft.ts`.
   */
  handle(Invoke.draftLoop, (_caller, session: SessionId, rooms: unknown) => {
    const world = worldFor(session);
    if (!world || world.size === 0) return EMPTY_LOOP_DRAFT;
    const picks = asRoomIds(rooms, LOOP_LIMITS.stops);
    if (picks === null) throw new Error(t('app.loop.invalidPicks', { max: LOOP_LIMITS.stops }));
    let cache = drafts.get(session);
    if (cache === undefined) {
      cache = new LoopDraftCache();
      drafts.set(session, cache);
    }
    return cache.draft(world, picks, travellerOf(session, false));
  });

  /*
   * Walking is an outbound action, so it goes to that session's arbiter rather
   * than sending anything from here. The route is passed back in whole because
   * the renderer has already shown it to a person: walking exactly what was
   * reviewed is the point, and re-planning here could quietly walk a different
   * one.
   */
  handle(Invoke.walkRoute, (_caller, session: SessionId, payload: unknown) => {
    const slot = host?.get(session);
    if (!slot) return t('app.session.notConnected');
    /*
     * Parsed, not trusted. This is the one payload a window sends that turns
     * into commands on the socket, so it is the one that has to be proven at
     * the boundary — a malformed route otherwise fails several frames later
     * inside the walker, where nothing on the stack says where it came from.
     */
    const route = asRoute(payload);
    if (!route) return t('app.route.invalidPayload');
    /*
     * Through the manager rather than straight at the walker: a route the
     * player asked for is one of the two moments the supply list is consulted,
     * and the shop is visited before the route is walked. See `walkRoute`.
     */
    return slot.manager.walkRoute(route);
  });
  /*
   * The one play button and the one stop button.
   *
   * A character is routing, looping or stopped, and *stop* means the same
   * thing in all three sentences — so main is asked to start or to stop, and
   * decides for itself which of the two it is. See `src/shared/movement.ts`
   * and `SessionManager.startMoving`.
   *
   * `loop` is what the card's picker says and `confirmed` is the answer to the
   * one question play can ask back. Both parsed, not trusted: this turns into
   * commands on a socket.
   */
  handle(
    Invoke.startMoving,
    (_caller, session: SessionId, loop: unknown, confirmed: unknown): MovementStart => {
      const slot = host?.get(session);
      if (!slot) return { refused: t('app.session.notConnected') };
      if (loop !== null && typeof loop !== 'string') return { refused: t('app.loop.invalidName') };
      /*
       * `confirmed` is the **figure** the window was shown and the player
       * agreed to, never a flag: main measures again and asks afresh if the
       * journey has grown since. Anything that is not a finite number is *not
       * agreed to*, which is the safe reading of a malformed payload.
       */
      const agreed = typeof confirmed === 'number' && Number.isFinite(confirmed) ? confirmed : null;
      return slot.manager.startMoving(loop, agreed);
    }
  );
  handle(Invoke.stopMoving, (_caller, session: SessionId) => {
    host?.get(session)?.manager.stopMoving();
  });
  /*
   * A loop is named rather than passed: unlike a route, nothing has been shown
   * to a person to walk *exactly*, and the loop the character should run is
   * the one their own options file defines under that name.
   */
  handle(
    Invoke.listLoops,
    (_caller, session: SessionId) => host?.get(session)?.manager.loopList ?? []
  );
  handle(Invoke.startLoop, (_caller, session: SessionId, name: unknown) => {
    const slot = host?.get(session);
    if (!slot) return t('app.session.notConnected');
    if (typeof name !== 'string') return t('app.loop.invalidName');
    const loop = slot.manager.loopNamed(name);
    if (!loop) return t('app.loop.notFound', { name });
    // Through the manager: one movement at a time, so a lap starting takes the
    // character off whatever route it was walking, out loud.
    const answer = slot.manager.startLoop(loop);
    return 'refused' in answer ? answer.refused : null;
  });
  /*
   * Walk a loop that is not in this character's options at all.
   *
   * `loop:start` addresses a loop by *name*, resolved against the character's
   * own resolved config — which is right for the palette and the card, whose
   * lists are that config. The Loops modal browses the shipped shelf, and its
   * `Don't keep it` destination means precisely a loop that was never written
   * anywhere: there is no name for `loopNamed` to find, and filing one in
   * order to start it and then deleting it would be a write into the user's
   * tree on a path that promised not to make one.
   *
   * `LoopRunner.start` has always taken the loop itself and never a name, so
   * this is the runner's own shape rather than a new capability. Parsed, not
   * trusted: it crossed the wire.
   */
  handle(Invoke.runLoop, (_caller, session: SessionId, loop: unknown) => {
    const slot = host?.get(session);
    if (!slot) return t('app.session.notConnected');
    const parsed = asLoop(loop);
    if (parsed === null) return t('app.loop.invalidLoop');
    const answer = slot.manager.startLoop(parsed);
    return 'refused' in answer ? answer.refused : null;
  });
  /*
   * The loop's own two controls, from its card — the ones that mean nothing
   * for a route. Skipping ends the leg being walked for the reason stopping
   * does: the runner never touches the walker, and a leg left walking would
   * arrive and dwell under a loop that had been told to move on.
   */
  handle(Invoke.skipLoopStop, (_caller, session: SessionId) => {
    const slot = host?.get(session);
    if (!slot) return t('app.session.notConnected');
    if (slot.manager.loops.progress.status === 'running') {
      slot.manager.walker.stop(t('session.walk.stoppedByPlayer'));
    }
    return slot.manager.loops.skip();
  });
  handle(Invoke.reverseLoop, (_caller, session: SessionId) => {
    const slot = host?.get(session);
    if (!slot) return t('app.session.notConnected');
    return slot.manager.loops.reverse();
  });
  /*
   * The shelf, not a character's list — so it takes no session, unlike every
   * other loop channel here. The settings screen asks for it when its picker
   * opens; the catalogue reads the shipped file once and keeps it.
   */
  handle(Invoke.loopCatalogue, () => loopCatalogue().all());

  // ------------------------------------------------------ sessions & windows

  handle(Invoke.listSessions, (caller) => rosterFor(caller));

  /*
   * Moving a character between windows.
   *
   * The session does not move — it never moves, it is in main — so this is a
   * change of *which rail has a tab for it* and nothing else. No socket is
   * touched, no state is rebuilt, and the backscroll replays on attach exactly
   * as it does for a renderer reload (docs/profiles.md §7.4).
   */
  handle(Invoke.popOut, (caller, session: SessionId) => {
    /*
     * A host with no second window refuses, in words the tab can show. The
     * window does not offer the command there either (`api.host`), and both
     * halves exist on purpose: a command that is found and does nothing is
     * worse than one that cannot be found.
     */
    if (platform.windows === null) return t('app.window.noSecondWindow');
    if (!workspace || !host?.has(session)) return t('app.profiles.noSuchCharacter');
    // The last character in a window has nowhere useful to go: popping it out
    // would leave an empty window behind and a new one with one tab, which is
    // the same arrangement with an extra frame around it.
    if (caller.windowId !== -1 && summariesFor(caller.windowId).length <= 1) {
      return t('app.window.onlyCharacterHere');
    }
    const popped = platform.windows.open([session]);
    if (popped === null) return t('app.window.createFailed');
    publishRosters();
    return null;
  });

  /*
   * Everybody back here, and close whatever is left empty.
   *
   * Addressed to the *asking* window rather than to the main one: somebody who
   * ran this from a pop-out meant that window, and moving their characters to a
   * window they are not looking at would be the client deciding for them.
   */
  /*
   * A window asking to be brought forward, which only ever happens because
   * somebody clicked a desktop notification about a character in it. Nothing
   * is refused out loud: a host with no windows to raise is a browser tab,
   * which raises itself and never reaches this handler.
   */
  handle(Invoke.raiseWindow, (caller) => {
    if (platform.windows === null || caller.windowId === -1) return;
    platform.windows.focus(caller.windowId);
  });

  handle(Invoke.gatherWindows, (caller) => {
    if (platform.windows === null) return t('app.window.noSecondWindow');
    if (!workspace || !host) return t('app.window.nothingToGather');
    if (caller.windowId === -1) return t('app.window.unknownCaller');
    for (const entry of host.summaries) workspace.move(entry.id, caller.windowId);
    workspace.save();
    publishRosters();
    for (const windowId of windows.ids()) {
      if (windowId === caller.windowId) continue;
      if (summariesFor(windowId).length === 0) platform.windows.close(windowId);
    }
    return null;
  });

  /*
   * The rail was dragged into a new order.
   *
   * The *session* does not move, the same way popping out does not move one:
   * this changes which order a window's tabs are drawn in and nothing else. The
   * asking window is the one reordered — a rail belongs to the window it is
   * drawn in — and `Workspace.reorder` honours only the tabs that window
   * actually owns, so a stale list arriving from a renderer cannot adopt
   * somebody else's character.
   *
   * Republished afterwards rather than trusted: the renderer's optimistic
   * order and main's answer must be the same list, and main's is the one that
   * was written down.
   */
  handle(Invoke.reorderSessions, (caller, order: SessionId[]) => {
    if (!workspace) return;
    if (caller.windowId === -1) return;
    workspace.reorder(railOf(caller.windowId), order);
    workspace.save();
    publishRosters();
  });

  handle(Invoke.popIn, (_caller, session: SessionId) => {
    if (platform.windows === null) return t('app.window.noSecondWindow');
    if (!workspace || !host?.has(session)) return t('app.profiles.noSuchCharacter');
    const main = platform.mainWindowId();
    if (main === null) return t('app.window.noMainWindow');
    const from = workspace.windowOf(session);
    workspace.move(session, main);
    workspace.save();
    publishRosters();
    // A window with nothing left in it is a frame around nothing.
    if (from !== null && from !== main && summariesFor(from).length === 0) {
      platform.windows.close(from);
    }
    platform.windows.focus(main);
    return null;
  });
  handle(Invoke.listProfiles, () => profileSummaries());

  handle(Invoke.loadProfile, (_caller, id: SessionId) => {
    if (!profileFor(id)) return;
    unloaded.delete(id);
    host?.ensure(id);
    publishRosters();
  });

  /*
   * Closing a character's tab. Refuses while it is holding a socket unless the
   * caller has already asked the player: a tab closed by a stray click must not
   * be able to drop a character in a dangerous room.
   */
  handle(Invoke.unloadProfile, (_caller, id: SessionId, force?: boolean) => {
    const slot = host?.get(id);
    if (!slot) return null;

    if (!force && !DORMANT_PHASES.has(slot.manager.state.phase)) {
      return t('app.profiles.stillConnected', { name: profileFor(id)?.name ?? id });
    }

    unloaded.add(id);
    host?.remove(id);
    publishRosters();
    return null;
  });

  /*
   * Attaching registers the window and returns the retained output in one
   * synchronous step, so nothing can arrive between the two and be lost. The
   * renderer holds live chunks until this resolves and writes them after the
   * replay — otherwise the catch-up would land on top of output newer than it.
   */
  handle(Invoke.attach, (caller, session: SessionId): AttachSnapshot => {
    /*
     * Looks the session up; never creates it. Sessions come from profiles now,
     * so a window attaching to an id nobody defines must get an empty view
     * rather than conjure a character out of a stale tab.
     */
    const slot = host?.get(session);
    if (slot) windows.attach(caller.windowId, session);
    const manager = slot?.manager;
    return {
      backscroll: slot?.backscroll.text ?? '',
      lines: manager?.lines ?? [],
      state: manager?.state ?? IDLE_STATE,
      character: manager?.character ?? EMPTY_CHARACTER,
      walk: manager?.walker.progress ?? IDLE_WALK,
      loop: manager?.loops.progress ?? NO_LOOP,
      automation: manager?.automation ?? EMPTY_AUTOMATION,
      verdict: manager?.verdict ?? EMPTY_ROOM_VERDICT,
      telnet: manager?.log ?? [],
      learned: manager?.learned ?? [],
      finds: manager?.foundHere ?? [],
      questSaid: { ...(manager?.questProgress ?? {}) },
      // The Talk card's history. Only for a session that exists: attach never
      // creates one, so it must not conjure a log for a stale id either.
      talk: slot ? talkFor(session).backlog() : []
    };
  });

  handle(Invoke.detach, (caller, session: SessionId) => {
    windows.detach(caller.windowId, session);
  });

  // ----------------------------------------------------------------- app level

  handle(Invoke.getConfig, () => config?.snapshot ?? fallbackSnapshot());
  handle(Invoke.getInternal, () => internal?.config ?? DEFAULT_INTERNAL);

  /*
   * Revealing a path.
   *
   * On the desktop the host opens the operating system's file manager and
   * the answer is `opened`. A host that cannot — a browser tab has no file
   * manager on the machine the files are on — answers `listed` with the
   * path, and the window shows it in a listing of its own (`browseHome`).
   * Said in the answer rather than inferred from the host kind, so the
   * window acts on what happened.
   */
  const reveal = async (target: string, kind: 'file' | 'directory'): Promise<Revealed> =>
    (await platform.reveal(target, kind)) ? { how: 'opened' } : { how: 'listed', path: target };

  handle(Invoke.revealConfig, (): Promise<Revealed> =>
    reveal(config?.path ?? home.options, 'file')
  );
  handle(Invoke.revealProfiles, (): Promise<Revealed> => {
    profiles?.ensureDirectory();
    return reveal(home.profilesDir, 'directory');
  });

  /*
   * A directory under the home, for the window that cannot open one. Names
   * and sizes, never contents — the reasoning is in `app/browse.ts`, and the
   * confinement to the home root is enforced there on the resolved path.
   * Whether a file could be a realm is decided by the same list the desktop's
   * picker filters on, so the two answer alike.
   */
  handle(Invoke.browseHome, (_caller, target: unknown): Promise<HomeListing> =>
    listHome(
      home.root,
      typeof target === 'string' ? target : null,
      (name) => {
        const extension = path.extname(name).slice(1).toLowerCase();
        return (REALM_EXTENSIONS as readonly string[]).includes(extension);
      },
      {
        outside: () => t('app.home.outside'),
        unreadable: (at, message) => t('app.home.unreadable', { path: at, message })
      }
    )
  );

  /*
   * Every world query is addressed, for the same reason every push is: with a
   * realm per character, an unaddressed one would answer from whichever realm
   * happened to be the client's. A destination searched on one character's
   * realm and walked on another's is a route to a room that does not exist.
   */
  handle(Invoke.searchRooms, (_caller, session: SessionId, query: string) => {
    const world = worldFor(session);
    if (!world) return [];
    /*
     * Two numbers identify a room outright, so they never go to the name search.
     *
     * The realm keys every room on `map/room` and the Room card's badge shows
     * that pair -- and typing what it showed found nothing, because this field
     * was a substring query over room *names*. A reference is answered by the
     * index instead, which means exactly one room or none: the candidate ladder
     * name search needs cannot apply to a key that is already unique.
     *
     * Deliberately no fallback to a name search when the room is not there. A
     * reference that misses is a room the realm does not have, and running a
     * name query for "1/99999" afterwards would fail a second time and blame
     * the wrong thing.
     */
    const reference = asRoomReference(query);
    if (reference !== null) {
      const room = world.get(reference.map, reference.room);
      return room === undefined ? [] : [{ ...room, visitedAt: null }];
    }

    /*
     * Where this character's realm has been walked to, first.
     *
     * `searchByName` is a substring match over 55,806 rooms, capped at 25, in
     * the world file's own build order — so `forest` answers with whichever
     * forests the file happens to list first, and the one the player means is
     * usually not among them. It is almost always somewhere they have been
     * before, and the client knows which those are because it planned the
     * route. So the recent matches go on top, newest first.
     *
     * They are *added* to the realm's answer rather than replacing part of it:
     * a room already recorded is dropped from the realm rows below rather than
     * listed twice, and the realm's own count is unchanged, so putting the
     * shortcut on top never costs a result somebody could have had.
     */
    const shown = tuning().records.destinationsShown;
    const recent = destinationsFor(session).matching(query, shown);
    const seen = new Set(recent.map((entry) => entry.id));
    const found = world
      .searchByName(query)
      .map((room) => ({ ...room, visitedAt: null }))
      .filter((room) => !seen.has(roomId(room.map, room.room)));

    return [
      ...recent.flatMap((entry) => {
        /*
         * Resolved against the realm rather than drawn from the record.
         *
         * The record holds a name from whenever the walk happened, and the
         * realm underneath it can be swapped — `world.database` is a
         * per-character setting. A row whose id the realm no longer has is
         * dropped rather than offered: clicking it would plan a route to a
         * room that does not exist, which is the confidently wrong answer this
         * project refuses everywhere else. It stays in the file, because the
         * realm may be swapped back.
         */
        const reference = asRoomReference(entry.id);
        const room = reference === null ? undefined : world.get(reference.map, reference.room);
        return room === undefined ? [] : [{ ...room, visitedAt: entry.at }];
      }),
      ...found
    ];
  });
  handle(Invoke.worldInfo, (_caller, session: SessionId) => {
    const world = worldFor(session);
    return { rooms: world?.size ?? 0, source: world?.info.source ?? 'none' };
  });
  handle(Invoke.questBook, (_caller, session: SessionId) => {
    // A realm with no world loaded, and one converted before quests were
    // indexed, both answer with none — which the card says out loud.
    return worldFor(session)?.quests() ?? [];
  });
  handle(
    Invoke.localMap,
    (_caller, session: SessionId, map: number, room: number, radius?: unknown) => {
      const world = worldFor(session);
      if (!world || world.size === 0) return EMPTY_MAP;
      /*
       * Parsed, not trusted. The card measures its own box and asks for the
       * radius it can show, and that number arrives here as a payload like any
       * other — the search is breadth-first and exponential in it, so a window
       * asking for a radius of four hundred would walk the realm on the main
       * process's own thread. Bounded to the same range the card clamps to;
       * anything else is `undefined`, which takes `DEFAULT_RADIUS`.
       */
      const { mapRadiusMin, mapRadiusMax } = tuning().view;
      const asked =
        typeof radius === 'number' && Number.isInteger(radius)
          ? Math.max(mapRadiusMin, Math.min(mapRadiusMax, radius))
          : undefined;
      return localMap(world, roomId(map, room), asked);
    }
  );
  handle(Invoke.huntingGrounds, (_caller, session: SessionId, radius: unknown) => {
    const manager = host?.get(session)?.manager;
    // Parsed, never trusted: a radius is a sweep's bound on main's own thread.
    const steps =
      typeof radius === 'number' && Number.isFinite(radius)
        ? Math.max(1, Math.min(400, Math.trunc(radius)))
        : tuning().hunting.betterSpotRadius;
    if (!manager) {
      return {
        from: null,
        radius: steps,
        spots: [],
        assumptions: {
          family: null,
          hpMax: null,
          restingHealthPerTick: null,
          backstab: false,
          constants: tuning().hunting
        },
        refusal: t('session.hunt.noSession')
      } satisfies HuntingAdvice;
    }
    return manager.huntingGrounds(steps);
  });
  /*
   * Where this character may go and level. Addressed, and answered from the
   * realm's own shop rows rather than from a room name — see `trainersTaking`.
   * No session is an empty list, which is what the picker draws as *nowhere
   * the realm says will take you*.
   */
  handle(Invoke.trainers, (_caller, session: SessionId) => {
    return host?.get(session)?.manager?.trainers() ?? [];
  });
  /*
   * The items the realm says would serve each condition a potion rule can
   * name. A property of the realm rather than the character, so one call
   * answers every row the settings screen draws.
   */
  handle(Invoke.itemsServing, (_caller, session: SessionId) => {
    const world = worldFor(session);
    if (!world) return {};
    return {
      hp: world.itemsServing('hp').map((item) => item.name),
      poisoned: world.itemsServing('poisoned').map((item) => item.name),
      blind: world.itemsServing('blind').map((item) => item.name),
      diseased: world.itemsServing('diseased').map((item) => item.name)
    };
  });
  handle(Invoke.roomBrief, (_caller, session: SessionId, map: number, room: number) => {
    const world = worldFor(session);
    // A realm with no world loaded knows nothing about any room, which is the
    // same answer as a room it does not hold: the panel says so either way.
    if (!world || world.size === 0) return null;
    return roomBrief(world, roomId(map, room));
  });

  /*
   * The four world queries that used to live here — `shopHere`, `lairHere`,
   * `answersHere` and `itemsKnown` — are gone (2026-09-02).
   *
   * Every one of them answered a question main had already answered: the shop,
   * the lair, the room's script and what the realm knows about an item are all
   * settled the moment the room resolves or the pack listing is parsed, and
   * `CharacterTracker` attaches them to the entities it publishes. They
   * crossed the wire on demand only because the room was a bag of strings and
   * the pack was a list of names when they were added — and the cost was four
   * React effects that each ran *after* the card had drawn once without the
   * answer, each with its own stale-value hazard when a character switched.
   */

  /**
   * Who this character is, as the realm numbers races and classes.
   *
   * The stat sheet prints the realm's own words (`Race: Halfling`,
   * `Class: Mystic`) and an item's restrictions are row ids, so the join
   * happens here, where both tables are. Null throughout until a sheet has
   * printed — and null is *unknown*, which the equip check never refuses on.
   */
  handle(Invoke.wearer, (_caller, session: SessionId): Wearer => wearerIn(session));

  /**
   * Everything the realm knows about a name — monster, item or spell.
   *
   * The Reference card's query, and the one behind every "what is this thing"
   * click on a card. One handler across the three indexes because the caller
   * has a *name* and should not need to know which table answers it.
   */
  handle(Invoke.lookup, async (_caller, session: SessionId, query: unknown) => {
    const world = worldFor(session);
    if (!world) return { mobs: [], items: [], spells: [], races: [], classes: [] };
    /*
     * Asked from where the reader is standing, which is what tells two of the
     * realm's rows apart under one name: the Gnoll Tent's own lair names row
     * 224 and the nearest room row 2204 spawns in is on another map, so the
     * card answers `100 hp` rather than the fold's `100–830`. A session whose
     * character has not placed itself yet passes null and gets the fold.
     */
    const here = host?.get(session)?.manager.character.room;
    const at =
      !here || here.map === null || here.number === null ? null : roomId(here.map, here.number);
    const found = world.lookup(typeof query === 'string' ? query.slice(0, 128) : '', 12, at);
    // And what this character's realm has learned about each monster named,
    // beside the realm's figure. Only where fighting has taught something.
    const lore = loreFor(session);
    const learned: Record<string, MobLoreEntry> = {};
    for (const mob of found.mobs) {
      const entry = lore.learnedFor(mob.name);
      if (entry !== null) learned[mob.name] = entry;
    }
    // One read of the record for every monster named, resolved through the
    // realm table the way the lore is, so a rat king's fights stay its own.
    const fights = Object.fromEntries(
      (await fightLogs.get(session)?.summaries(
        found.mobs.map((mob) => mob.name),
        (printed) => world.mobAsPrinted(printed)?.name ?? printed
      )) ?? []
    ) as Record<string, FightSummary>;
    /*
     * Where every shop that sells one of these items is.
     *
     * Resolved here so that reading `Sold by` and walking to one of them is
     * one round trip rather than two: the card would otherwise need a channel
     * of its own, asked per click, for a join the realm file can already make.
     * A shop the realm places in no room contributes no key, which is what
     * leaves its name plain text on the card rather than a control that goes
     * nowhere.
     */
    const shopPlaces: Record<string, ShopPlace> = {};
    for (const item of found.items) {
      for (const shop of item.shops ?? []) {
        const key = shop.trim().toLowerCase();
        if (key.length === 0 || key in shopPlaces) continue;
        const place = world.shopPlace(shop);
        if (place !== undefined) shopPlaces[key] = place;
      }
    }
    /*
     * And where the realm puts each monster named.
     *
     * Same join, made in the same place and for the same reason as the shops
     * above: *what is this thing* and *where do I find one* are one question
     * asked twice, and the answer to the second was in the room table with no
     * door to it. Keyed by the monster's own name, as `learned` and `verdicts`
     * are, so the card reads all four off one answer.
     */
    const mobPlaces: Record<string, MobPlaces> = {};
    for (const mob of found.mobs) {
      const places = world.mobPlaces(mob);
      if (places !== undefined) mobPlaces[mob.name] = places;
    }
    /*
     * And *can I fight this?* — each monster named, weighed against the
     * character as it stands at this moment, by the session's own arithmetic
     * so the card reads exactly what auto-combat ranks on. A session with no
     * manager (a stale id) has no character to weigh against and gets none.
     */
    const verdicts = host?.get(session)?.manager.appraise(found.mobs.map((mob) => mob.name)) ?? {};
    return {
      ...found,
      ...(Object.keys(learned).length > 0 ? { learned } : {}),
      ...(Object.keys(fights).length > 0 ? { fights } : {}),
      ...(Object.keys(shopPlaces).length > 0 ? { shopPlaces } : {}),
      ...(Object.keys(mobPlaces).length > 0 ? { mobPlaces } : {}),
      ...(Object.keys(verdicts).length > 0 ? { verdicts } : {})
    };
  });

  /*
   * Parsed, not trusted: the payload names a record to delete from a file the
   * player owns, so a malformed one is refused rather than matched loosely.
   */
  /*
   * A command asked for from a card, sent through the arbiter like every
   * automated command — which is what makes it quiet when `internal.yaml`
   * says so. Parsed: one word, from a short allowlist, because this is a
   * window handing main a string that becomes bytes on a socket.
   */
  handle(Invoke.ask, (_caller, session: SessionId, command: unknown) => {
    if (typeof command !== 'string' || !/^[a-z]{1,8}$/.test(command)) return false;
    return host?.get(session)?.manager.ask(command) ?? false;
  });

  /*
   * A gear button: the kit back on, all of it on, all of it off, or one item.
   *
   * **Decided here, not in the renderer**, for the reason `actions.ts` gives
   * about the buttons beside a room's name: the pack, the remembered loadout
   * and the realm's own word on what can be worn all live in main, and a
   * renderer deciding this would be a second reading of all three. What
   * crosses the wire is an action from a closed list and, for one item, a name
   * — and the name is resolved against the pack before it becomes a command,
   * so a stale card cannot make this send `wear` at something that is not
   * there. An unrecognised command on this server is said out loud in the room.
   *
   * The plans are pure and in `shared/gear.ts`, which is what lets the card
   * offer only the buttons that would do something.
   *
   * Each command goes through `ask` — the arbiter, `probe` band, coalesced by
   * its own text — so a bulk action is paced exactly as everything else
   * automated is and never displaces an attack or an escape. Bounded by
   * `tuning.spending.maxGear`, and the cap is said out loud rather than silently applied.
   */
  handle(Invoke.gear, (_caller, session: SessionId, action: unknown, item: unknown): number => {
    if (typeof action !== 'string' || !(GEAR_ACTIONS as readonly string[]).includes(action)) {
      return 0;
    }
    const manager = host?.get(session)?.manager;
    if (!manager) return 0;
    const state = manager.character;
    const items = state.inventory.items;

    const plan = ((): GearPlan => {
      switch (action as GearAction) {
        case 'restore':
          return restorePlan(state.loadout, items, tuning().spending.maxGear);
        case 'equip-all':
          return equipAllPlan(
            items,
            (name) => wearableIn(session, name),
            tuning().spending.maxGear
          );
        case 'drop-all':
          return dropAllPlan(items, tuning().spending.maxGear);
        /*
         * One item, on or off, and the pack is what says which row.
         *
         * `nameAnswersTo` is the server's own rule for a typed name, so the
         * card may send what it drew and this still finds the row — and the
         * *listing's* spelling is what goes out, never the renderer's string.
         *
         * The row it finds is one the action can actually act on, which
         * matters because a pack holds two of a name as often as one: with a
         * ring on a finger and its twin in the pack, taking the first match
         * would have *Take off* find the spare and *Put on* find the worn
         * one, and both buttons would silently do nothing. A name held only
         * in the wrong state is therefore already done rather than missing —
         * and a name the pack does not hold at all is said out loud, because
         * after a death the difference between "already off" and "gone" is
         * the half the player needs.
         */
        case 'equip':
        case 'remove': {
          if (typeof item !== 'string') return { commands: [], missing: [], overflow: 0 };
          const wanted = action === 'equip';
          const matching = items.filter((carried) => nameAnswersTo(carried.name, item));
          if (matching.length === 0) return { commands: [], missing: [item], overflow: 0 };
          const held = matching.find((carried) => carried.equipped !== wanted);
          if (!held) return { commands: [], missing: [], overflow: 0 };
          return {
            commands: [wanted ? equip(held.name) : unequip(held.name)],
            missing: [],
            overflow: 0
          };
        }
      }
    })();

    for (const command of plan.commands) manager.ask(command);
    if (plan.missing.length > 0) {
      announce(
        'gear',
        t('automation.gear.missing', {
          count: plan.missing.length,
          items: plan.missing.join(', ')
        })
      );
    }
    if (plan.overflow > 0) {
      announce(
        'gear',
        t('automation.gear.capped', { max: tuning().spending.maxGear, more: plan.overflow })
      );
    }
    return plan.commands.length;
  });

  /*
   * A button beside a room's name that main runs: `Deposit All`.
   *
   * Nothing crosses but the name of the action, checked against the closed
   * list — `gear:act`'s rule, and here it carries more weight than usual,
   * because the whole reason this is not a list of commands is that the
   * figure a deposit names is not knowable until the `i` it sends has been
   * answered. `SessionManager.depositAll` owns the wait; see `AutoDeposit`.
   *
   * A refusal — nothing to bank, or a button pressed from the backscroll
   * beside a room the character left — reports itself as a notice, so `false`
   * here is never silent.
   */
  handle(Invoke.terminalAct, (_caller, session: SessionId, action: unknown): boolean => {
    if (typeof action !== 'string' || !(TERMINAL_ACTIONS as readonly string[]).includes(action)) {
      return false;
    }
    const manager = host?.get(session)?.manager;
    if (!manager) return false;
    switch (action as TerminalActionName) {
      case 'deposit-all':
        return manager.depositAll();
    }
  });

  /*
   * A question at another player, from the palette. Parsed, for the same
   * reason `ask` is: a name is a word the realm accepts as one, and the
   * command is one of the closed list — anything else is refused rather than
   * turned into bytes on the socket.
   */
  handle(Invoke.askRemote, (_caller, session: SessionId, who: unknown, name: unknown) => {
    if (typeof who !== 'string' || !/^[A-Za-z][A-Za-z'-]{0,30}$/.test(who)) return false;
    if (typeof name !== 'string' || !(REMOTE_NAMES as readonly string[]).includes(name)) {
      return false;
    }
    return host?.get(session)?.manager.askRemote(who, name as RemoteName) ?? false;
  });

  handle(Invoke.names, (_caller, session: SessionId) => {
    return (
      worldFor(session)?.names() ?? {
        items: [],
        mobs: [],
        spells: [],
        races: [],
        classes: [],
        rooms: []
      }
    );
  });

  handle(Invoke.forget, (_caller, session: SessionId, discovery: unknown) => {
    if (typeof discovery !== 'object' || discovery === null) return false;
    const { from, command } = discovery as Record<string, unknown>;
    if (typeof from !== 'string' || typeof command !== 'string') return false;
    return host?.get(session)?.manager.forget({ from, command }) ?? false;
  });

  handle(Invoke.forgetCharacter, (_caller, session: SessionId) => {
    return host?.get(session)?.manager.forgetCharacter() ?? false;
  });

  // Parsed, not checked, like every payload that reaches a file on disk.
  handle(Invoke.forgetFind, (_caller, session: SessionId, find: unknown) => {
    if (typeof find !== 'object' || find === null) return false;
    const { room, name } = find as Record<string, unknown>;
    if (typeof room !== 'string' || typeof name !== 'string') return false;
    return host?.get(session)?.manager.forgetFind({ room, name }) ?? false;
  });

  /*
   * Writing settings back.
   *
   * Every payload is *parsed* rather than checked — `asProfileDraft`,
   * `asProfileId`, `asServerDraft` return the typed value or null — because
   * these are the payloads that become files on disk holding credentials. A
   * malformed one is a character dialling somewhere nobody chose, which is the
   * exact failure a profile with no server is refused for.
   *
   * Each resolves to *why it refused*, or null. Nothing here throws at the
   * renderer: a settings screen that takes the process down takes every
   * character's socket with it.
   */
  /*
   * What the settings screen's spell pickers offer. The character's own book
   * — the live record when a session holds one on the same realm (the disk
   * copy lags it by a deferred write), the file otherwise — and the cure
   * gates computed over it against that character's realm. The Global page
   * gets the shipped realm's castable spells: it is the starting point a new
   * character copies, and there is no character whose book could narrow it.
   */
  const settingsSpells: NonNullable<SettingsEditorOptions['spells']> = {
    forProfile: (id, target) => {
      const realm = realmAddress(target);
      const live = belongings.get(id as SessionId);
      const book =
        live && live.realm === realm
          ? live.recallSpellbook()
          : peekSpellbook(home.state('belongings', `${id}.json`), realm);
      if (book === null) return { spellbook: null, cureGates: null };
      const world = worldFor(id as SessionId);
      return {
        /*
         * The listing knows what this character can cast; only the realm table
         * knows who each spell may be cast *on*, so the two are joined here.
         * A spell the realm cannot name reads as `unknown`, which every picker
         * offers rather than hides — a derivative realm must not empty the
         * field. See `spellTargeting`.
         */
        spellbook: book.map((spell) => ({
          name: spell.name,
          short: spell.short,
          targeting: spellTargeting(world?.spellNamed(spell.name)?.targets)
        })),
        // No realm to ask means no gates, never closed ones: unknown must
        // not disable a cure.
        cureGates:
          world === undefined
            ? null
            : cureGates(book.map((spell) => world.spellNamed(spell.name)?.abilities))
      };
    },
    realm: () => realms?.load('').graph.castableSpells() ?? []
  };

  const editor = (): SettingsEditor => new SettingsEditor({ home, spells: settingsSpells });

  handle(Invoke.settingsSnapshot, () => editor().snapshot());

  /*
   * A native picker for a realm database.
   *
   * A path typed by hand is a path typed wrong, and the failure — a realm that
   * cannot be read — shows up only after connecting. The filters name what
   * `RealmSource` understands rather than offering everything, and they name it
   * from `REALM_EXTENSIONS` rather than restating it: a dialog offering a file
   * the reader then refuses is a file a player can choose and not use.
   */
  handle(Invoke.chooseRealm, (caller) =>
    /*
     * The host puts the picker up, owned by the window that asked. A host
     * with no native picker answers null — and is never asked: a browser
     * tab's bridge opens the window's own picker over `browseHome` instead,
     * because the disk being browsed is the client's, not the viewer's.
     */
    platform.chooseFile(caller, {
      title: t('app.dialog.chooseRealmTitle'),
      extensions: REALM_EXTENSIONS,
      extensionsLabel: t('app.dialog.realmDatabaseFilter'),
      allFilesLabel: t('app.dialog.allFilesFilter')
    })
  );

  handle(Invoke.saveProfile, (_caller, rawId: unknown, rawDraft: unknown) => {
    const id = asProfileId(rawId);
    if (id === null) return t('app.profiles.invalidId');
    const draft = asProfileDraft(rawDraft);
    if (draft === null) return t('app.profiles.incompleteDraft');
    profiles?.ensureDirectory();
    const result = editor().saveProfile(id, draft);
    // The store polls, so the new character appears without being told; saying
    // so here as well would report it twice.
    return result.ok ? null : result.error;
  });

  handle(Invoke.deleteProfile, (_caller, rawId: unknown) => {
    const id = asProfileId(rawId);
    if (id === null) return t('app.profiles.noSuchCharacter');
    const result = editor().deleteProfile(id);
    return result.ok ? null : result.error;
  });

  handle(Invoke.saveServer, (_caller, previous: unknown, rawDraft: unknown) => {
    const draft = asServerDraft(rawDraft);
    if (draft === null) return t('app.servers.invalidDraft');
    const result = editor().saveServer(typeof previous === 'string' ? previous : null, draft);
    return result.ok ? null : result.error;
  });

  handle(Invoke.saveGlobal, (_caller, rawDraft: unknown) => {
    const draft = asGlobalDraft(rawDraft);
    if (draft === null) return t('app.settings.invalidGlobalDraft');
    const result = editor().saveGlobal(draft);
    // The store polls, so the change reaches every character without being
    // told; saying so here as well would report it twice.
    return result.ok ? null : result.error;
  });

  /*
   * One player's whole grant, from the Player flyout. Validated here rather
   * than trusted: a renderer payload is a value from outside like any other,
   * and the remotes in it are a closed union of fifty-seven.
   */
  handle(Invoke.setRemoteGrant, (_caller, session: unknown, name: unknown, grant: unknown) => {
    if (typeof session !== 'string' || typeof name !== 'string') {
      return t('app.profiles.noSuchCharacter');
    }
    const parsed = asGrant(grant);
    if (parsed === null) return t('app.remotes.invalidName');
    const result = editor().setRemoteGrant(session, name, parsed);
    /*
     * The store polls, so the character picks the change up without being
     * told — but the *renderer* draws the Access face from `ProfileSummary`,
     * which is pushed rather than polled, so the rosters are republished here
     * or the flyout would go on showing the grant it had before the click.
     */
    if (result.ok) publishRosters();
    return result.ok ? null : result.error;
  });

  /* What anybody in this character's gang may ask for, from the Gang card. */
  handle(Invoke.setGangRemotes, (_caller, session: unknown, remotes: unknown) => {
    if (typeof session !== 'string') return t('app.profiles.noSuchCharacter');
    const parsed = asRemoteNames(remotes);
    if (parsed === null) return t('app.remotes.invalidName');
    const result = editor().setGangRemotes(session, parsed);
    if (result.ok) publishRosters();
    return result.ok ? null : result.error;
  });

  /* Whether the gang's own channel is answered on at all. Same card, same push. */
  handle(Invoke.setRemoteGangpath, (_caller, session: unknown, on: unknown) => {
    if (typeof session !== 'string') return t('app.profiles.noSuchCharacter');
    const result = editor().setRemoteGangpath(session, on === true);
    if (result.ok) publishRosters();
    return result.ok ? null : result.error;
  });

  /*
   * This character's supplies list, from the Self card or the item panel.
   * Same shape and same push: the list rides on `ProfileSummary`, and a card
   * that drew the old list until the store's poll came round would show the
   * row somebody just added as missing.
   */
  handle(Invoke.setSupplies, (_caller, session: unknown, items: unknown) => {
    if (typeof session !== 'string') return t('app.profiles.noSuchCharacter');
    const parsed = asSupplyItems(items);
    if (parsed === null) return t('app.supplies.invalidList');
    const result = editor().setSupplies(session, parsed);
    if (result.ok) publishRosters();
    return result.ok ? null : result.error;
  });

  /*
   * One automation switch, from the toolbar. Same shape and same push: the
   * store's poll brings the change back to the *session* on its own, and the
   * rosters are republished here because the toolbar draws from
   * `ProfileSummary`, which is pushed rather than polled — without it the
   * button would stay where it was until something else moved.
   */
  handle(Invoke.setAutomationSwitch, (_caller, session: unknown, name: unknown, on: unknown) => {
    if (typeof session !== 'string') return t('app.profiles.noSuchCharacter');
    // Parsed rather than checked: this crossed the wire, and a path built
    // from an unvalidated name is a write into somebody's YAML at a key
    // nothing reads.
    const parsed = asAutomationSwitch(name);
    if (parsed === null) return t('app.automation.unknownSwitch');
    const result = editor().setAutomationSwitch(session, parsed, on === true);
    if (result.ok) publishRosters();
    return result.ok ? null : result.error;
  });

  /*
   * One loop into one scope, from the Loops modal.
   *
   * Parsed rather than trusted: this payload becomes a file in the user's own
   * tree, and `asLoop` is the same parser the options file goes through, so a
   * loop filed from the modal and one typed by hand cannot mean different
   * things. The scope is a closed union and is checked against its own list
   * rather than interpolated into a path — the failure a wire-built path
   * causes here is a write into somebody's YAML at a key nothing reads.
   */
  handle(Invoke.addLoop, (_caller, scope: unknown, owner: unknown, loop: unknown) => {
    if (!isLoopScope(scope)) return t('app.loop.unknownScope');
    const parsed = asLoop(loop);
    if (parsed === null) return t('app.loop.invalidLoop');
    const result = editor().addLoop(
      scope,
      typeof owner === 'string' && owner.trim().length > 0 ? owner.trim() : null,
      parsed
    );
    // The store's poll would find it within the tick; refreshing now is what
    // makes the modal's own list show it before the player looks away.
    if (result.ok) loops?.refresh();
    return result.ok ? null : result.error;
  });

  handle(Invoke.deleteServer, (_caller, name: unknown) => {
    if (typeof name !== 'string' || name.trim().length === 0) return t('app.servers.noSuchServer');
    const result = editor().deleteServer(name.trim());
    return result.ok ? null : result.error;
  });

  handle(Invoke.revealLogs, async (): Promise<Revealed> => {
    const directory = logDirectory();
    // The directory may not exist yet if nothing has been logged; opening a
    // missing path silently does nothing, which reads as a broken menu item.
    await fs.mkdir(directory, { recursive: true }).catch(() => undefined);
    return reveal(directory, 'directory');
  });

  /*
   * The clipboard, for the terminal's copy and paste. See the channel's own
   * note for why this is here rather than `navigator.clipboard` in the window.
   *
   * The payload is checked rather than trusted, like every other one that
   * crosses this boundary — and an empty write is refused rather than
   * performed, because clearing somebody's clipboard is not what "copy
   * nothing" should mean.
   *
   * A host with no clipboard is never asked: a browser tab's bridge keeps
   * the window's own (`navigator.clipboard`), for the reason the desktop
   * does not — there the browser's chord is bound and its permission is the
   * tab's to grant. Answered honestly all the same, so a bridge that did ask
   * would learn nothing was written.
   */
  handle(Invoke.copyText, (_caller, text: unknown) => {
    if (typeof text !== 'string' || text.length === 0) return;
    if (platform.clipboard === null) {
      announce('clipboard', t('app.clipboard.none'));
      return;
    }
    platform.clipboard.write(text);
  });
  handle(Invoke.pasteText, () => {
    if (platform.clipboard === null) {
      announce('clipboard', t('app.clipboard.none'));
      return '';
    }
    return platform.clipboard.read();
  });
}

/** Sessions this launch has already dialled on its own. See `clientReady`. */
const autoConnected = new Set<SessionId>();

/** Whether this launch has done its autoconnect pass. See `clientReady`. */
let launched = false;

/** Used only if the store somehow failed to construct; keeps the API total. */
function fallbackSnapshot() {
  return { config: DEFAULT_CONFIG, path: '', error: null, loadedAt: 0 };
}

/**
 * Last resort, so one bug cannot cost four characters.
 *
 * The main process holds every session's socket. Node's default for an uncaught
 * exception is to exit, and for an unhandled rejection likewise — which here
 * means a defect anywhere, in any window's IPC handler, silently disconnects
 * every character the player has in the realm. That is the largest blast radius
 * in the application and the cheapest to contain.
 *
 * Staying up is the right trade for an interactive client, but it is only
 * defensible if it is *loud*: this reports to the console and into the terminal
 * the player is looking at. It is not a catch-all that hides defects — it is
 * the thing that stops a defect taking hostages while it is being reported.
 */
function guardTheProcess(): void {
  const report = (kind: string, cause: unknown): void => {
    const detail = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    console.error(`${kind}:`, detail);
    // The kind rides in the diagnostic payload: in a packaged build this
    // notice is the only copy anybody sees, and "please report this" needs
    // the fault named, not only its message.
    notice(t('app.crash.guardNotice', { message: `${kind}: ${errorMessage(cause)}` }));
  };

  process.on('uncaughtException', (error) => report('uncaught exception', error));
  process.on('unhandledRejection', (reason) => report('unhandled rejection', reason));
}

/**
 * Builds the client on the host it is given, and opens it.
 *
 * The one entry point. `src/main/index.ts` chooses the host — the desktop by
 * default, the web server under `MUDENGINE_WEB=1` — and everything here is
 * the same on both: the same stores, the same sessions, the same handlers
 * behind the same channels. What differs is asked of `platform` at the point
 * it differs.
 */
export function startClient(host: Host): void {
  platform = host;
  asked = homeRoot(process.env, host.defaultHome);
  home = homeAt(asked.root);

  /*
   * Ctrl-C in the terminal that launched the client is still an exit.
   *
   * Node's default for a signal is to terminate immediately, which takes
   * every socket down with it uncleanly — the disconnect this realm charges
   * for (docs/greatermud/combat.md) — and abandons the lore and memory writes
   * that are scheduled lazily. So a signal runs the same teardown a quit
   * does, and then ends the process through the host, which deliberately does
   * **not** ask: a confirmation nobody is looking at is a client that hangs on
   * a modal dialog, and somebody signalling the process has already decided.
   * `docker stop` is this path too.
   *
   * A second signal goes through immediately. Replacing the default handler
   * is only defensible if the thing everybody reaches for when an app will
   * not die still works.
   */
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (signalled) process.exit(1);
      signalled = true;
      console.log(`\nshutdown: ${signal}.`);
      teardown();
      exitOnceItHasBeenSaid();
    });
  }

  /*
   * Claimed before anything is built, because everything built here is
   * shared.
   *
   * The reasoning, and the measurement that produced it, are in
   * `src/main/app/instance.ts`. In short: a second client on one profile
   * makes the *first* one's storage contended — a three-second black window on
   * the next launch, which is how this was found — and then the two of them
   * write the same lore, memory and fight logs and dial the same characters.
   */
  const ownsTheProfile = host.claimInstance({
    say: (message) => console.log(message),
    leave: exitOnceItHasBeenSaid
  });

  void host.ready().then(() => {
    /*
     * A launch that bounced off the client already running is on its way
     * out; the host's `exit` waits for its own explanation to be flushed, so
     * `ready` can still resolve in between. It must not build a client on
     * the way.
     */
    if (!ownsTheProfile) return;
    build();
  });
}

/** Everything, in the order each thing's dependencies demand. Once. */
function build(): void {
  guardTheProcess();
  /*
   * The home, before anything reads from it.
   *
   * The host's own lock keeps one desktop client per profile; this keeps one
   * client per *home* across hosts, because a web client started beside a
   * desktop one lands on the same directory and neither lock would know. A
   * refusal names the holder and where the lock is, then leaves the way a
   * bounced second launch leaves — nothing built, nothing to tear down.
   */
  const claim = claimHome(home.root);
  if (!claim.held) {
    console.log(t('app.instance.homeHeld', { home: home.root, pid: claim.by, file: claim.file }));
    exitOnceItHasBeenSaid(1);
    return;
  }
  homeLock = claim.lock;
  if (claim.recovered !== null) {
    announce('home', t('app.instance.staleLock', { pid: claim.recovered }), 'log');
  }
  /*
   * Before anything reads a file: the tree may still be in the shape an older
   * build left it in, and every store below would otherwise find an empty
   * directory and quietly create a fresh configuration beside somebody's real
   * one. Said out loud, because a migration that moved a player's characters
   * and reported nothing is indistinguishable from one that lost them.
   */
  // Said before anything else, because it changes where every file below is
  // read from and written to.
  if (asked.note !== undefined) announce('home', asked.note, 'log');
  migrateHome({
    home,
    legacyOptions: legacyOptionsFiles(),
    /*
     * The shipped templates, which sit in the *same directory* a development
     * run used to keep the live files in. Without this the migration carries
     * `internal.yaml` out of the repository -- it is both the template and,
     * under the old layout, the file the client wrote to, which is the other
     * half of why that layout had to go.
     */
    keep: [configTemplate(), internalTemplate(), profileTemplate()],
    /*
     * Named rather than taken from `keep[0]`: a migration that *renames* a
     * block needs the template's current annotation for it, and a positional
     * dependency on a list about something else is how that quietly stops
     * working.
     */
    template: configTemplate(),
    // And the tuning template, for the file the player hand-edits to
    // experiment: its paragraphs are documentation too.
    internalTemplate: internalTemplate(),
    /*
     * The shelf, for the one migration that has to recognise a loop copied off
     * it. A function, so the lazy read above stays lazy for a client with no
     * copied loop on disk -- and is warm for the picker where there is one.
     */
    loopShelf: () => loopCatalogue().all(),
    note: (message) => announce('home', message, 'log')
  });
  config = createConfig();
  seedServers();
  servers = createServers();
  loops = createLoops();
  publishTree();
  internal = createInternal();
  lore = createLore();
  playerBook = createPlayerBook();
  destinations = createDestinations();
  worldBook = createWorldBook();
  realms = createRealms();
  /*
   * Loaded before the window, and said out loud.
   *
   * In a packaged build the resources directory is somewhere else and
   * `resourcesDir()` probes candidates for it, so this line is the difference
   * between a working package and one that silently cannot say where anybody is
   * standing. Eagerly rather than on the first session for the same reason:
   * finding out at connect time is finding out too late.
   */
  realms.shippedGraph();
  workspace = new Workspace({
    mainWindowId: () => platform.mainWindowId(),
    allSessions: () => host?.summaries.map((entry) => entry.id) ?? [],
    // Under the user data directory, not the options file: it is chrome state,
    // it changes constantly, and writing it into a hand-annotated YAML the user
    // edits would mean the client fighting them for it.
    file: home.state('workspace.json')
  });
  // Before the host: it asks the profile store which options each session runs
  // under, and the answer has to exist by the time the first one is created.
  profiles = createProfiles();
  host = createHost();
  syncSessions(profiles.snapshot);
  registerIpc();

  /*
   * Everything exists and every channel answers: open. The desktop makes its
   * window here (and whatever was popped out last time); the web server
   * starts listening. What a host reaches back into is the whole of this
   * object, and it is handed over rather than imported so the host cannot
   * touch a store before it is built.
   */
  platform.open({
    home,
    windows,
    workspace: () => workspace,
    publishRosters,
    quitting,
    appIcon,
    abort
  });
}

/**
 * A host that cannot open — a port already taken, a password file it cannot
 * read — ends the client the way a signal does: the reason on stdout, the
 * teardown run so every store is disposed and the lock released, and the
 * exit held until the reason has actually left the pipe. `process.exit` on
 * the line after `console.error` loses the one sentence that says why, and
 * skips the teardown that puts the home back the way it was found.
 */
function abort(reason: string): void {
  console.log(reason);
  teardown();
  exitOnceItHasBeenSaid(1);
}

/**
 * A teardown step that cannot take the rest of the quit down with it.
 *
 * Quitting is the one moment where every deferred write is flushed and every
 * socket is closed, and `guardTheProcess` keeps the process up on an uncaught
 * exception — which *here* means a client with no window, no way back to one
 * and a terminal that never returns. So a step that fails is reported and the
 * next one runs anyway: a lore file that will not write must not cost four
 * characters their clean disconnect.
 */
function settle(what: string, step: () => void): void {
  try {
    step();
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(`shutdown (${what}):`, detail);
  }
}

/** Flush what is deferred, close what is open. Called once, on the way out. */
function teardown(): void {
  // Said out loud, because by this point the window it would otherwise be
  // reported through is already gone: a client that stops on the way out has
  // stopped somewhere, and this is the line that says where.
  console.log('shutdown: disconnecting and flushing what is deferred…');
  settle('workspace', () => workspace?.save());
  settle('internal', () => internal?.dispose());
  // Written before the sessions go: what the last fight taught is scheduled
  // lazily, and quitting is exactly when that schedule has not fired yet.
  settle('lore', () => lore?.flush());
  // And what every character saw of everybody else, for the same reason.
  settle('players', () => playerBook?.flush());
  // And where they were walking to, for the same reason again: a route started
  // in the last five seconds is on a deferred timer that quitting pre-empts.
  settle('destinations', () => destinations?.flush());
  // Same reason, same moment: a discovery made in the last two seconds of a
  // session is written on a deferred timer, and quitting is when that timer has
  // not fired.
  for (const [id, memory] of memories) settle(`memory ${id}`, () => memory.close());
  memories.clear();
  // The realm-wide half, on the same deferred timer and for the same reason.
  for (const [realm, memory] of realmMemories) {
    settle(`memory realm ${realm}`, () => memory.close());
  }
  realmMemories.clear();
  // Same reason again: a fight that ended in the last two seconds is held on a
  // timer, and quitting is when that timer has not fired.
  for (const [id, log] of fightLogs) settle(`fights ${id}`, () => log.dispose());
  fightLogs.clear();
  // And the conversation: a line said in the last two seconds is on the same
  // kind of deferred timer.
  for (const [id, log] of talkLogs) settle(`talk ${id}`, () => log.dispose());
  talkLogs.clear();
  // And once more for the character's own record: a `bank` answered or a helm
  // put on in the last two seconds is on the same kind of deferred timer.
  for (const [id, record] of belongings) settle(`belongings ${id}`, () => record.close());
  belongings.clear();
  settle('sessions', () => {
    host?.disposeAll();
    host = null;
  });
  settle('profiles', () => {
    profiles?.dispose();
    profiles = null;
  });
  settle('options', () => {
    config?.dispose();
    config = null;
  });
  // Last, after the sessions have gone: what the teardown said on its way
  // reaches a tab that is still connected, and the web host's server is the
  // thing that would otherwise hold the process open.
  settle('host', () => platform.close());
  // And the home is given up once nothing here can write to it any more.
  settle('lock', () => {
    homeLock?.release();
    homeLock = null;
  });
}

/**
 * The question, asked where somebody can still answer it.
 *
 * The specific cost, not a generic "are you sure": somebody who knows what a
 * hangup costs here will read this and somebody who does not will learn it at
 * the moment it matters.
 */
function askAboutQuitting(connected: SessionId[]): QuitAnswer {
  const names = connected
    .map((id) => host?.summaries.find((entry) => entry.id === id)?.name ?? id)
    .join(', ');
  return platform.askAboutQuitting({
    title: t('app.quit.dialogTitle'),
    message:
      connected.length === 1
        ? t('app.quit.whoIsConnected.one', { name: names })
        : t('app.quit.whoIsConnected.many', { count: connected.length, names }),
    detail: t('app.quit.consequenceDetail'),
    confirm: t('app.quit.confirmButton'),
    cancel: t('app.quit.cancelButton')
  });
}

/**
 * The one decision about ending the app, consulted from both places.
 *
 * A window's own `close` asks it first, so declining actually keeps the
 * window; `before-quit` asks it again on the way through and gets the latched
 * answer rather than putting the same dialog up twice. See `quitGuard`.
 */
const quitting = quitGuard({
  connected: () => host?.connectedIds ?? [],
  ask: askAboutQuitting,
  ensureWindow: () => {
    const windowsOf = platform.windows;
    if (windowsOf !== null && windowsOf.count() === 0) windowsOf.open([]);
  },
  teardown
});

/** Whether a signal has already been answered. See `startClient`. */
let signalled = false;

/**
 * Puts the handlers above back, because **opening a socket takes them away**.
 *
 * Measured rather than reasoned, and it took a bisect to find. With no
 * connection — or with one that was *refused* — a SIGTERM runs the handler and
 * the client shuts down cleanly. The moment a connection is **established**,
 * the same signal to the same pid does nothing at all: the process stays alive,
 * the event loop keeps turning (a timer beside this one went on firing), and
 * `process.listenerCount('SIGTERM')` still reads 1. Node believes it is
 * listening; the operating system is not delivering.
 *
 * Whatever replaces the disposition does it somewhere below Node — Chromium's
 * network or IO threads are the obvious suspects and neither is ours to change.
 * What *is* ours is that `process.on` makes libuv call `sigaction` again, and
 * whoever registers last wins: taking the listeners off and putting them back
 * takes the signal back.
 *
 * Keyed on a connection reaching `connected`, because that is exactly the
 * measured trigger. Idempotent and free — reconnecting simply does it again —
 * and it deliberately does **not** run on a timer: a client that could be
 * Ctrl-C'd only three seconds out of four would be worse than one that says it
 * cannot be.
 *
 * A client that cannot be ended from the terminal that launched it is not a
 * cosmetic fault. On this server family an unclean disconnect is penalised and
 * can kill (docs/greatermud/combat.md), and the fallback everyone reaches for
 * is `kill -9`, which is precisely the disconnect the whole shutdown path
 * exists to avoid.
 */
function keepSignalsWorking(): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const listeners = process.listeners(signal);
    if (listeners.length === 0) continue;
    process.removeAllListeners(signal);
    for (const listener of listeners) process.on(signal, listener as NodeJS.SignalsListener);
  }
}

/**
 * Ends the process — but not before what it just said has actually gone.
 *
 * `teardown()` runs to completion without returning to the event loop, and
 * `app.exit` is immediate, so exiting on the next line kills the process with
 * its own explanation still in the pipe. Writing to a pipe is asynchronous in
 * Node whenever the buffer is not already empty, which on a quiet run it is and
 * on a busy one it is not — so this looked fine every time it was tried by hand
 * and failed every time under a harness, where the client's whole shutdown
 * reason vanished and it read as an app that had ignored the signal.
 *
 * It matters past the harness: that line is the only thing that says *where* a
 * client stopped, and somebody pressing Ctrl-C in the terminal that launched it
 * is exactly the person who needs it.
 *
 * Bounded, because a pipe nobody is reading never drains and the one thing
 * worse than losing the message is not exiting at all.
 */
function exitOnceItHasBeenSaid(code = 0): void {
  const leave = (): void => platform.exit(code);
  if (process.stdout.writableLength === 0) return leave();
  const deadline = setTimeout(leave, tuning().app.exitDrainMs);
  deadline.unref?.();
  process.stdout.once('drain', () => {
    clearTimeout(deadline);
    leave();
  });
}
