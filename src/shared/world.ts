/**
 * The world knowledge base: rooms, exits, and what each exit demands of you.
 *
 * Addressed as `map/room` throughout, which is how the game itself refers to a
 * location (`Location: 1,297` in a profile) and how every exit in the realm
 * database is written.
 *
 * Dependency-free: the graph is built in the main process, routes are rendered
 * in the renderer.
 */
import type { Alignment } from './alignment';
import type { SpellElement } from './spellchoice';
import type { FightSummary } from './fights';
import type { MobLoreEntry } from './lore';
import type { ItemKind } from './items';
import type { AlignmentCost, MobDisposition } from './mobs';
import type { Verdict } from './verdict';
import type { RowPeace } from './mobRules';
import type { Denomination } from './character';

/** The ten directions the game uses. */
export type Direction = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'u' | 'd';

export const DIRECTIONS: readonly Direction[] = [
  'n',
  's',
  'e',
  'w',
  'ne',
  'nw',
  'se',
  'sw',
  'u',
  'd'
];

/**
 * A word read as one of the ten, or null.
 *
 * Parse rather than validate, the way `asRoute` does: an exit's `direction` is
 * a `string` because it also carries a text exit's own word (`crimson portal`),
 * so the places that need *a move they can send as one word* narrow it here
 * instead of casting.
 */
export function asDirection(input: string): Direction | null {
  const word = input.trim().toLowerCase();
  return (DIRECTIONS as readonly string[]).includes(word) ? (word as Direction) : null;
}

/** What the player types to go that way. */
export const DIRECTION_COMMAND: Record<Direction, string> = {
  n: 'n',
  s: 's',
  e: 'e',
  w: 'w',
  ne: 'ne',
  nw: 'nw',
  se: 'se',
  sw: 'sw',
  u: 'u',
  d: 'd'
};

/**
 * The way back through the same passage.
 *
 * A **total** record rather than a partial one, which is the point of moving it
 * here: it was written out by hand in nine places — once in `shared/map.ts` and
 * once in each of eight probes — and **four of the copies left out `u` and
 * `d`**, so a probe retracing a walk that went down pushed `undefined` into its
 * trail and then sent it. A map keyed by the direction union cannot be
 * incomplete without failing to compile, which is the only version of this that
 * stays right.
 */
export const OPPOSITE: Record<Direction, Direction> = {
  n: 's',
  s: 'n',
  e: 'w',
  w: 'e',
  ne: 'sw',
  sw: 'ne',
  nw: 'se',
  se: 'nw',
  u: 'd',
  d: 'u'
};

/**
 * A direction as the *server* words it, or null.
 *
 * `DIRECTION_NAME` is the other direction — what this client calls each code —
 * and it is not enough to read the server with, because the server has more
 * than one word for the same way. Every entry here is a word a capture shows:
 *
 * | Word | Where |
 * |---|---|
 * | `north` … `down` | everywhere; `parseExit`'s own list |
 * | `below`, `above` | `Obvious exits: north, open trap door below` — 20 lines across the corpus |
 * | `downwards` | `You found an exit downwards!` (`captures/005:187`) |
 *
 * `upwards` is the one entry no capture shows, and it is here deliberately: it
 * is the unmirrored half of a captured pair, a word that costs nothing if no
 * realm ever prints it, and whose absence leaves a hidden **up** exit searched
 * for forever by a walk that cannot tell it has been found. That is a different
 * trade from inventing a *pattern*, which would claim a sentence exists.
 */
const SPOKEN_DIRECTION: Readonly<Record<string, Direction>> = {
  north: 'n',
  south: 's',
  east: 'e',
  west: 'w',
  northeast: 'ne',
  northwest: 'nw',
  southeast: 'se',
  southwest: 'sw',
  up: 'u',
  down: 'd',
  above: 'u',
  below: 'd',
  upwards: 'u',
  downwards: 'd'
};

export function asSpokenDirection(input: string): Direction | null {
  const word = input.trim().toLowerCase();
  return SPOKEN_DIRECTION[word] ?? asDirection(word);
}

export const DIRECTION_NAME: Record<Direction, string> = {
  n: 'north',
  s: 'south',
  e: 'east',
  w: 'west',
  ne: 'northeast',
  nw: 'northwest',
  se: 'southeast',
  sw: 'southwest',
  u: 'up',
  d: 'down'
};

/**
 * What an exit demands.
 *
 * The kinds here are the ones that actually occur in the realm data — surveyed
 * rather than guessed. The legacy A* knew about seven; the database contains
 * these. An unrecognised instruction becomes `unknown`, which is treated as
 * passable-but-suspect rather than silently dropped: an exit we do not
 * understand is still an exit, and pruning it strands routes.
 */
export const REQUIREMENT_KINDS = [
  'door',
  'key',
  'level',
  'toll',
  'text',
  'item',
  'class',
  'race',
  'alignment',
  'ability',
  'cast',
  'spell',
  'trap',
  'hidden',
  'timed',
  'unknown'
] as const;

/**
 * The kinds, as a type.
 *
 * Derived from the list rather than declared beside it, for the reason
 * `ROUTE_BLOCK_KINDS` gives: a closed union has two halves and they move
 * together. `WorldGraph.test.ts` walks this list and asserts `edgePenalty` and
 * `edgeBlock` agree about every one of them, so a kind added here and priced
 * nowhere is a failing test rather than a corridor nobody can explain.
 */
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

/**
 * Where a teleport puts the character, as the realm's own spell table states it.
 *
 * `Spell.cs`'s `TeleportRoom` case, transcribed: the ability's modifier is the
 * room, and **a modifier of zero means the spell's rolled value is the room**
 * (`tempTeleportRoomID = inMainValue`), which `RollAndApplySpellAbilities`
 * draws uniformly from `MinBase`–`MaxBase`. `TeleportMap` is the map, and
 * where the spell states none the server uses the one the character is
 * standing on — which for an exit's cast is the map the exit table names,
 * because `TryMoveThroughExit` moves first and casts second.
 *
 * So one range covers both shapes and the difference is whether it is a range:
 * `low === high` is a portal with an address, and anything wider is a draw.
 * Nothing here is a guess — every field is a column.
 */
export interface Landing {
  /** The spell that does it, and the name to say in a sentence. */
  spell: number;
  name: string;
  /** The map it lands you on. */
  map: number;
  /** The lowest and highest room the roll can produce; equal for a portal. */
  low: number;
  high: number;
}

/** Whether a landing is a draw rather than an address. */
export function scatters(landing: Landing): boolean {
  return landing.high > landing.low;
}

/** Whether two readings of a chain's teleport are the same answer. */
export function sameLanding(a: Landing, b: Landing): boolean {
  return a.map === b.map && a.low === b.low && a.high === b.high;
}

/**
 * Every room the roll can name, in the realm's own numbering.
 *
 * The range as stated, **not** filtered against any realm: this file holds no
 * realm and inventing one here would make the answer depend on which world is
 * loaded. A caller with the data drops the numbers it has no room for — which
 * `Router.scatterDoors` does, because the mean it takes has to be over
 * outcomes that exist, and `resolveRoom` does, because a room the file lacks
 * cannot be the one the server just described.
 */
export function landingRooms(landing: Landing): RoomId[] {
  const rooms: RoomId[] = [];
  for (let number = landing.low; number <= landing.high; number += 1) {
    rooms.push(roomId(landing.map, number));
  }
  return rooms;
}

export interface Requirement {
  kind: RequirementKind;
  /** The instruction verbatim, for display and for anything not yet modelled. */
  raw: string;
  /**
   * Commands that traverse this exit instead of the bare direction.
   * `Text: go crimson, enter crimson` yields both, first one preferred.
   */
  commands?: string[];
  /**
   * The item this exit demands, as an `Items` row id.
   *
   * Two instructions state one, and they are the same fact from the router's
   * point of view — *is this thing in the pack*: `Key: 1124` (a lock, which a
   * picklock may also open) and `Item: 191` (`rope and grapple`, on 157 of the
   * shipped realm's exits).
   *
   * **The `Item:` branch drops a zero and the `Key:` branch does not**, which
   * is not an oversight. The server builds a plain exit for `Item: 0`
   * (`RoomManager.LoadRooms` case 3, a reading of the source), so keeping it
   * would read as *item zero required* and shut the exit against everybody —
   * the `Level: 37 to 0` lesson in a third column. `Key: 0` occurs in neither
   * database on this machine, and dropping it would change nothing anyway: a
   * `Key:` with no id is a lock the realm did not name, which is already
   * priced as a lock rather than as an open door. Inventing behaviour for a
   * shape no realm has is the guess this file exists to refuse.
   */
  keyId?: number;
  /** `[or 301 picklocks/strength]` — the picklocks that substitute for the key. */
  pickDifficulty?: number;
  /**
   * What **strength** has to reach to force the same barrier, when the realm
   * says strength will do at all.
   *
   * The bracket comes in two shapes and they are not the same fact:
   * `[301 picklocks/strength]` takes either skill, and `[or 157 picklocks]`
   * takes only the lock-pick — 89 exits in the shipped realm are the second
   * kind, and every one of them was read as *no skill substitutes* until this
   * was parsed. So the number is carried twice rather than once, and a
   * strength check on a picklocks-only lock finds nothing to check against.
   *
   * `0` means the realm wrote `any`, which is what it writes for a barrier
   * that yields to whoever leans on it.
   */
  bashDifficulty?: number;
  /** `Level: 10 to 999`. */
  minLevel?: number;
  maxLevel?: number;
  /**
   * `Toll: 5` — what a toll gate charges, **in copper**, converted on the way in.
   *
   * The realm database writes a bare number with no unit (58 exits across the
   * shipped realm: 5, 5000, 10000, 80000). The unit is *gold*, which is not a
   * guess: the same gate that records `Toll: 5` answered `You do not have
   * enough to cover the toll of 5 gold crowns.` on the wire, against a purse
   * the listing beside it gave as `0 copper farthings` (player session log,
   * 2026-08-30). So this is stored multiplied by `COPPER_PER.gold`, because
   * `Traveller.wealth` is a copper total and a router comparing 5 against 500
   * would wave a broke character through a gate it cannot pay.
   */
  tollCopper?: number;
  /**
   * `Class: 3 OK, 0 NO` — the one class the realm lets through this exit, and
   * the one it turns away, as `Classes` row ids. **0 means nobody**.
   *
   * `classOk` is an allow-list of one, not a hint: the shipped realm's crypt
   * is fifteen identical `Crypt, Shadowed Hall` rooms whose east exits carry
   * ids 1 through 15, one class each, and a Paladin sent through the one
   * reading `Class: 6 OK` is answered `You may not go through this exit!` on
   * the wire (todo 03, 2026-09-06). All 54 class-gated exits in the realm are
   * this one shape, surveyed rather than remembered.
   *
   * An id no `Classes` row has names nobody — one exit reads `1984 NO` against
   * a table of fifteen — and is left to `WorldGraph.classId` to fail to match,
   * which is the same answer by a shorter road.
   */
  classOk?: number;
  classNo?: number;
  /**
   * `Race: 13 OK, 0 NO` — the same allow/deny pair as the class gate, one row
   * further down the server's own switch (`RoomManager.LoadRooms` case 14 is
   * case 13 with `Races` in place of `Classes`).
   *
   * Two exits in each of the two realm databases on this machine, both reading
   * `Race: 13 OK, 0 NO`, surveyed rather than remembered. `0` is dropped for
   * the reason `classNo` is.
   */
  raceOk?: number;
  raceNo?: number;
  /**
   * `Alignment: Saint to Seedy` — the window of standing the exit admits.
   *
   * The realm writes **words** where the server holds *evil points*:
   * `AlignmentExit` compares `Player.EvilPoints` against two ints, and the
   * bands those ints fall in are what the editor rendered here. So comparing
   * bands is exact rather than approximate — a gate can only be written as a
   * word if its number sat on a band, and `EvilPointLevels` puts Seedy's
   * ceiling at 39.99 with Outlaw beginning immediately above it. The scale
   * itself is `src/shared/alignment.ts`.
   *
   * A word neither the realm nor the roster names leaves both ends absent —
   * an unreadable gate, not an open one. Fourteen exits in each database, four
   * distinct windows, every endpoint one of `Saint`, `Neutral`, `Outlaw`,
   * `Seedy`, `Fiend` — note the spelling, which is why the lookup is
   * case-insensitive.
   */
  minAlignment?: Alignment;
  maxAlignment?: Alignment;
  /**
   * `Ability: 152 w/value 1 to 1` — an `Abilities` id and the window its
   * **sum** on the character has to fall in (`AbilityExit`, which reads
   * `GetAbility(id).Sum`).
   *
   * Nine exits in the shipped realm, eight distinct, and the ids are
   * `DaoLordQuest` (134), `Rune` (152), `Mandos Quest` (200) and
   * `GuildmasterQuest` (204) — quest counters the wire states nowhere.
   *
   * The id alone, so the realm's empty slot can be told from a real gate: `0`
   * means no gate, the server builds a plain exit for it (case 23), and that
   * exit costs nothing. **The window is on `abilities`**, as the one
   * `AbilityGate` this exit states — the field that had no reader when this
   * gate was first parsed, and has had one since `abil` began stating the
   * counters.
   */
  abilityId?: number;
  /**
   * `Cast: pre-0, post-1257` — the spells the realm fires at whoever walks
   * this exit, before the step and after it. `0` is *no spell* and is dropped.
   *
   * **A cast exit never refuses anybody** — `CastExit.CanMoveThroughExit`
   * returns `true` unconditionally, and `TryMoveThroughExit` moves the
   * character first and casts second (a reading of the server's source). What
   * makes it worth pricing is the other half: 217 of the shipped realm's 293
   * cast exits fire a *teleport*, so the room the exit table names is not the
   * room the character is standing in a moment later. See `spellEffect`.
   */
  castPre?: number;
  castPost?: number;
  /**
   * `Spell Trap: 905` — the spell a trapped exit fires at whoever walks it.
   *
   * `SpellTrapExit.CanMoveThroughExit` also returns `true` unconditionally: it
   * is a trap, not a gate, and the whole of its cost is what the spell does.
   * 21 of the shipped realm's 22 are `poison darts`.
   */
  spellId?: number;
  /**
   * What the realm's own spell table says the spells on a `cast` or `spell`
   * exit do to the character, resolved **once at load** and never in the A*.
   *
   * `edgePenalty` runs once per exit per expansion over 55,806 rooms; walking
   * a spell's ability rows in there would put a table lookup inside the hot
   * loop for a fact that cannot change after the file is read. So
   * `WorldGraph.resolveSpells` answers it while the room is being built, the
   * way `buildRealm` joins the levers.
   *
   * - `teleports` — a spell carries `TeleportRoom`/`TeleportMap` and the roll
   *   it makes has one outcome, so the character ends up in **one known
   *   room** the exit table does not name. `landing` holds it and the router
   *   walks the edge there. 49 exits in each shipped realm: the Marble Rooms'
   *   wrong squares, which put you back in the Grand Hallway.
   * - `scatters` — the same abilities, but the roll spans a range, so the
   *   character ends up in one of several rooms and nobody can say which.
   *   `landing` holds the range. 168 exits in each shipped realm.
   * - `script` — a spell hands the character a `TextBlock`, which is a realm
   *   script this client does not convert. It may do anything, including move
   *   them; 40 of the 56 are called `pyramid 4 arch fail`.
   * - `plain` — every ability the spell carries is an effect on the
   *   character rather than on where it is standing, so the exit is a
   *   corridor with something cast at whoever uses it.
   */
  spellEffect?: 'teleports' | 'scatters' | 'script' | 'plain';
  /**
   * Where that teleport actually puts the character, read off the realm's own
   * spell table at load. Present exactly for `teleports` and `scatters`.
   */
  landing?: Landing;
  /**
   * `Trap, 30 damage` — and what a spell trap is expected to cost, in the same
   * units, resolved from the realm's own spell table at load.
   *
   * One field because it is one fact — *how much this exit hurts* — and two
   * would let the price and the chip disagree about which to read. A spell
   * trap whose spell states no hurt this client can read leaves it absent,
   * which is the trap floor and not a claim that the trap is harmless.
   */
  damage?: number;
  /** `Hidden/Searchable` — must be searched for before it can be used. */
  searchable?: boolean;
  /**
   * `Hidden/Needs 2 Actions` — how many levers the realm says open it.
   *
   * Kept beside `actions` rather than derived from it, because the two can
   * disagree: 28 of the shipped realm's 217 action-gated exits state a count
   * the data has no matching number of levers for (one says 1,278). A mismatch
   * is what makes `actions` absent — sending the levers that were found would
   * be a command spent on a passage that stays shut.
   */
  actionsNeeded?: number;
  /** `specific order` rather than `any order`. */
  actionsOrdered?: boolean;
  /**
   * The levers that open it, in the realm's own order.
   *
   * Present when the realm's stated count matches the number of levers found —
   * **189 of the shipped realm's 217 gated exits**, 39 of which have at least
   * one lever in another room and carry it as `at`. Absent where the counts
   * disagree, which is the realm contradicting itself and no basis for sending
   * anything.
   *
   * **`openableHere` is the gate, not this field.** A list with an `at` on any
   * member is a lever the character has to walk to, which the *router* still
   * does not plan; it is here so the client can say where it is. Everything
   * priced or sent in place — `edgePenalty`, the chip, `Levers.pullLevers` —
   * asks `openableHere` first, and 150 exits answer yes. See `parseAction` for
   * where the data was hiding.
   *
   * Walking to a lever elsewhere is `RemoteLever` and `Levers.fetchLever`,
   * which read the *rooms'* own commands rather than this field — and have to,
   * because 25 of the 225 gated exits state no action at all.
   */
  actions?: RequirementAction[];
  /**
   * Conditions the realm states on this edge that this client cannot evaluate,
   * in the realm's own words — `nomonsters`, `roomitem shimmering key`,
   * `testskill perception 20`.
   *
   * A room script states *several* conditions on one phrase and `kind` holds
   * one, so the guards that have a kind are read into the fields beside this
   * (`minLevel`, `maxLevel`) and the rest are kept here whole. They are priced
   * rather than obeyed: `edgePenalty` adds the unevaluable figure once on top
   * of whatever else the edge costs, so a scripted way through is offered,
   * never preferred, and the chip carries the instruction for a person to
   * judge by.
   *
   * **Set only by `linkPortals`**, because a room script is the only place in
   * the realm where one edge carries conditions of several kinds. Absent is an
   * edge whose every condition is read, which is every exit out of the
   * direction columns.
   */
  unread?: readonly string[];
  /**
   * Every ability comparison this edge makes, read into the form the server
   * compares in — whichever of the realm's two shapes wrote it.
   *
   * A room script writes `checkability 133 5` among its `unread` conditions,
   * and the exit table writes `Ability: 204 w/value 1 to 999` in the direction
   * column itself. They are one subject: the server makes the same comparison
   * against `Player.GetAbility(id).Sum` for both, so they are read into one
   * field and answered in one place, and the two cannot drift into agreeing
   * differently about the same character.
   *
   * For a script these are the subset of `unread` the *client* can answer, and
   * they are kept beside those rather than taken out of them: `checkability
   * 133 5` is still worth showing whether or not this character passes it.
   *
   * **Read, not obeyed, until the counters arrive.** `edgePenalty` refuses an
   * edge whose gate this character fails and prices one nobody has the
   * counters for exactly as before — an unread listing is *nobody has said*,
   * which is never the reassuring answer and never the alarming one either.
   */
  abilities?: readonly AbilityGate[];
  /**
   * A timed passage this way in opens — resolved at load (`WorldGraph
   * .linkPortals`, todo 104), never written to the file. The room command's
   * own `cast` puts a spell on the character that ends in harm, and the
   * rooms it lands in are under it until an exit whose cast kills it. See
   * {@link Corridor}.
   */
  corridor?: Corridor;
  /**
   * Who may **use** the item this edge spends — an item-landing edge's own
   * gate (`WorldGraph.itemLandings`, `linkItemLandings`), read off the
   * item's `classes`, `races` and `minLevel`.
   *
   * The pack says whether the token is *held*; this says whether the server
   * will let it be *used*, which is a different question with a different
   * answer: `use token of Silvermere` at level 21 was answered *You are not
   * experienced enough to make that trip!* (2026-09-21), and the level was in
   * the item row all along (`MinLevel`, ability 135). Priced by `edgePenalty`
   * through `equipBlock`, the one rule for who may use a thing, so the card
   * and the router cannot disagree about it.
   */
  usableBy?: ItemUseGate;
}

/**
 * The realm's gate on who may use an item, as `WorldItem` states it — an
 * allow-list of classes and races, and a level. Every field absent is a thing
 * anybody may use.
 */
export interface ItemUseGate {
  classes?: readonly number[];
  races?: readonly number[];
  minLevel?: number;
}

/**
 * One ability gate an edge states, as the server compares it.
 *
 * A scripted way through writes it with one of three verbs; the exit table
 * writes it as a window (`Ability: 204 w/value 1 to 999`, `AbilityExit`
 * reading `GetAbility(id).Sum` between two ints), which is `atLeast` and
 * `atMost` already and needs no fourth spelling.
 *
 * The three verbs are one subject and three comparisons against
 * `Player.GetAbility(id).Sum` (`TextBlockPart.Execute`, transcribed in
 * `main/world/questScript.ts`): `checkability N [V]` is `>= V` with V
 * defaulting to −1, `testability N V` is `<= V`, and the pair together is
 * *exactly V* — which is how every chained quest in both databases is written.
 * `failability N` is its own kind: not held at all.
 *
 * Kept as bounds rather than as the verbs, because what a reader asks is
 * whether a number is inside them.
 */
export interface AbilityGate {
  /** The realm's own ability id — a quest counter, in every case seen. */
  id: number;
  atLeast?: number;
  atMost?: number;
  /** `failability`: the sum must be nothing at all. */
  absent?: boolean;
}

/**
 * The ability verbs, and how many words of the step each takes.
 *
 * `CONDITION_WORDS` states the same figures for the same reason — a trailing
 * message id is only trailing on a verb that takes one argument.
 */
const ABILITY_VERBS: ReadonlySet<string> = new Set([
  'checkability',
  'checkabilityexact',
  'testability',
  'failability'
]);

/**
 * The ability gates one room-script condition states, or nothing.
 *
 * Read at load rather than at build (`WorldGraph.linkPortals`), because the
 * strings are already in the file: a realm somebody converted before this
 * existed answers these gates the moment they open the client, with no format
 * bump and no rebuild.
 */
export function readAbilityGate(condition: string): AbilityGate | null {
  const parts = condition.trim().split(/\s+/);
  const verb = (parts[0] ?? '').toLowerCase();
  if (!ABILITY_VERBS.has(verb)) return null;
  const id = Number(parts[1]);
  if (!Number.isInteger(id)) return null;
  if (verb === 'failability') return { id, absent: true };
  const value = Number(parts[2]);
  if (verb === 'checkability') {
    // One argument is *has it at all*, which the server spells as `>= -1`.
    return { id, atLeast: Number.isInteger(value) ? value : -1 };
  }
  if (!Number.isInteger(value)) return null;
  return verb === 'testability' ? { id, atMost: value } : { id, atLeast: value, atMost: value };
}

/**
 * Whether the counters `abil` stated satisfy these gates — or null for nobody
 * having said.
 *
 * `countersMet`'s reading, one subject across: a **complete** listing
 * enumerates, so an id it does not name is zero; an incomplete one settles
 * nothing about an id it is silent on, and the answer is *unknown* rather than
 * the zero. Before any listing there is no answer at all, which is not the
 * same as the gate passing — an edge nobody has the counters for is priced as
 * the guess it is, never refused and never preferred.
 */
export function abilityGatesMet(
  gates: readonly AbilityGate[] | undefined,
  counters: { sums: Readonly<Record<number, number>>; complete: boolean } | null | undefined
): boolean | null {
  if (gates === undefined || gates.length === 0) return null;
  if (counters === null || counters === undefined) return null;
  let known = false;
  for (const gate of gates) {
    const stated = counters.sums[gate.id];
    if (stated === undefined && !counters.complete) continue;
    known = true;
    const held = stated ?? 0;
    if (gate.absent === true) {
      if (held !== 0) return false;
      continue;
    }
    if (gate.atLeast !== undefined && held < gate.atLeast) return false;
    if (gate.atMost !== undefined && held > gate.atMost) return false;
  }
  return known ? true : null;
}

/**
 * One lever an exit needs pulled, resolved.
 *
 * `say` is every phrase the realm accepts and its own spelling is first, the
 * shape `Requirement.commands` already keeps for a `Text:` exit — and for the
 * same reason: the client sends one of these, so the list is what it may send
 * and the order is the realm's preference, not the client's guess.
 */
export interface RequirementAction {
  say: string[];
  /**
   * The item the realm says must be carried to say it — `lift up talisman
   * (Item: 815)` in the realm's own cell, read off the phrase list by
   * `parseAction`. The server checks the pack before the action fires and
   * answers `You don't have <item> to use!` without it (`ExitAction.Perform`),
   * spending one of the item's uses when it does. Absent is an action that
   * needs nothing carried.
   */
  item?: number;
  /**
   * Where it is pulled, when that is not the room the exit leaves from.
   *
   * Absent is *here*, which is what makes the exit openable in place. Present
   * is a detour the router does not plan — but it is what lets the client say
   * *the lever for this is in Guardroom 1/1339* instead of writing the
   * corridor off, which is the reported complaint.
   */
  at?: { map: number; room: number };
}

/**
 * Whether a hidden exit's levers can all be pulled without leaving the room.
 *
 * One reading, shared by the price (`edgePenalty`), the chip
 * (`describeObstacle`) and the walker's own rung (`pullLevers`), because three
 * copies of *can this be opened from here* agree exactly until one is edited —
 * the lesson `AutoCombat.quarry` already records.
 *
 * The second half of the test and not the whole of it: `buildRealm` writes
 * `actions` only where the realm's stated count matches the number of levers
 * found, so a passage whose data disagrees with itself never reaches here.
 */
export function openableHere(requirement: Requirement | null): boolean {
  if (requirement?.kind !== 'hidden') return false;
  const acts = requirement.actions;
  return acts !== undefined && acts.length > 0 && acts.every((act) => act.at === undefined);
}

/**
 * Something standing between two rooms, said in words a player can act on.
 *
 * Composed where the realm data lives (`src/main/world/obstacle.ts`), because
 * naming a key means looking it up — `Key: 1124` is not something anybody can
 * do anything with, and *angular key, dropped by a gate guard* is.
 *
 * **Three lengths, because three surfaces have three amounts of room**, and one
 * function composes all three so a door on the map and the same door on a route
 * cannot say different things:
 *
 * - `kind` is the bare word, for a `data-kind` attribute or a glyph.
 * - `label` is a chip: the kind *and the number that goes with it*. `toll` on
 *   its own is what a route step used to say, which tells somebody there is a
 *   price and not what it is — the same complaint `describeBlock` already
 *   answers for a route that was refused outright.
 * - `detail` is the full line, for a tooltip, with the key's name and where it
 *   is found.
 *
 * `raw` is the realm's own words, kept for anything not modelled.
 *
 * Lives here rather than in `map.ts` because it is a statement about a
 * `Requirement`, and because `map.ts` already imports this file: the other
 * direction would be a cycle, and this project has one of those written down.
 */
export interface MapObstacle {
  kind: RequirementKind;
  /** The kind and its number, short enough for a chip. */
  label: string;
  /** One readable line: what it is, and what would get you through. */
  detail: string;
  raw: string;
}

/**
 * An item some exit requires, named — and where one might be had.
 *
 * `Key: 1124` tells nobody anything; "angular key" is the thing a player goes
 * looking for. Provenance is best-effort and frequently absent: about half of
 * these are dropped by a monster, a handful are sold, and the rest are simply
 * not answerable from the realm database. Saying nothing is better than
 * guessing, so an entry with neither list means "not known from here".
 */
export interface WorldItem {
  id: number;
  name: string;
  /** Shops known to stock it. Capped — a lead, not an inventory. */
  shops?: string[];
  /** Monsters known to drop it. */
  mobs?: string[];
  /**
   * Where one of the realm's own scripts hands it over — format 39.
   *
   * The third answer to *where does this come from*, and the only one that is
   * not a column: a realm hands its quest components over in a text block.
   * Capped like the other two. See `ItemHandover`.
   */
  from?: ItemHandover[];
  /**
   * Where **using one** puts the character, as `map/room` — format 40.
   *
   * An item can be a door. The potion of levitation casts a spell whose text
   * block is `teleport 1009 9`, and that is the only entrance the Catacombs
   * have — the exit table says nothing about it, so a client reading only
   * corridors calls half the map unreachable. Derived at build time, because
   * the chain runs through `TBInfo`, which does not ship (`landingsOfItems`).
   * Read by `WorldGraph.approachItems`, which treats a landing inside an
   * enclosed region as a way into it.
   */
  lands?: RoomId;
  /**
   * The rooms using it actually works in — format 41.
   *
   * **A teleport is not an *anywhere*, and reading one as though it were is
   * what made format 40 wrong.** The potion of levitation's block opens
   * `roomitem 993`, which `TextBlockPart.cs` answers by failing the whole
   * block when the room lacks item 993 — the `waterfall`, which stands in
   * `3/1` and nowhere else. Used in the Alchemist's Hut the server does
   * precisely nothing, which is what a failed block looks like from outside.
   *
   * Absent means the chain carries no place-binding guard and it works
   * wherever you stand: Paradigm's seven recall tokens, whose guards are about
   * the moment (`nomonsters`, `failroomitem`) and not the place. Never empty —
   * a guard the realm places nowhere withholds `lands` as well, because a way
   * the converter cannot describe is not one to offer.
   */
  usableIn?: RoomId[];
  /**
   * The rooms the realm puts one in — `Rooms.Placed`, format 42.
   *
   * The fourth answer to *where does this come from*, and the only one that
   * is a place rather than an act: put back at the nightly cleanup where it is
   * missing, **within the item's game limit** (`RoomManager.DoCleanup`) — so an
   * empty floor means somebody took it since, or as many as the realm allows
   * are out. Joined at the lookup from the rooms' own column, over every row
   * the name holds (`WorldGraph.itemPlaces`).
   */
  placed?: ItemPlaces;
  /** What the realm charges, before a shop's markup. Absent when it says none. */
  price?: number;
  /**
   * The coin `price` is counted in (`Items.Currency`, realm format 47). Absent
   * on an older file, where the price is a number in no known unit.
   */
  currency?: Denomination;
  /** What it weighs, in the units the status line counts encumbrance in. */
  encumbrance?: number;
  /**
   * What kind of thing it is, from `Items.ItemType` (`shared/items.ts`).
   *
   * Absent on a realm file built before v6, and for a value the sample never
   * showed — every consumer already answers "the realm does not say".
   */
  kind?: ItemKind;
  /**
   * Where it is worn or held, as a word read off the realm's `Worn` code by
   * `shared/items.ts` — the Reference card's answer. Absent for a thing that is
   * not worn.
   */
  slot?: string;
  /**
   * The realm's `Worn` code itself, kept so that a listing which names this
   * item and its slot can teach what the server prints for the code
   * (`shared/lore.ts`, `SlotLoreEntry`). Absent when the realm records none.
   */
  worn?: number;
  /** Only for a weapon: the numbers that decide whether to swing it. */
  weapon?: {
    min: number;
    max: number;
    /** Round time in the server's units; lower is faster. Absent when zero. */
    speed?: number;
    /** Strength needed to wield it. */
    strength?: number;
    /** Accuracy bonus. Absent when zero. */
    accuracy?: number;
    /** What skill it is swung with, as a word (`shared/items.ts`). */
    type?: string;
    /**
     * How many hands it takes.
     *
     * Its own field rather than a word inside `type`, because it is the half of
     * `Items.WeaponType` a reader acts on: a two-handed weapon leaves no
     * off-hand slot. The column names two axes at once and the old reading
     * named them as one — see `WEAPON_CLASS`.
     */
    hands?: 1 | 2;
  };
  /** Only for armour: what it stops. */
  armour?: {
    /** Armour class. Absent when zero. */
    ac?: number;
    /** Damage resistance. Absent when zero. */
    dr?: number;
    /** What it is made of, as a word (`shared/items.ts`). */
    material?: string;
  };
  /** How many times it can be used before it is gone: scrolls, potions, food. */
  uses?: number;
  /**
   * What it does, from `Items.Abil-n` / `AbilVal-n` — format 12.
   *
   * The realm's own `[id, value]` pairs, in slot order and undecoded.
   * `src/shared/abilities.ts` names them; keeping the numbers here rather than
   * the words is deliberate — the naming comes from another client's source and
   * may be corrected, and the file on disk should carry what the realm said.
   */
  abilities?: Array<[number, number]>;
  /**
   * Which classes may use it, from `Items.ClassRest-0..9` — format 15.
   *
   * Row ids in `Classes`, and an **allow-list**: a non-empty list is the realm
   * naming the only classes that may wear the thing, so a class absent from it
   * is refused. Measured 2026-08-31 against `gmud20230902`: `golden battleaxe`
   * names `Warrior` alone, `obsidian runestaff` names `Mage` alone, and
   * `silver holy amulet` names Paladin, Cleric, Priest and Missionary — which
   * is why a Mystic wearing it earned `You may not wear that item!`.
   *
   * **Not the same column as `ClassOk`** (ability 59), which is also carried,
   * in `abilities`. 292 items state only this, 93 state only that, and where
   * both appear they disagree — `thunderstaff` restricts to 5, 12, 13, 15 and
   * its `ClassOk` names 5, 12, 15. Two questions the realm asks separately, so
   * the client keeps them separate rather than unioning two things it has not
   * proved are one: a wrong union greys out an item the character can wear,
   * and that is the failure this whole field exists to stop.
   *
   * Absent when the realm restricts nothing, which is 2,324 of its 2,639 items.
   */
  classes?: number[];
  /**
   * Which races may use it, from `Items.RaceRest-0..9` — format 15.
   *
   * Row ids in `Races`, an allow-list exactly as `classes` is. One item in
   * `gmud20230902` states it at all (`Caladbolg`, Elf), which is reason to
   * carry it and no reason to leave it out: a derivative realm is free to use
   * the column, and the cost of reading it is one array.
   */
  races?: number[];
  /**
   * The level the realm requires, from the `MinLevel` effect (ability 135).
   *
   * Lifted out of `abilities` into a field of its own because it is a *gate*
   * rather than an effect: 953 items carry it, and the question "may this
   * character wear this" must not depend on every caller re-scanning an
   * untyped pair list for one id. The pair stays in `abilities` too — that
   * array is what the realm said, and the Reference card draws it from there.
   */
  minLevel?: number;
  /**
   * `Items.Gettable` — **false is the realm refusing to let it be picked up**.
   * Format 18.
   *
   * Absent is gettable, and deliberately: the file records only the refusal
   * (45 of 2,639 items), and a derivative realm without the column must not
   * have its looting silently switched off by the client's own ignorance.
   */
  gettable?: boolean;
  /** `Items.Not Droppable`. Absent is droppable, on the same rule. */
  notDroppable?: boolean;
  /** `Items.Limit` — how many may exist in the realm at once. */
  limit?: number;
}

/** One line of a shop's stock, named rather than numbered. */
export interface WorldShopItem {
  id: number;
  name: string;
  price?: number;
  encumbrance?: number;
}

/**
 * A shop, and what the realm says it stocks.
 *
 * A shop is a property of a room and the realm data records which shop a room
 * holds, so standing in one is enough to know what it sells. That is the point:
 * the alternative is spending a command on `list`, and commands are the scarce
 * resource (docs/greatermud/rooms-and-items.md).
 *
 * **What the realm says, not what is on the shelf.** Stock rotates, a shop can
 * be sold out, and a derivative may have edited the table since. It is a lead
 * good enough to plan a walk on, and the shop itself is the authority.
 */
export interface WorldShop {
  id: number;
  name: string;
  items: WorldShopItem[];
  /** Percentage added to the base price, when the realm states one. */
  markup?: number;
  /**
   * What kind of place it is. A bank and a temple are shops to the realm —
   * the same table — and not to a person, who wants a different glyph beside
   * each. Absent on a realm built before v7 and for a type the sample did
   * not name.
   */
  kind?: ShopKind;
  /**
   * `Shops.MinLVL` — the lowest level this place serves. Format 35.
   *
   * A training room's band, and the server enforces it at **`MinLVL - 1`**
   * (`TrainCommand.cs:33`): a level 20 character may train at a 21–50 trainer,
   * because training is what makes it 21. Read through `trainsLevel`, which is
   * the one place that off-by-one is written down.
   */
  minLevel?: number;
  /** `Shops.MaxLVL` — the first level it no longer serves. Format 35. */
  maxLevel?: number;
  /**
   * `Shops.ClassRest` — the one class id the place is restricted to. Format 35.
   *
   * Absent means anybody, which is the usual case: of Paradigm's 46 trainers,
   * the restricted ones are the low-level class rooms and two Bard trainers.
   */
  classOnly?: number;
}

export type ShopKind = 'shop' | 'temple' | 'tavern' | 'bank' | 'trainer' | 'inn';

/**
 * A trainer this character may use, and where it stands — the answer the
 * settings screen's picker and the levelling errand both read (todo 18).
 *
 * Only places the realm says will take this character at this level: a
 * trainer that refuses is a walk across two maps to be told so, and offering
 * one is offering a choice that cannot work.
 */
/**
 * A bank counter the realm places, for the settings picker (todo 00).
 *
 * The shape `TrainerChoice` has, minus the arithmetic: a bank charges nothing
 * and takes every character, so the row and where it is are the whole answer.
 * Keyed by the shop's own row for `trainersTaking`'s reason — two rows can
 * share a name and be different counters, and a balance is per row.
 */
export interface BankChoice {
  /** The shop's own row, which is what the setting stores. */
  shop: number;
  name: string;
  map: number;
  room: number;
  roomName: string;
}

/**
 * A vault to draw cash from on the way to a counter — `WorldGraph.cashPlaces`,
 * ranked by the detour as `BuyingPlace` is.
 */
export interface CashPlace extends BankChoice {
  /** What the character's own record says is on deposit there, in copper. */
  copper: number;
  /** What stopping here adds to the way to the counter, in plain steps. */
  detour: number;
  moves: number;
}

export interface TrainerChoice {
  /** The shop's own row, which is what the setting stores. */
  shop: number;
  name: string;
  map: number;
  room: number;
  roomName: string;
  /** What one level costs here, in copper, at the level asked about. */
  cost: number;
  /** The band, for a picker that says why this one and not the class room. */
  minLevel: number | null;
  maxLevel: number | null;
}

/**
 * One place a script hands an item over, and what a player does to make it.
 *
 * The realm states three ways and they are three different acts, which is why
 * this is a tagged union rather than a name that might be blank: `asked` is a
 * word said to a monster, `said` is a word said in a room, and `killed` is a
 * monster's death spell running its text block over the corpse. Read off
 * `BuiltItemFrom` (the converter's `npc`/`room`/`death`) into the reader's own
 * words, because what the card needs to say is the *act*.
 *
 * `room` is the address the realm places the owner at and `place` its name,
 * joined in main from the room index the way `QuestStep.place` is — so an item
 * is one click from the monster's card and one from the walk.
 *
 * Absence is ordinary: three of the four Phoenix sundries name a monster whose
 * `Summoned By` places it, and a monster the realm summons from a spell or a
 * text block has no room to state.
 */
export type ItemHandover = {
  kind: 'asked' | 'said' | 'killed';
  /** The monster, for `asked` and `killed`. */
  who?: string;
  /** Where, as `map/room`. */
  room?: string;
  /** That room's own name, joined in main. */
  place?: string;
  /** The words that reach it. A death has none: nothing is said. */
  say?: string[];
  /**
   * What the way to that room demands be carried, outermost frontier first.
   *
   * Joined by the **quest book** alone (`QuestPlanner.joinStep`), which is the
   * one reader: the Reference card's `Given by` row is a lead and this is an
   * errand list, and a sweep per handover on every lookup would be paid for by
   * nobody. Absent where the realm leaves the place open, and where no room is
   * named to ask about.
   */
  approach?: ApproachGate[];
};

/**
 * One item the way somewhere demands, and where the realm says to get it.
 *
 * The same three answers `QuestSource` carries, one level down and no further:
 * *the golden egg is off the necromancer in the Amethyst Cave, and the way
 * into the Amethyst Cave wants a magical quartz rod, which Morukai hands over
 * for `ask Morukai return`.* Recursing again would be a walkthrough written
 * out of guesses about which of several ways somebody will take.
 */
export interface ApproachItem {
  id: number;
  name: string;
  /** Shops known to stock it, by name. */
  shops?: string[];
  /** Monsters known to drop it, by name. */
  mobs?: string[];
  /** Where one of the realm's own scripts hands it over. See `QuestSource.from`. */
  from?: ItemHandover[];
}

/**
 * One frontier on the way somewhere: **any one** of these items gets through.
 *
 * `anyOf` and not a bare item, because a realm may write two doors into one
 * place. Naming one of them would send somebody for the wrong errand, and
 * unioning them into one list would say both are needed — the *step's routes*
 * lesson in a second place. **Neither shipped world holds one**: the pairs
 * that looked like alternatives turn out to open onto different places, which
 * is what the flood in `approachItems` is for and a frontier count could not
 * see. It is carried because the shape is real, cheap and derived rather than
 * assumed; `WorldGraph.test.ts` holds it against a realm written for it.
 *
 * Several of these in a row **are** a conjunction: every one has to be crossed,
 * in the order given, which is the order they are fetched in. See
 * `WorldGraph.approachItems` for how the realm is asked, and
 * `tuning.world.approachRooms` for when it refuses to answer.
 */
export interface ApproachGate {
  anyOf: ApproachItem[];
}

/**
 * Where a shop an item is *sold by* actually is.
 *
 * `WorldItem.shops` is a list of shop **names** — enough to read and not enough
 * to walk to, because a shop is a property of a *room* and the item index
 * carries no room. This is that join, made once per lookup rather than once per
 * click, so a name in `Sold by` can be the control it looks like it should be.
 *
 * A closed union rather than a room and a count beside each other: a shop in
 * four places has no room to state, and a shape that could carry one anyway is
 * a shape where the card can draw a button that walks somewhere arbitrary.
 * Measured against the shipped realm 2026-09-03 — 231 shop names are placed,
 * **216 in exactly one room** and 15 in between two and fourteen (`albion inn`
 * is in fourteen) — so the ambiguous case is real, rare, and reaches far enough
 * that it must be *said* rather than resolved by picking.
 *
 * A shop the realm places in no room at all has no entry: the name is still
 * what the realm said sells the thing, and dropping it would lose a lead.
 */
export type ShopPlace =
  | { at: 'one'; map: number; room: number; roomName: string }
  | {
      at: 'several';
      count: number;
      /**
       * Each of the rooms, for a control that lets the player *choose* one —
       * the supplies list's shop select. Not for a button that walks to the
       * first: that is the guess the closed shape above refuses. Capped, so a
       * name in fourteen rooms is fourteen options and not a scan.
       */
      rooms: Array<{ map: number; room: number; roomName: string }>;
    };

/**
 * One counter that stocks a thing, and what stopping at it costs the journey.
 *
 * `ShopPlace` above answers *where is the shop the player named* and refuses to
 * pick between rooms, which is right: the player typed a name and the item
 * panel lets them choose. This answers a different question — *where should I
 * buy this, on my way to there* — and it is one the client is equipped to
 * settle, because it holds a position, a destination and the realm's own
 * prices. Nothing here is a guess between equals.
 *
 * **The detour is the quantity, not the distance.** A counter two hundred moves
 * away that the route already walks through costs nothing to stop at; one sixty
 * moves away in the wrong direction costs a hundred and twenty. Ranking by
 * nearness sent a character to the second (`Boat Launch` at the Pier against
 * `Albion Docks`, measured 2026-09-16). In plain steps, so it reads as moves —
 * it is the router's own cost, where an ordinary corridor is 1.
 */
export interface BuyingPlace {
  map: number;
  room: number;
  roomName: string;
  /** The shop's name, as the realm spells it. */
  shop: string;
  /**
   * `Shops.Markup%` — the whole of the price difference between two counters
   * selling the same thing.
   *
   * The realm's base figure is the **item's**, not the shop's: 0 of the 1,539
   * stocked rows in Paradigm carry a different base at a different counter
   * (measured 2026-09-16). So the markup is the entire ratio, exactly, and no
   * copper has to be invented to compare two of them — which matters, because
   * the base figure is not copper and the client has settled that it must not
   * be multiplied into one (`ShopFace`).
   */
  markup: number;
  /** What stopping here adds to the journey, in plain steps. */
  detour: number;
  /** How many moves away the counter is, for the sentence. */
  moves: number;
}

/** One stop of the ring to go and kill in for an item — `WorldGraph.droppingPlaces`. */
export interface DropPlace {
  id: RoomId;
  name: string;
  /** The dropper this room spawns, as the realm spells it. */
  mob: string;
  /** How many moves from where the character stood, for the sentence. */
  steps: number;
  /**
   * The monster this room places whose death summons the dropper, where the
   * realm places the dropper nowhere itself (todo 806): the dying slaver
   * leader is the slaver leader's death spell. Absent for a placed dropper.
   */
  via?: string;
}

/**
 * A room where saying something gets an item (todo 806): a script's handover
 * (`ask sleazy shopkeeper orb`, or a phrase said in the room) or a room script
 * that summons a monster which drops it (`touch statue`). `WorldGraph.itemAsks`.
 */
export interface ItemAsk {
  room: RoomId;
  roomName: string;
  /** What is said there, ready to send. */
  say: string;
  /** The dropper the phrase summons, where it is a summons rather than a handover. */
  summons?: string;
  /** How many moves from where the character stood, for the sentence. */
  steps: number;
}

/** One monster whose drop list names an item, and whether the realm places it. */
export interface Dropper {
  /** As the realm spells it. */
  mob: string;
  /** How many rooms the realm spawns it in, reachable or not; 0 for one only ever summoned. */
  placed: number;
}

/**
 * Where the realm says an item can be killed for, from one room.
 *
 * The droppers ride beside the lairs because an empty `lairs` has two
 * readings a refusal must keep apart: every dropper summoned rather than
 * placed, or placed where this traveller cannot go. See `mudengine-automation`
 * › *A route that needs an item goes and gets it*.
 */
export interface DropSources {
  droppers: readonly Dropper[];
  /**
   * The ring nearest the character: the cheapest placement to reach and the
   * placements within `hunting.clusterRadius` of it, capped, in the order a
   * lap walks out from the first.
   */
  lairs: readonly DropPlace[];
}

/** `Shops.ShopType` as words, sampled name by name (see `buildRealm.ts`). */
export function shopKind(type: number): ShopKind | undefined {
  switch (type) {
    case 5:
      return 'temple';
    case 6:
      return 'tavern';
    case 7:
      return 'bank';
    case 8:
      return 'trainer';
    case 9:
      return 'inn';
    case 1:
    case 2:
    case 3:
    case 4:
    case 10:
      return 'shop';
    default:
      return undefined;
  }
}

/**
 * Every name the realm knows, for a console that decorates what it
 * recognises. Lower-cased, and only the kind: what the realm *says* about a
 * name is one lookup away and is not shipped to every window up front.
 */
export interface WorldNames {
  items: string[];
  mobs: string[];
  spells: string[];
  /**
   * The thirteen races and fifteen classes the realm offers.
   *
   * Two closed vocabularies rather than open name tables, and small enough to
   * ship whole. They are the two words on every `look` at a player — `a Human
   * Warrior`, `a Half-Ogre Mystic` — and until the realm indexed them they were
   * the only words on that line the console could not answer about.
   */
  races: string[];
  classes: string[];
  /**
   * Every room name worth recognising in the console.
   *
   * **Multi-word only, and the floor is not the four-character one the other
   * kinds use.** 66 of the realm's 3,779 distinct room names are a single
   * ordinary word — `street`, `bridge`, `alley`, `stairs`, `kitchen` — and one
   * of them, `street`, occurs 289 times in the capture corpus, almost always
   * *inside* a longer name like `Silver Street`. Linking the bare word would
   * underline prose and, worse, would take `Silver Street` apart into a link
   * on its second half. A room's name is the one kind whose members are
   * routinely substrings of each other, so the longest-match rule needs the
   * short ones kept out rather than merely outranked.
   */
  rooms: string[];
}

/**
 * A spell the realm knows: the reference a player used to keep on paper.
 *
 * Every field but the name is optional, and absent means *the realm does not
 * say* rather than zero — a spell that costs no mana and a spell whose cost is
 * not recorded are different facts, and only one of them can be acted on.
 */
/**
 * What a room's own spell does to whoever stands in it, and what stops it.
 *
 * The realm states both halves and nothing read either. `Rooms.Spell` names a
 * real `Spells` row for 13,016 of the shipped realm's rooms, and 845 of them
 * are the Silver River, whose spell carries no magnitude at all: it is a
 * script that stops if you are carrying a log raft, a wooden skiff, a
 * silverbark canoe or a river punt, and otherwise casts `battered` for 10–20.
 * The script lives in `TBInfo`, which is not converted, so the chain is
 * followed at build time (`src/main/world/spellHazard.ts`) and the answer
 * written onto the spell.
 *
 * **`avoidedBy` is the half that makes this actionable.** A river the
 * character has a boat for is a corridor; the same river without one is a
 * hundred rooms of damage, and the router has to price those differently or
 * the answer is wrong for one of the two characters asking.
 */
/**
 * A band of character levels an effect is gated to, as the realm's own
 * `minlevel` / `maxlevel` state it. Absent on either side is unbounded there.
 *
 * `TextBlockPart.cs` answers both from the sheet with `Succeeded` or `Failed`,
 * so what stands behind one happens to *some* character — and which one is
 * stated, which is what lets the router stop pricing a sandstorm that cannot
 * catch the character it is planning for (todo 01).
 */
export interface LevelBand {
  min?: number;
  max?: number;
}

export interface SpellHazard {
  /**
   * Hit points a tick in the room is expected to cost. Absent where the chain
   * does no damage the reader could put a number on — which, with `unread`
   * set, is *not* the same as none.
   */
  damage?: number;
  /** Items that stop it outright, as `Items` row ids, in the realm's order. */
  avoidedBy?: number[];
  /**
   * Spells that stop it.
   *
   * Recorded and **never evaluated**: what the client knows about its own
   * blessings is what the server printed, and a route priced on a bless that
   * may have lapsed would be a guess with a walk at the end of it. Said on the
   * card instead, so a person can act on it.
   */
  avoidedBySpell?: number[];
  /** Whether it moves the character somewhere the exit table does not name. */
  relocates?: boolean;
  /**
   * Whether the chain can put a monster in the room. Read, and priced as a
   * discouragement like `unread`, because what it does is what a lair does;
   * said as itself rather than as a chain that could not be followed.
   */
  summons?: boolean;
  /**
   * Whether the chain ran into something the reader could not follow.
   *
   * Unknown is never the reassuring answer: such a room is discouraged rather
   * than walked for free, which is exactly what an unread script used to buy.
   */
  unread?: boolean;
  /**
   * The level bands the realm gates some of these effects behind (todo 01).
   *
   * Absent per effect is **ungated**. Read through `hazardFor`, never
   * directly: a reader that forgot to would price a gated effect for every
   * character, which is the bug this exists to fix.
   */
  levels?: { damage?: LevelBand; relocates?: LevelBand; summons?: LevelBand };
}

/**
 * This hazard as it applies to a character of this level.
 *
 * **Unknown level keeps everything**, which is the refuse-rather-than-guess
 * rule: a character the client cannot place is priced for the whole chain, as
 * it was before any of this existed. Only a *stated* level drops a *stated*
 * band, and only where the band excludes it outright.
 *
 * Returns the same reference where nothing is gated, so the ordinary room —
 * which is almost all of them — costs one property read.
 */
export function hazardFor(hazard: SpellHazard, level: number | null | undefined): SpellHazard {
  const bands = hazard.levels;
  if (bands === undefined || level === null || level === undefined) return hazard;
  const out = (band: LevelBand | undefined): boolean =>
    band !== undefined &&
    ((band.min !== undefined && level < band.min) || (band.max !== undefined && level > band.max));

  const damage = out(bands.damage);
  const relocates = out(bands.relocates);
  const summons = out(bands.summons);
  if (!damage && !relocates && !summons) return hazard;
  return {
    ...hazard,
    ...(damage ? { damage: undefined } : {}),
    ...(relocates ? { relocates: false } : {}),
    ...(summons ? { summons: false } : {})
  };
}

/**
 * One ward the realm itself writes: an item's use stops a room's own spell.
 *
 * The realm's half of `automation.health.potions` — a player's row says *drink
 * the antidote when poisoned* and this says *use the waterskin where the
 * desert spell is cast*, which is the same sentence with the realm as its
 * author. `Wards` acts on it and the settings screen draws it, so a switch
 * over rules nobody can read is not what the player is offered.
 *
 * Every field is a name rather than an id: this crosses to the renderer, and
 * a row id means nothing there.
 */
export interface WardRule {
  /** The item whose use casts the ward, as the realm names it. */
  item: string;
  /** The spell that use casts. */
  ward: string;
  /** The room's own spell it stops. */
  hazard: string;
  /** How many rooms of this realm cast that spell. */
  rooms: number;
}

/**
 * Whether the pack already stops a room's spell.
 *
 * The one test both the router and the card make, so the route that walks the
 * Silver River and the panel that explains why cannot disagree about whether
 * the boat in the pack counts. `carrying` is `Traveller.keys` — the `Items`
 * row ids the listing resolved — and an unlisted pack is *nobody has said*,
 * which is never *avoided*: the reassuring answer is the dangerous one here.
 *
 * The spell half is consulted only where the server has **stated** the spell
 * up with a countdown still running (`Traveller.spellsUp`, todo 105): what
 * the client knows about its own blessings is otherwise what the server
 * printed once, and a route priced on a bless that may have lapsed is a guess
 * with a hundred rooms of damage after it. A bless with no stated clock is
 * said on the card and kept up by `Wards`, never priced.
 */
export function hazardAvoided(
  hazard: SpellHazard,
  carrying: readonly number[] | undefined,
  spellsUp: readonly number[] = []
): boolean {
  const wanted = hazard.avoidedBy;
  if (
    wanted !== undefined &&
    carrying !== undefined &&
    wanted.some((item) => carrying.includes(item))
  )
    return true;
  const spells = hazard.avoidedBySpell;
  if (spells === undefined || spellsUp.length === 0) return false;
  return spells.some((spell) => spellsUp.includes(spell));
}

export interface WorldSpell {
  id: number;
  name: string;
  /** The abbreviation the realm accepts in place of the name. */
  short?: string;
  level?: number;
  mana?: number;
  energy?: number;
  duration?: number;
  /**
   * `Spells.Targets` — who the realm lets this spell be cast on. Format 17.
   *
   * The realm's own number, undecoded here for the reason `abilities` is
   * undecoded here: `spellTargeting` in `src/shared/spellcraft.ts` reads it,
   * so a correction to the reading reaches a realm converted before it
   * without rebuilding the realm. Absent means the realm does not say — a
   * derivative realm, a row holding the realm's own zero, or a conversion
   * from before v17 — and absent must never close a picker.
   */
  targets?: number;
  /**
   * `Spells.Diff` — how much easier or harder this spell is than the caster's
   * own spellcasting figure. Format 22.
   *
   * The one input to the server's cast roll that varies per spell:
   * `chance = min(100, SpellCasting + Diff)` (`Spells/Spell.cs:2092`). Signed,
   * and kept signed — `ethereal shield` is −5 on the Paradigm database, a
   * spell that is *harder* than the caster's figure suggests, and clamping it
   * would make every such spell look easier than it is. Absent is the realm's
   * own zero: a spell that neither helps nor hinders. `shared/prowess.ts`
   * reads it.
   */
  difficulty?: number;
  /**
   * `Spells.TypeOfResists` — whether a target's magic resistance can turn the
   * whole cast away. Format 20.
   *
   * The realm's own number, undecoded for the reason `targets` is: `Spell
   * .GetSpellResistType` reads `0` as never resisted, `1` as resisted only by
   * an `AntiMagic` ability, and `2` as resisted by anybody, and a correction
   * to that reading must not need every realm converted again. Absent is the
   * realm's own zero — a spell nothing resists — and *that is the dangerous
   * end*, which is why `menace.ts` treats absence as a cast that lands.
   */
  resist?: number;
  /**
   * What it does to somebody standing in a room that casts it, and what stops
   * it — format 30. See {@link SpellHazard}.
   *
   * Written only for the spells rooms actually cast (`Rooms.Spell`), and only
   * where the chain reaches harm, a relocation, or something the reader could
   * not follow. Absent means either *this spell is not a room's* or *it does
   * nothing to whoever is standing there* — both of which are the same answer
   * to the only question asked of it.
   */
  hazard?: SpellHazard;
  /**
   * What casting it actually does, from `Spells.Abil-n` — format 14.
   *
   * 1,985 of the realm's 1,990 spells carry these, and until 2026-08-31 the
   * client wrote none of them to disk: a spell card gave its level, mana and
   * duration and was silent about the one thing a person looking it up wants.
   * The realm's own `[id, value]` pairs; `src/shared/abilities.ts` names them
   * at the point of display.
   */
  abilities?: Array<[number, number]>;
  /**
   * How much the spell does, before level scales it — `MinBase`–`MaxBase`.
   *
   * **This is where a spell's numbers actually live**, and its absence is what
   * made a card read `Stealth 0` about a spell that grants stealth. The
   * `Abil-n` row names *what* a spell affects; on 1,410 of the realm's 1,990
   * spells the magnitude is here instead, and `AbilVal-n` is a genuine zero —
   * `way of the owl` is `M.R.` with `AbilVal 0` and a power of 10, and the
   * client was reading the realm correctly and printing the wrong column.
   *
   * A pair rather than a number because a damage spell states a spread
   * (`way of the exploding fist`, 0–30) where a buff states one figure twice.
   * Signed: 167 spells state a negative power, which is a spell that takes
   * something away.
   */
  power?: [number, number];
  /** The ceiling the scaling reaches — `Spells.Cap`. 508 spells state one. */
  cap?: number;
  /**
   * `Spells.AttType` read as `Spell.GetSpellAttackType` reads it (format 34,
   * todo 09): which of a monster's resistances takes a share of the damage
   * (`Spell.CheckResistance`). Absent where the column is blank.
   */
  element?: SpellElement;
  /**
   * How the magnitude grows with level: `[levels per step, amount per step]`,
   * from `MinIncLVLs`/`MinInc` and the `Max` pair beside it.
   *
   * Both halves are kept even though they agree on nearly every spell, because
   * they are two of the realm's own columns and a card that showed one of them
   * as both would be inventing the agreement. A spell whose power is `0–0`
   * with growth is the whole of the case that looked broken: `way of the cat`
   * is stealth at `+1` every 2 levels to a cap of 30, and none of those three
   * numbers reached the client.
   */
  minGrowth?: [number, number];
  maxGrowth?: [number, number];
  /** The same for how long it lasts — `DurIncLVLs`/`DurInc`. 150 spells. */
  durationGrowth?: [number, number];
}

/**
 * A race the realm offers.
 *
 * The stat pair is `[minimum, maximum]` — where the race starts and the ceiling
 * it can ever train to. Absent throughout means *the realm does not say*, never
 * zero: a race with no recorded strength range and one that cannot train
 * strength are different facts.
 */
export interface WorldRace {
  id: number;
  name: string;
  int?: [number, number];
  wil?: [number, number];
  str?: [number, number];
  hea?: [number, number];
  agl?: [number, number];
  chm?: [number, number];
  /** Extra hit points per level, over what the class gives. */
  hpPerLevel?: number;
  /** Experience multiplier as a percentage; 100 is the ordinary rate. */
  expTable?: number;
  /**
   * What the race grants, from `Races.Abil-n` — format 14.
   *
   * Eleven of the thirteen races carry these and they are the half of a race
   * the stat ranges do not state: a Dwarf's infravision, a Kang's poison
   * immunity, a Halfling's dodge. Mostly `grant`-shaped — see
   * `src/shared/abilities.ts` — where the row's presence is the fact and its
   * value a bonus that is often zero.
   */
  abilities?: Array<[number, number]>;
}

/**
 * A class the realm offers.
 *
 * Deliberately narrower than the table behind it: see `BuiltClass`. A hit-dice
 * pair whose order nothing has settled and a magery *type* whose numbering only
 * speaks for zero are both left out rather than published as facts.
 */
export interface WorldClass {
  id: number;
  name: string;
  /** Experience multiplier as a percentage; 100 is the ordinary rate. */
  expTable?: number;
  /** Magery level, 1-3. Absent for a class that casts nothing. */
  magery?: number;
  /** How well it fights, on the realm's own 1-7 scale. */
  combat?: number;
  /**
   * What the class grants, from `Classes.Abil-n` — format 14.
   *
   * All fifteen classes carry these and they are what actually distinguishes
   * one: a Thief's `GrantPicklocks 10` and stealth, a Mystic's unarmed
   * attacks, a Witchunter's `AntiMagic`. `magery` and `combat` are two numbers
   * on a scale; this is the list of things the class can do.
   */
  abilities?: Array<[number, number]>;
}

/**
 * Everything the realm data knows about a name, whatever kind of thing it is.
 *
 * One query across the three name indexes, because the person asking has a
 * *name* — off a room listing, a pack, a shop shelf, a rule they are writing —
 * and should not have to know which table answers it. Each list is capped and
 * ranked prefix-first; empty means the realm does not say, never that the
 * thing does not exist.
 */
export interface WorldLookup {
  mobs: WorldMob[];
  items: WorldItem[];
  spells: WorldSpell[];
  races: WorldRace[];
  classes: WorldClass[];
  /**
   * The realm's own class table, by id — for an ability whose *value* is a
   * class rather than a magnitude.
   *
   * `ClassOk` (id 59) is the realm saying which classes may use an item, one
   * pair per class, and 233 items carry at least one. The value is a row id in
   * `Classes`, so naming it needs that table — and `classes` above is a
   * *search result*, empty unless the query happened to name a class.
   *
   * Fifteen short strings, sent whole with every lookup: the alternative is
   * either a second round trip for a row the card is already drawing, or the
   * bare number under a heading that reads as the realm's own vocabulary,
   * which is the lie `abilityName` returns null to avoid telling.
   */
  classNames: Record<number, string>;
  /**
   * What *this* character's realm has learned about each monster named, by
   * the monster's name, for the ones fighting has taught anything about.
   * Beside the realm's figure and never instead of it: the realm file is the
   * lead, and "seen to survive 75" against "the realm says 60" is the fact
   * that decides whether to trust the bar.
   */
  learned?: Record<string, MobLoreEntry>;
  /** What this character's own fight record says about each monster named, where it says anything. */
  fights?: Record<string, FightSummary>;
  /**
   * *Can I fight this?* — each monster named, weighed against the character as
   * it stands right now: what it costs to leave standing, what it costs to
   * kill, and the health the fight is expected to take. By the monster's
   * name. The same `Verdict` auto-combat ranks on, so the card and the engine
   * cannot disagree; absent for a query that named no monster, and a monster
   * the realm cannot weigh has a verdict whose halves are null rather than no
   * key, because *unknown* is an answer the card draws.
   */
  verdicts?: Record<string, Verdict>;
  /**
   * This character's own row saying each monster named does not attack first
   * (`peaceOf`, todo 818), by the monster's name: shown beside the realm's
   * disposition, never instead of it. Absent where no row makes the claim.
   */
  rowPeace?: Record<string, RowPeace>;
  /**
   * Where each shop named in a returned item's `Sold by` row is, by the shop's
   * name lower-cased.
   *
   * Resolved here rather than at click time, so reading the row and acting on
   * it are one round trip — and so the card never has to hold a channel of its
   * own to answer *where is that*. Absent for a query that named no item, and
   * a shop the realm places nowhere simply has no key. See `ShopPlace`.
   */
  shopPlaces?: Record<string, ShopPlace>;
  /**
   * Where the realm spawns each monster named, by the monster's name.
   *
   * Resolved here for the reason `shopPlaces` is: reading *where does this
   * thing come from* and walking to one of those places is one round trip, and
   * the card never needs a channel of its own for a join the realm file can
   * already make. A monster the realm puts in no room simply has no key —
   * 153 of the shipped realm's 1,514 names, the summoned and the scripted —
   * which is the honest answer rather than an empty list reading as *nowhere*.
   */
  mobPlaces?: Record<string, MobPlaces>;
}

/**
 * What lives in a room the realm marks as a lair.
 *
 * The room's `lair` string is `(Max 2): 187,188,189,783,788,` — how many may
 * be up at once, then the monster ids that can spawn — and `WorldGraph.lair`
 * turns it into monsters with names, health and dispositions. The map has
 * drawn a lair glyph since the data was indexed and nothing said what lives
 * there, which is the question that decides whether to walk in.
 */
export interface WorldLair {
  /** How many are up at once, when the descriptor states it. */
  max: number | null;
  /**
   * How long the room waits before it fills again, in seconds.
   *
   * `Rooms.Delay` put through `respawnSeconds` (`src/shared/hunting.ts`), which
   * is the one reading of that column — the unit rules and GreaterMUD's
   * thirty-second offset included. Resolved in main rather than carried raw,
   * because the offset is a *server* behaviour and only main holds the family
   * the wire stated; the renderer reads a number of seconds and nothing else.
   *
   * Null where the data states no clock — a realm converted before format 33.
   * Every lair in both shipped worlds states one (14,068 and 3,102).
   */
  respawnSeconds: number | null;
  /**
   * What can spawn, de-duplicated, in the realm's order. Empty when the
   * descriptor names only ids this table lacks — a derivative's additions —
   * which the face says rather than hides.
   */
  mobs: WorldMob[];
}

/**
 * A room's `Lair` descriptor, read.
 *
 * **The two databases on this machine spell it differently, and only one of
 * them was being read correctly.** GreaterMUD writes `(Max 2): 1141,2175,2176,`
 * — the slot count and the monster numbers, which is what
 * docs/greatermud/player-and-world.md records. Paradigm's MMUD-Explorer export
 * appends its own spawn parameters in brackets: `(Max 2): 781,190,[6-30-31-2]`,
 * every one of its 14,068 lairs. Those four numbers are not monsters, and the
 * reader took every digit in the string, so the Lucky Strike Casino's lair of
 * *drunken brawler, drunken gambler* read as that pair plus an **orc rogue, a
 * grey spider, a mummy and a lashworm** — four monsters the realm never put
 * there, on the one face a player reads before deciding whether to walk in.
 * The shipped realm is the Paradigm one, so this was wrong for every lair in
 * the client.
 *
 * Stated as a parse rather than a regex at each use so the lair face and the
 * spawn index cannot come to different conclusions about what a descriptor
 * says. The `(Max n)` clause is removed *whole* rather than the first number
 * being dropped: a descriptor that states no maximum would otherwise lose a
 * real monster to the slice.
 */
export function parseLair(descriptor: string): { max: number | null; ids: number[] } {
  // Everything from the first bracket on is the exporter's own parameters.
  const body = (descriptor.split('[')[0] ?? '').replace(/\(Max\s+(\d+)\)\s*:?/i, ' ');
  const max = /\(Max\s+(\d+)\)/i.exec(descriptor);
  const ids: number[] = [];
  for (const match of body.matchAll(/\d+/g)) {
    const id = Number(match[0]);
    if (id > 0 && !ids.includes(id)) ids.push(id);
  }
  return { max: max ? Number(max[1]) : null, ids };
}

/**
 * Where the realm puts a monster, by the name of the room it puts it in.
 *
 * Grouped by *name* because that is the answer to the question being asked.
 * `snow cat` is in 236 rooms of 25 names, and a list of 236 addresses is not
 * somewhere a person can decide to go; `Snowy Plains` is. The addresses are
 * carried underneath so a group of several is something to **choose from** —
 * never a button that walks to whichever room the file listed first, which is
 * the guess `ShopPlace` already refuses for the same reason.
 */
/**
 * Rooms of one name that something is put in — a monster's spawn group, an
 * item's placement.
 *
 * Grouped by name because that is what a reader recognises, and **a group of
 * several is a choice, never a walk to the first**: the card opens it into
 * its addresses. `count` is the whole group and `rooms` the capped list.
 */
export interface PlaceGroup {
  roomName: string;
  /** How many rooms of that name hold it, whether or not `rooms` lists them all. */
  count: number;
  /** Those rooms, capped — each one a place a walk can be planned to. */
  rooms: Array<{ map: number; room: number }>;
}

/**
 * Every room the realm puts one item in — `Rooms.Placed`, format 42. The
 * `MobPlaces` shape, for the question *where does this lie*.
 */
export interface ItemPlaces {
  /** The widest spread first. Capped. */
  groups: PlaceGroup[];
  /** Groups the cap left out, so a truncated list says it is one. */
  more: number;
  /** Every placed row is one the realm will not let anybody pick up. */
  fixed?: true;
}

export interface MobSpawn extends PlaceGroup {
  /**
   * How the realm puts it there.
   *
   * `npc` is `Rooms.NPC` — the room's own resident, one specific creature that
   * belongs to that room. `lair` is `Rooms.Lair` — a regeneration slot the
   * monster is one candidate for, so it is *what can be here*, not what is.
   * The distinction decides whether walking there finds the thing.
   */
  via: 'npc' | 'lair';
  /**
   * How many may be up at once, where every descriptor in the group agrees.
   * Null where they disagree or state none — a figure folded from rows that
   * disagree would be a number the realm never gave.
   */
  max: number | null;
}

/**
 * Every room the realm spawns one monster in.
 *
 * The reverse of `WorldRoom.npcId` and `WorldRoom.lair`, which the client has
 * carried since the world file began and could only ever read forwards: the
 * Room card could say *this lair holds a snow cat* and nothing could answer
 * *where is a snow cat*. That is the question a player has, and the realm data
 * already held it.
 */
export interface MobPlaces {
  /** The groups, `npc` before `lair` and the widest spread first. Capped. */
  spawns: MobSpawn[];
  /** Rooms in all, across every group including the ones the cap left out. */
  rooms: number;
  /** Groups the cap left out, so a truncated list says it is one. */
  more: number;
}

/**
 * One swing a monster can take, as the realm's `Monsters` table states it —
 * format 20, from the five `Attack …` column groups.
 *
 * Two kinds, because the server has two (`MobType.GetAttackType`): a blow
 * that rolls to hit and does damage, and a spell cast in the blow's place.
 * The columns are overloaded between them — `Attack Accu/Spell` is an
 * accuracy for one and a spell id for the other, `Attack Min Hit/Cast %` and
 * `Attack Max Hit/Cast LVL` likewise — which is why this is a discriminated
 * union rather than six numbers with two readings.
 *
 * `chance` is the **effective** chance this slot is the one rolled, as a
 * fraction, computed at build time by transcribing `Mob.GetAttackType`: the
 * realm stores the cumulative thresholds, one roll of 1–100 walks them in
 * slot order, and a roll above the last threshold falls back to the first
 * slot. The editor's own `AttTrue%` column is deliberately **not** used: it
 * is a cached figure from some other model, and measured against the walk
 * on 2026-09-04 (1,610 GMUD rows stating a total of 100) it agrees within
 * a point on half the slots and drifts by up to 73 on the rest — see
 * docs/greatermud/combat.md. The server's own loop is what runs.
 */
export type MobAttack =
  | {
      kind: 'melee';
      chance: number;
      /** `Attack Accu` — the figure the target's armour class is rolled against. */
      accuracy: number;
      min: number;
      max: number;
      /** What the swing spends of the 1,000 energy a round grants. */
      energy: number;
      /** A spell applied to the target on every landed blow, by realm id. */
      onHit?: number;
    }
  | {
      kind: 'spell';
      chance: number;
      /** The realm spell id cast in place of a blow. */
      spell: number;
      /** `Attack Min Hit/Cast %` — the chance the cast succeeds, as a fraction. */
      castChance: number;
      /** `Attack Max Hit/Cast LVL` — the level it is cast at, which scales its power. */
      level: number;
      energy: number;
    };

/**
 * A spell a monster casts between rounds, while it has a target — format 20,
 * from `Spell Number n` / `Spell Cast % n` / `Spell Cast LVL n`.
 *
 * `chance` is per round and **marginal**, not the column's figure: the server
 * makes *one* roll of 1–100 per monster per round and fires the first slot
 * whose percentage covers it (`TimedEventManager`, the between-round loop),
 * so a second slot at 20% behind a first at 10% fires on rolls 11–20 — a
 * tenth of rounds, not a fifth. Transcribed at build time so a reader adds
 * the figures rather than re-deriving the roll.
 */
export interface MobCast {
  spell: number;
  chance: number;
  level: number;
}

/**
 * One realm row's way of fighting — format 20.
 *
 * Per **row**, not per name, and deliberately so. Every other number on a
 * monster is folded to the worst of the rows sharing its name at build time,
 * because for a magnitude "worst" is a fixed direction. Which attack profile
 * is worst *depends on who is standing in front of it*: a high-accuracy,
 * low-damage row and a low-accuracy, high-damage row change places as the
 * character's armour class rises, and the fold cannot be done without the
 * character. So the rows are carried, de-duplicated where identical, and
 * `weighMenace` in `menace.ts` folds them against the character it is
 * weighing for.
 */
export interface MobProfile {
  attacks: MobAttack[];
  casts: MobCast[];
}

/**
 * One of the realm's `Monsters` rows, answering for itself — format 32.
 *
 * Every field is the same column `WorldMob` folds across the rows sharing a
 * name, read from this row alone. Absent still means *the realm states no
 * such column*, never zero.
 */
export interface WorldMobRow {
  /** The realm's row number — what a lair names and what a room resolves to. */
  id: number;
  hp: number;
  /** Null where this row states no alignment: one row, certain about itself. */
  disposition: MobDisposition | null;
  /** How this row fights. Null where it states no attack at all. */
  profile: MobProfile | null;
  armour?: number;
  damageResist?: number;
  magicResist?: number;
  experience?: number;
  regen?: number;
  /**
   * `Monsters.RegenTime`, in hours: how long a *placed* monster stays dead
   * (`RegenSlot.Regen`: `MobType.Regen * 3600`). A lair room respawns on
   * its own `Delay` instead; this is the boss's clock (format 33, todo 05).
   *
   * On the fold from format 36, and only where every row of the name agrees
   * (`BuiltMob.rt`) — before that it was declared here and set by nobody, so
   * a uniquely named boss, having no `rw`, carried no clock at all.
   */
  regenHours?: number;
  follows?: number;
  averageDamage?: number;
  charmLevel?: number;
  undead?: boolean;
}

/**
 * Which of a name's rows a room resolved it to, and on what evidence.
 *
 * A refusal is a decision and so is a choice: the card shows one row's numbers
 * where the name holds several, so it has to be able to say *this row, because
 * this room's own lair names it* or *because the nearest other one is four
 * hundred steps away*. Absent where nothing could be resolved, which leaves
 * the fold and its range exactly as they were.
 */
export interface MobRowChoice {
  /** The realm row the numbers came from. */
  id: number;
  /**
   * `here` — this room's own lair or resident names exactly one of the rows.
   * `nearest` — no row is named here, and one spawns decisively closer than
   * every other row sharing the name.
   */
  how: 'here' | 'nearest';
  /** Steps to the nearest room this row spawns in. Zero for `here`. */
  steps: number;
  /**
   * How far the search looked without meeting another row of this name: every
   * other row is further away than this.
   *
   * Null for `here`, where the room named the row outright and no distance was
   * measured. A second row found anywhere inside the search is a refusal
   * rather than a runner-up — which is why this is a radius and not the other
   * row's distance: measuring *by how much* would mean sweeping on past the
   * point where the answer had already been decided.
   */
  beyond: number | null;
}

/**
 * A monster the realm data can put a number on.
 *
 * **Named, not numbered**, because a name is all the stream ever gives: the
 * combat lines carry `the giant rat`, never a record id. Several rows in the
 * realm database frequently share one name with different health — five
 * `cocoon`s between 100 and 250 — so a name resolves to a range and this states
 * the range rather than picking a row and sounding certain.
 *
 * `hp` is the number to work from and is the **high** end of that range. Over-
 * stating a monster's health means it dies before the bar said it would;
 * under-stating it means the bar says "nearly dead" about something that is
 * not, and that is the error that keeps a character in a fight it should have
 * left.
 */
export interface WorldMob {
  name: string;
  /** Maximum health to work from: the high end when the realm data disagrees. */
  hp: number;
  /** Present only when several rows share the name and disagree. */
  span?: [number, number];
  /**
   * The realm's own row numbers behind this name — format 9, carried here
   * since format 32.
   *
   * The wire never says a number, so the fold above is what a bare name
   * resolves to. But a *room* is evidence about which row is standing in it,
   * and this is the list that evidence is weighed against: see
   * `WorldGraph.resolveMobRow`. One entry is a name the realm places once.
   */
  ids?: number[];
  /**
   * Which row this is, when a room resolved the name to one of `ids`.
   *
   * Present only on the copy `WorldGraph.mobAt` returns, never on the shared
   * fold — every magnitude below is then that row's own rather than the worst
   * of its twins', and this says which row and on what evidence, because a
   * card showing one row's numbers under a name that holds several is making
   * a claim somebody has to be able to check.
   */
  row?: MobRowChoice;
  /**
   * Whether it starts the fight, from `Monsters.Align` and `Monsters.Type`.
   *
   * See `src/shared/mobs.ts`: this is a reading of `ShouldMobAttackTarget`
   * rather than a heuristic over the name. Null on a realm file built before
   * this was indexed, which every consumer already handles — a monster the
   * realm cannot place is the ordinary case on a derivative.
   */
  disposition: MobDisposition | null;
  /**
   * True when the rows sharing this name do **not** agree about that.
   *
   * `disposition` is then the worst of them, which is right for a readout and
   * wrong for a decision: a client that swung at everything a *twin* of would
   * have attacked would start fights in rooms nobody chose. So the arbiter
   * requires certainty and a card says the realm data is not sure.
   */
  uncertain: boolean;
  /**
   * Whether attacking one costs this character ten evil points.
   *
   * `Mob.GetEPCostForAttacking` charges for a `Good` or `LawfulGood` target and
   * nothing for any other alignment, and the charge is *cumulative and to the
   * character* rather than to the fight. `sometimes` when only some of the rows
   * sharing this name are one of those — see `AlignmentCost`.
   */
  costly: AlignmentCost;
  /**
   * What it is worth and what it takes, from format 12 of the realm file.
   *
   * Every one of these is the **worst of the rows sharing this name** — the
   * highest armour class, the most damage absorbed, the least experience — for
   * the reason `hp` takes the high end: a name resolves to several rows and the
   * reassuring end of a range is the dangerous one to act on. Absent on a realm
   * file built before format 12, and absent where the realm states no column,
   * which are the same answer as far as anything reading them goes.
   */
  armour?: number;
  damageResist?: number;
  magicResist?: number;
  experience?: number;
  /**
   * Health it recovers per regeneration tick.
   *
   * The tick is realm-wide rather than per monster — `MOB_REGEN_ROUNDS` in
   * `src/shared/mobs.ts` — and this is the amount. It is what lets a wound
   * estimate stop drifting below the truth as a fight drags on; see
   * `src/main/parse/combat.ts`.
   */
  regen?: number;
  /** Hours a placed one stays dead — `Monsters.RegenTime` (format 33). */
  regenHours?: number;
  /**
   * The chance it follows when this character leaves the room, as a percentage.
   *
   * 374 of the shipped realm's 1,833 rows are 100 and 262 are 0. It is the fact
   * an automatic retreat is decided on and the client had no way to know:
   * running one room from something that always follows spends a move and
   * changes nothing.
   */
  follows?: number;
  /** True when any row sharing this name is undead. */
  undead?: boolean;
  /**
   * What it drops, by name, capped at six.
   *
   * The reverse of `WorldItem.mobs`, and the other half of the only two
   * questions anybody asks about a monster: *where do I get one of these* and
   * *what is in this thing*.
   */
  drops?: string[];
  /**
   * `Monsters.Type`, undecoded — every distinct value the rows state.
   *
   * Read by nothing on purpose. No reading of this column survives the data
   * (measured 2026-09-02); it is carried so a later capture can decode it
   * without reconverting every realm, exactly as `abilities` carries numbers.
   */
  realmTypes?: number[];
  /** `Monsters.AvgDmg` — the worst of the rows sharing the name. */
  averageDamage?: number;
  /** `Monsters.CharmLVL`. */
  charmLevel?: number;
  /**
   * Spell ids it casts mid-fight (`MidSpell-0..4`), and the one it casts on
   * death (`DeathSpell`).
   *
   * The fact behind *decline anything that detonates when it dies*: nothing in
   * the stream says so until it already has.
   */
  casts?: number[];
  deathSpell?: number;
  /**
   * How each row sharing this name fights — format 20. See `MobProfile` for
   * why it is per row. Absent on a realm converted before format 20 and for
   * a name whose rows state no attack and no between-round spell at all.
   */
  profiles?: MobProfile[];
  /**
   * What it resists, ignores and calls for help, from `Monsters.Abil-n` —
   * format 14.
   *
   * 1,473 of the realm's 1,833 monster rows carry these, and they decide a
   * fight: `Resist-Fire` runs from −200 to 300, `SpellImmu` is on 649 rows,
   * and `AffectsLivingOnly` is on 87 spells that a `NonLiving` monster ignores
   * outright. None of it reached a screen before 2026-08-31.
   *
   * **Every value every row sharing this name states**, unreduced — unlike the
   * other numbers here, which are folded to the worst of the rows at build
   * time. A `zombie` is three rows disagreeing about fire, and all three
   * figures are carried.
   *
   * The fold is deferred because "worst" only means "highest" for a magnitude:
   * `SpellImmu 40` and `45` on the two `ancient sand dragon` rows are two
   * different spells, and `dwarven warrior` states `MonsGuards` three times.
   * Which reduction is right depends on the ability's *shape*, and a shape is
   * a display judgement this file must not bake in — see `BuiltMob.ab`. The
   * card reduces (`effectValues`): the cautious high end of a magnitude, every
   * member of a set.
   */
  abilities?: Array<[number, number]>;
}

/**
 * The form a monster name is keyed by.
 *
 * The stream spells one monster several ways in the same fight — `The giant rat
 * bites you`, `You slash the giant rat`, `A giant rat walks in` — and the realm
 * data spells it a fourth. Lowercased, article stripped, whitespace collapsed:
 * a lookup and a damage ledger that disagreed about which of those was the key
 * would silently keep two half-fights.
 *
 * Only the leading article is stripped, and only when a word follows it: `the
 * thing` is a monster called `thing`, and `the` on its own is a monster called
 * `the`, which is not a case worth losing a name over.
 */
export function mobKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^(?:the|a|an)\s+(?=\S)/, '')
    .replace(/\s+/g, ' ');
}

/**
 * Whether a name the room printed answers to what the player typed.
 *
 * **Read out of the server**, not generalised from the cases that happened to
 * be measured: `Misc.IsMatch`, whose body is the same in all three GreaterMUD
 * trees. The rule is a substring match **anchored at a word boundary** — the
 * typed text matches where it occurs at index 0, or immediately after a space.
 * Three things a plainer rule gets wrong:
 *
 * - **It is not a prefix of the whole name.** `du` reaches `practice dummy` by
 *   starting its second word, which is how people actually type.
 * - **It is not a per-word prefix either.** Only where a match *starts* is
 *   boundary-checked, never where it ends, so the typed text may span a space:
 *   `practice du` matches. Splitting the name into words would refuse it.
 *   `ummy` does not match, because it starts mid-word.
 * - **The name-modifier case falls out for free.** `Mob.Name` joins a modifier
 *   with a space, so a base name always starts a word: `giant rat` reaches a
 *   room's `small giant rat` with no rule of its own.
 *
 * Both sides arrive in `mobKey` form. That is a normalisation the server does
 * **not** apply, and it is deliberate here for the reason `mobKey` exists: the
 * stream spells one monster four ways. The divergence it buys is bounded and
 * one-sided — a typed bare article (`l the`) matches nothing here where the
 * server would match, and a typed `the giant` matches here where the server
 * would not. Neither is a thing a player types, and the second fails safe: the
 * server answers no wound sentence, so nothing binds.
 *
 * An **empty** typed text matches everything, because `''.indexOf('')` is 0.
 * The C# has the same hazard and is saved from it only by the command layer
 * checking the argument's length first; nothing here guarantees that, so it is
 * refused outright.
 */
export function nameAnswersTo(name: string, typed: string): boolean {
  if (typed.length === 0) return false;
  return name === typed || name.startsWith(typed) || name.includes(` ${typed}`);
}

/**
 * A passage walked under a timed spell — the dive into the Muddy Underwater
 * Passage: `dive pool` casts *holding breath* (25 ticks), which ends in
 * *drowning*, and the way up at the far end casts the spell that kills both.
 *
 * `rooms` is how many the way in puts under it before the nearest exit that
 * lifts it, counting the landing; `ends` false is a passage with no such
 * exit within `ticks` moves of the landing, which the router walls. Nothing
 * carried stops one: the answer is to keep moving, which is what
 * `Walker`'s move-only rule and the session's gates do inside it.
 */
export interface Corridor {
  /** The spell the way in casts, and its name. */
  spell: number;
  name: string;
  rooms: number;
  ends: boolean;
  /** How many ticks the spell lasts, where the realm states a duration. */
  ticks?: number;
  /** What it ends in, named. */
  then?: string;
}

export interface WorldExit {
  direction: Direction;
  /** Destination, as `map/room`. */
  map: number;
  room: number;
  requirement: Requirement | null;
}

export interface WorldRoom {
  map: number;
  room: number;
  name: string;
  exits: WorldExit[];
  /** Shop type id, when the room is one. */
  shop?: number;
  /**
   * `Rooms.NPC` — the creature the realm ties to this room. Format 18 on the
   * read side; **written since the realm file began and read by nothing**,
   * which is the shape this project calls dead.
   *
   * Not "a friendly character": 701 of the shipped realm's rooms name one, and
   * the rows they point at are `mariana` behind her own counter and equally
   * `werewolf`, `night hag` and `wild turkey`. It is *who lives here*, which is
   * worth knowing before walking in — and it is not a disposition.
   */
  npcId?: number;
  /** Mob lair descriptor, verbatim from the realm data. */
  lair?: string;
  /**
   * `Rooms.Delay`, as the realm states it — the lair's respawn clock (format
   * 33, todo 05). Minutes, except that an Arena room and a negative figure
   * are seconds (`Room.GetDelayInSeconds`); `respawnSeconds` in
   * `src/shared/hunting.ts` is the one reading, family offset included.
   */
  delay?: number;
  /**
   * The realm's own light level, graded −999 … +1000. Absent means the realm
   * recorded none, which is an ordinary lit room.
   *
   * Produced by `buildRealm` since the realm file was first written and read by
   * nothing for four phases — 31,392 of the shipped realm's 55,806 rooms carry
   * it, 29,894 of them negative. Consumed now by dead reckoning: a room the
   * server refuses to describe is placeable only if the realm data agrees the
   * destination is dark, and that agreement is this field.
   *
   * **Not a boolean.** The values are graded and a lit torch moves the phrase
   * the server prints (see `ROOM_LIGHTS`), so the sum the server compares
   * against is one the client cannot fully see. Nothing here encodes a
   * threshold; negative means the realm recorded it as dark and that is all
   * that is claimed.
   */
  light?: number;
  /**
   * The words this room answers, and what each one does — realm format 13.
   *
   * From `Rooms.CMD` through `TBInfo.Action`; see `src/main/world/roomScript.ts`
   * for what that table is. 1,077 of the shipped realm's rooms carry one, and
   * they hold ways through the realm the exit table does not: a portal, a
   * vortex, a pool you dive into. **The router is not given them yet** and the
   * reason is written down there — this is a fact for a card to state, so a
   * player can act on it, and the routing work is a separate piece with
   * `check:reckoning` behind it.
   */
  commands?: RoomCommand[];
  /**
   * The spell the realm casts on whoever is standing here — format 13.
   *
   * 13,016 of 55,806 rooms carry one, and it is a real `Spells` row:
   * `bigheal`, `inn rest`, `stop drowning`, `web spell`, `under level
   * teleport`. The id, because the spell index names it; a room that heals you
   * and a room that drowns you are the same column and only the name tells
   * them apart.
   */
  spell?: number;
  /**
   * `Rooms.Placed` — the items the realm puts on this floor and puts back at
   * the nightly cleanup where they are missing, within each item's game limit
   * (format 42). Ids, named where they are read; most are furniture nobody can
   * pick up.
   */
  placed?: number[];
}

/**
 * Everything the realm knows about one room, resolved, for a room nobody is
 * standing in.
 *
 * `RoomTracker.attachRealm` attaches the shop, the lair, the script and the room's
 * spell to the room the character *is* in, and every card that wanted them got
 * them for free. A room on the map or on a route list has none of that: the
 * map cell carries a name, its exits and two booleans, which is enough to draw
 * a glyph and not enough to answer *what is in that lair* — the question the
 * glyph raises and the one that decides whether to walk in.
 *
 * So this is the same resolution, addressed at a room by id. One query, not
 * five: the shop, the lair, the hazard and the ways out are one answer about
 * one place, and a panel that asked for them separately would draw four times
 * as each landed.
 */
export interface RoomBrief {
  id: RoomId;
  name: string;
  /** Every way out, resolved: where it goes by name, and what stands in it. */
  exits: RoomBriefExit[];
  /** The place this room holds, where the realm records one. Never its stock. */
  place?: { kind: ShopKind; name: string };
  /** What the realm says can spawn here. Absent where the room is no lair. */
  lair?: WorldLair;
  /**
   * `Rooms.NPC` — who lives here, when the realm ties somebody to the room.
   *
   * The row as well as the name, because `Rooms.NPC` **is** a row number: a
   * resident is the one monster in this panel whose number is never in
   * question, and the id was in scope and thrown away until 2026-09-11.
   */
  npc?: { id: number; name: string };
  /** The spell the realm casts on whoever stands here, named. */
  spell?: WorldSpell;
  /**
   * What that spell actually does to whoever stands here, and what stops it.
   *
   * The name alone does not answer the question the reader is asking — `river
   * damage` and `inn rest` are the same column — so the resolved hazard comes
   * with it where there is one. See {@link SpellHazard}.
   */
  hazard?: SpellHazard;
  /** Those of `hazard.avoidedBy` the realm can name, so the panel can say them. */
  hazardItems?: Array<{ id: number; name: string }>;
  /** The realm's own light level, where it records one. Negative is dark. */
  light?: number;
  /** The words the room answers to, from its own script. */
  commands?: RoomCommand[];
  /**
   * What the realm puts in this room at every cleanup (`WorldRoom.placed`),
   * named. `fixed` where the realm will not let it be picked up, which is
   * most of them: a sign, a coffin, a tree.
   */
  placed?: Array<{ id: number; name: string; fixed?: true }>;
}

export interface RoomBriefExit {
  direction: Direction;
  to: RoomId;
  /** The destination's name, where the realm has the room. */
  name?: string;
  /** What stands in the way, composed against the realm's item table. */
  obstacle?: MapObstacle;
}

/**
 * One thing a room answers to, from its `TBInfo` script.
 *
 * Declared here rather than beside the parser because the renderer reads it and
 * `src/shared` is the boundary both sides import. `src/main/world/roomScript.ts`
 * builds it and says what each field is worth.
 */
export interface RoomCommand {
  /** Every phrase that does this — `go portal`, `enter black portal`. */
  say: string[];
  /** Where it leads, as `map/room`, when it moves you at all. */
  to?: RoomId;
  /**
   * The spell saying it puts on the character — format 43.
   *
   * `dive pool` at the Bountiful Oasis is `teleport 121 12:cast 512`: the
   * teleport is where you land and the cast is *holding breath*, 25 ticks
   * that end in `drowning`, which ends in death. The landing was read since
   * format 29 and the spell was narration, so eleven underwater rooms were a
   * free corridor to the router and the plan. Read by `WorldGraph.corridorsOn`.
   */
  casts?: number;
  /** What it wants, in the realm's own words. */
  need?: string[];
  /**
   * The exit this opens — a lever, from a direction column that is not an exit
   * (`parseAction`).
   *
   * The room's scripted answers (`Rooms.CMD`) and its levers are two columns of
   * the realm and one question for a person standing in the room: *what can I
   * type here*. So they are one list, and this is what tells them apart — the
   * Answers face says which exit a lever opens, because `pull lever` with no
   * consequence beside it is the client repeating the realm at somebody.
   *
   * `item` is the `Items` row the realm says must be carried to say it, where
   * it names one — the same fact `RequirementAction.item` carries, written on
   * both ends because the exit's own requirement is not always where the
   * lever can be found. See `RemoteLever.item`.
   */
  opens?: { room: RoomId; direction: string; item?: number };
}

/**
 * A lever that opens some exit, and where it is pulled.
 *
 * The other end of `RoomCommand.opens`, indexed by the exit rather than by the
 * room holding the lever — which is the direction every question about it is
 * asked from: *this step was refused; is there anything anywhere that opens
 * it*.
 *
 * **Why this is not `Requirement.actions`.** That field is written only where
 * the exit's own instruction says `Needs N Actions` and the realm's count
 * matches the levers found, which leaves out the shape this exists for
 * entirely: `1/1331` north out of Inner Gate reads `Door [301
 * picklocks/strength]` and says nothing about a lever, while a Guardroom on
 * each side holds one whose whole purpose is that gate. Measured over the
 * shipped realm: 225 exits have a lever pointing at them, and 25 of them carry
 * no `actions` at all — invisible to anything reading the requirement.
 *
 * **Several levers for one exit are a set only when the realm counts them**,
 * and `Requirement.actionsNeeded` is that count. `Needs 2 Actions` with two
 * levers is two levers to pull; a count smaller than the levers found, or no
 * count at all, names *alternatives* — the reported gate says `Door` and has a
 * lever in each Guardroom flanking it, and the wire settled which reading is
 * right: one pull raised it. `Levers.fetchLever` is where that is acted on.
 */
export interface RemoteLever {
  /** The room it is pulled in. Equal to the exit's own room for 171 of 225. */
  at: RoomId;
  /** That room's name, so the client can say where it is sending somebody. */
  roomName: string;
  /**
   * What to type. The realm's own spelling, which is what `say[0]` is
   * everywhere else a phrase is sent — the rest are synonyms for one lever.
   */
  say: string;
  /**
   * The `Items` row that must be carried to say it, where the realm names one
   * — `RequirementAction.item` on the other end of the same lever.
   *
   * Carried here as well because the exit's own requirement is not always
   * where a lever can be found: `buildRealm` writes `actions` only for an exit
   * that *states* `Needs N Actions`, and a `Door` never does. So the pricing
   * of a door a word opens (`WorldGraph.leveredCost`) reads this index, and it
   * has to be able to ask the same question `actionItemLacking` asks — todo
   * 13's lesson, which was a route planned through *hold up talisman* at the
   * cost of a free lever by a character with no talisman.
   */
  item?: number;
}

/** `map/room`, the key used everywhere. */
export type RoomId = string;

export function roomId(map: number, room: number): RoomId {
  return `${map}/${room}`;
}

/**
 * Where the character is, as an address, or null while it does not know.
 *
 * Null is not a room: a client that has not placed itself yet must not be
 * given the first map's first room by an unguarded `roomId(map ?? 0, …)`, and
 * everything that asks *from where* has to be able to hear *nowhere* and
 * answer with what it knows without one.
 */
export function roomAddress(room: { map: number | null; number: number | null }): RoomId | null {
  return room.map === null || room.number === null ? null : roomId(room.map, room.number);
}

/**
 * One move the character is *known* to have made: it stood in `from`, went
 * `direction`, and the room that came back was `to`.
 *
 * The trail these make up is the answer to *where did we come from*, and it is
 * kept by `CharacterTracker` because that is the only thing in the client that
 * knows. A room block resolving against a queued move expectation is the exact
 * moment the fact exists, and it exists there for **every** move whoever caused
 * it — a step the walker sent, a direction the player typed, a party follow,
 * a drag. Nothing else needs to be true.
 *
 * It used to be `Walker.recent` instead, appended only when the *walker*
 * confirmed a step of its own route, and that is a strictly smaller set in the
 * one situation the fact is wanted. Measured, and this type exists because of
 * it: `logs/2026-09-02_21-04-28_festus.mudcap.jsonl` t=418517, a loop replanned
 * the moment a fight ended and sent `n`; a giant bat re-opened combat 2ms
 * later, which stops the walk; the room arrived 1,244ms after that. The step
 * that actually moved the character was therefore never confirmed by the
 * walker and never recorded, the newest entry still pointed at the room it had
 * left, and the escape reported *no confirmed step to retrace from here* while
 * standing in a room it had walked into itself a minute earlier. Combat is
 * what stops a walk and combat is when a retreat is wanted, so the walker's
 * history is stale in precisely the case it was written for.
 *
 * A teleport records nothing: `sys go` and a portal arrive along no edge, so
 * they have no opposite to state and inventing one sends a character somewhere
 * it may not come back from.
 */
export interface TrailStep {
  from: RoomId;
  /** Canonical short, and always a real compass move — never a text exit. */
  direction: Direction;
  to: RoomId;
}

/*
 * There is deliberately no timestamp on a step.
 *
 * One was written and nothing read it. Age is not what makes a step worth
 * retracing — a room the character walked out of an hour ago is still one move
 * away if it is still standing where that move left it, which is the condition
 * `wayBackFrom` actually asks. A field nothing reads is a fact the client does
 * not have, and a clock nothing consults is an invitation to start guessing
 * with it.
 */

/**
 * A room named by its numbers rather than by its name.
 *
 * The realm keys every room on exactly this pair, the Room card's badge shows
 * it, and a player reading `1/2150` off that badge could not then type it
 * anywhere — the route panel's one field is a name query, so `1,2150` searched
 * for a room *called* that and found nothing.
 */
export interface RoomReference {
  map: number;
  room: number;
}

/**
 * Reads `1,2150`, `1 2150` or `1/2150` as the pair it looks like, or `null`.
 *
 * Parse, do not validate, in the manner of {@link asRoute}: the caller gets the
 * typed value or nothing, and cannot carry on with something merely checked.
 *
 * **Two integers and nothing else.** Strictness is the whole design here,
 * because the alternative to a reference is a *name search* over 55,806 rooms
 * and the two must never be ambiguous:
 *
 * - A bare `2150` is not a reference. It names no map, and a room name can be a
 *   number — `Level 3` is a name, and so is `2150` in a derivative that numbers
 *   its rooms. Silently reading it as a map would send somebody somewhere they
 *   did not ask for.
 * - One separator, not several: `1,,2150` and `1//2150` are typing mistakes,
 *   and a parser that shrugs at them is one that will accept `1/2150/3` next.
 * - Non-negative, and within what a number can hold exactly. A map id that has
 *   already lost precision is not the map anybody meant.
 */
export function asRoomReference(value: string): RoomReference | null {
  const match = /^(\d+)(?:\s*[,/]\s*|\s+)(\d+)$/.exec(value.trim());
  if (match === null) return null;
  const map = Number(match[1]);
  const room = Number(match[2]);
  if (!Number.isSafeInteger(map) || !Number.isSafeInteger(room)) return null;
  return { map, room };
}

/** One step of a route. */
export interface RouteStep {
  from: RoomId;
  to: RoomId;
  /**
   * The compass move this step takes — or `'portal'` for a room-script
   * teleport, which has no direction at all: the realm moves the character by
   * coordinates (`teleport <room> <map>`), not through an exit. Everything
   * that reasons about compass geometry — the retreat history's opposite, the
   * refused-edge key, resolving the arriving room by exit — must treat a
   * portal as its own thing, because a fabricated direction here would be
   * resolved against an exit that does not exist.
   */
  direction: Direction | 'portal';
  /** What to send. The direction, unless a `Text:` instruction overrides it. */
  command: string;
  /** Destination room name, for display. */
  name: string;
  /** Present when the step is gated; the UI shows why. */
  requirement: Requirement | null;
  /**
   * The same requirement in words, composed against the realm's item table.
   *
   * `requirement.kind` alone is what the route panel drew — `toll`, with the
   * price it charges sitting unread in the same object. A step is where a
   * player decides whether to walk it, so the number belongs on the step.
   * Absent exactly when `requirement` is null.
   */
  obstacle?: MapObstacle;
  /**
   * Whether the realm records the destination as dark.
   *
   * Carried on the step because the useful moment for it is **before** the
   * command goes out: a character one step from a dark room with a spent light
   * source can be told so while it can still do something about it, and the
   * client knows both halves — the realm names the room it is walking into and
   * the pack listing counts the pearl's charges. Afterwards it is only an
   * explanation for why nothing can be seen.
   *
   * False when the realm recorded no level, which is an ordinarily lit room.
   */
  dark: boolean;
  /**
   * The level itself, where the realm records one, because `dark` alone
   * cannot say whether a Gaunt One sees the room or whether a torch will
   * (`src/shared/light.ts`): −25 and −999 are both dark and only one of them
   * is worth a torch. Absent exactly when `dark` is false.
   */
  light?: number;
  /**
   * What one pass through the room's lair is expected to take from this
   * character, as a share of the health it had when the route was planned —
   * the figure the router priced the step by (`Traveller.danger`). Absent
   * where the room has no lair, or where nothing could be weighed: the sheet
   * unread, or a monster the arithmetic cannot price. One and above is
   * *expected to die there*, and the router walks such a room only when there
   * is no other way at all.
   */
  danger?: number;
  /**
   * Whether `danger` reached the share the router walls at
   * (`tuning.world.deadlyShare`), decided in main where the number lives. A
   * step wearing it is on a route with no other way.
   */
  deadly?: boolean;
  /**
   * The word from `movement.keepOutOf` this step crosses (todo 806) — into a
   * room whose name says it, or by a way whose script phrase does — as the
   * player wrote it. Set whether or not this walk may cross it, so the step
   * says so and a walk the player chose can cross it again after a redraw.
   */
  keptOut?: string;
  /**
   * Whether this step enters a lair the router could not weigh — an unread
   * bar, a monster its arithmetic cannot price — so what walking it costs is
   * unknown rather than nothing (todo 806). Absent where there is no lair or
   * it was weighed.
   */
  lairUnweighed?: true;
  /**
   * What that pass is expected to take in hit points — `danger` before the
   * division by the health the route was planned at. The walker's rest before
   * a trap reserves this much beyond the trap's damage; a share of a bar read
   * at planning time could not be turned back into points once the character
   * had healed. Absent with `danger`.
   */
  lairDamage?: number;
  /**
   * What one pass through the room's **own spell** is expected to take from
   * this character, as a share of the health it had when the route was
   * planned — the figure the router priced the step by
   * (`Traveller.hazard`). Absent where the room casts nothing, where the
   * chain reaches no harm, or where the pack already holds what stops it.
   *
   * Beside `danger` rather than folded into it because they are two different
   * facts about a room and a person can act on only one of them: a lair is
   * fought or avoided, and a room's spell is a *certainty* that an item in the
   * pack can turn off outright.
   */
  hazard?: number;
  /**
   * Why `hazard` is a discouragement rather than a figure: the chain could
   * not be followed, or it can summon something. A step wearing this draws
   * the word, not the share — `2%` beside a room whose spell nobody could
   * read was read as a lair figure (todo 01). Absent where the share is a
   * damage the realm states.
   */
  hazardKind?: 'unread' | 'summons';
  /**
   * The step that hands the character to a dice roll: after it, where they are
   * standing is not a fact anybody has.
   *
   * **A plan cannot continue through one, so this is always the last step.**
   * `to` is the room the journey is *for* rather than the room this move
   * reaches, because that is what the rest of the plan was priced against —
   * the arithmetic behind `moves` is `Router.scatterCosts`, and it prices
   * exactly *and then the client carries on from wherever you land*. The
   * walker reads it as permission to be surprised (`Walker.scattered`): an
   * arrival anywhere in `landing` is this step working, and the answer is to
   * plan again from there rather than to stop the walk.
   */
  scatter?: RouteScatter;
  /**
   * The item this step uses instead of moving, where the step is one.
   *
   * Present exactly on a step the router took through `WorldItem.lands`, whose
   * `direction` is `'portal'` for the reason every scripted teleport's is —
   * the realm moves the character by coordinates and no compass reasoning
   * applies. What this adds over a portal is **what it spends**: a corridor
   * costs nothing to walk twice and a potion is gone.
   */
  invoke?: RouteInvocation;
}

/**
 * One spell a route walks through, folded across every room that casts it.
 *
 * Said at the head of the plan rather than only on the steps, for the reason
 * the trap and lair counts are: a route of a hundred and four steps has its
 * summary off the top of the panel long before the reader reaches the rooms
 * that hurt. And the half that decides what to *do* is the last one — a
 * hundred rooms of the Silver River are a corridor if you fetch a log raft
 * first, and a wall of damage if you do not.
 */
/**
 * A step through a scatter, and what it is expected to cost.
 *
 * Both halves are needed to say the one sentence worth saying about a scatter
 * maze — *step west and expect about ten more moves before you are standing
 * there* — and neither half says it alone: the size is what makes the walk
 * random, and the figure is what makes it finite.
 */
export interface RouteScatter {
  /** The spell and the rooms it draws from. */
  landing: Landing;
  /** How many of those rooms the realm actually holds. */
  rooms: number;
  /**
   * Moves expected between stepping through and standing on the destination,
   * under the best play this client can find — the re-plans included, because
   * a re-plan is what the next move *is*. Rounded where it is said.
   *
   * **Moves, not what the router paid.** The search prices a draw in its own
   * units, so a lair in the maze goes into that figure — 19.7 against a
   * level-20 character where the walk is nine moves. The route's `cost` is
   * where the priced number belongs, and this is the one the reader is shown
   * (`Router.scatterMoves`).
   */
  moves: number;
}

/**
 * An item used to travel, and what using it spends.
 *
 * **An item can be a door** (`WorldItem.lands`, format 40) and until now only
 * `approachItems` read it: the potion of levitation casts a spell whose text
 * block is `teleport 1009 9`, no exit in either database enters the 173 rooms
 * behind it, and the router answered *the realm data joins no path* about a
 * quest the same client had just told the player how to finish. So a plan can
 * hold a step that is not a move at all — and the thing a reader has to know
 * before walking one is what it costs them **permanently**, because a charge
 * spent is not a charge the walk back has.
 *
 * `uses` is `Items.UseCount` as the realm states it, which is the column
 * format 25 exists to keep honest: the potion is 1 and every one of Paradigm's
 * seven tokens is 5.
 */
export interface RouteInvocation {
  /** The `Items` row, and the name to say. */
  id: number;
  name: string;
  /** What to type — `use potion of levitation`, the realm's own verb. */
  command: string;
  /**
   * **The room it is used in** — which is where the character is standing, and
   * the half of this step a plan otherwise never states.
   *
   * Every other row of a route reads *direction, then the room it reaches*, so
   * the destination alone is enough: the reader knows they are walking from
   * wherever the row above left them. A teleport breaks that reading — its
   * destination is on the row and its origin is nowhere, so the first thing on
   * a plan is a room the character is not in, and the plan looks like it
   * begins somewhere else. Reported exactly that way: *it is planning it from
   * a spot I am not in, where is the route TO that first step*. There is no
   * route to it; that is the point of it, and the plan has to say so.
   */
  at: { room: RoomId; name: string };
  /**
   * How many times it may be used in total, or null where the realm says *for
   * ever* (`UseCount: -1`).
   *
   * **The item's capacity, never the character's remainder.** The realm states
   * the first and only the pack listing states the second, so a reader is told
   * what a fresh one is worth and what is left comes off the wire — one is a
   * fact about the world and the other a fact about this character, and the
   * whole of `WorldItem` is the first kind.
   */
  uses: number | null;
}

export interface RouteHazard {
  /** The spell's own row, so a reader can ask the realm what stops it. */
  id: number;
  /** The realm's name for it — `river damage`, `swamp poison`. */
  spell: string;
  /** How many rooms on the way cast it. */
  rooms: number;
  /**
   * What one pass is expected to take as a share of the health the route was
   * planned at. Null where the chain reaches no figure — which is not zero:
   * such a room is priced as a discouragement and says so as `unread` — and
   * on `Route.carrying`, whose rooms are priced as if the item were carried.
   */
  share: number | null;
  /** Whether the reader is walking it because the chain could not be followed. */
  unread: boolean;
  /** Whether the spell can put a monster in the room. */
  summons: boolean;
  /** Whether it can move the character somewhere the exit table does not name. */
  relocates: boolean;
  /**
   * What would stop it, named, that the pack does not already hold — *carry
   * one of these and this stops happening*. Empty where the realm names
   * nothing, which is most of them.
   */
  needs: Array<{ id: number; name: string }>;
  /**
   * Spells that would stop it, named. Recorded and never evaluated
   * (`hazardAvoided`), so this is advice rather than a price.
   */
  needsSpell: string[];
  /**
   * Set where this is not a room's own spell but a passage the way *in* puts
   * on the character (todo 104): `rooms` is then the rooms under it on this
   * route, `share` null, and the chip says *run through*. See {@link Corridor}.
   */
  corridor?: { ends: boolean; ticks?: number; then?: string };
}

/**
 * The traps a route walks through, counted, and the worst of them.
 *
 * A trap is the one requirement on a route that is neither opened nor paid
 * nor refused — the route is priced through it (`edgePenalty` charges the
 * damage) and the character walks it and takes the hit. A route list forty
 * steps long says so on the step, where a reader scrolling to the `Walk it`
 * button never looks; the head of the list is where the count belongs, and
 * the number that decides whether to walk it is the heaviest one.
 *
 * `worst` is the largest stated damage, or null when no trap on the route
 * states one — the realm writes `Trap, 400 damage` for every one in the
 * shipped file, but a derivative may write a bare `Trap`, and a count with
 * no damage is still a count. Null is not zero: *up to 0 damage* would be a
 * reassuring number the data never gave.
 */
export function trapsAlong(steps: readonly RouteStep[]): { count: number; worst: number | null } {
  let count = 0;
  let worst: number | null = null;
  for (const step of steps) {
    const trap = trapOn(step);
    if (trap === null) continue;
    count += 1;
    if (trap.damage !== null && (worst === null || trap.damage > worst)) worst = trap.damage;
  }
  return { count, worst };
}

/**
 * The trap a step walks through, or null: the one requirement on a route that
 * is neither opened nor paid nor refused, and the one the walker rests before
 * (`Holds.holdForTrap`, `automation.health.restBeforeTraps`).
 *
 * A `Spell Trap:` exit counts too, and did not until its spell was read (todo
 * 00, 2026-09-06). It is a trap by the server's own reckoning —
 * `SpellTrapExit` lets everybody through and fires a spell at them — and it
 * carries the same `damage` field, taken from the realm's spell table rather
 * than the instruction string. Excluding it said *no traps on this route*
 * about a route through 21 exits that shoot poison darts. `damage` is null
 * where the realm states none, which is not zero.
 */
export function trapOn(step: Pick<RouteStep, 'requirement'>): { damage: number | null } | null {
  const gate = step.requirement;
  if (gate?.kind !== 'trap' && gate?.kind !== 'spell') return null;
  return { damage: gate.damage ?? null };
}

/**
 * The lairs a route walks through, counted, with the worst of them and
 * whether any is one the character is expected to die in.
 *
 * The same head-of-list rule `trapsAlong` keeps: a step's own chip sits under
 * the fold, and the figure that decides whether to walk is the heaviest.
 * `worst` is the largest share of maximum health any lair on the way is
 * expected to take (`RouteStep.danger`); `deadly` is whether one reached the
 * share the router walls at (`RouteStep.deadly`), which it walks only when
 * there is no other way — so a route that says so is a route with no
 * alternative, and the reader should know that before pressing the button.
 */
export function lairsAlong(steps: readonly RouteStep[]): {
  count: number;
  worst: number | null;
  /**
   * The room a pass is expected to kill the character in, named — not merely
   * *that* there is one.
   *
   * *One is expected to kill you* is unactionable without knowing which: a
   * route of a hundred and four steps has the deadly room somewhere in it and
   * the reader was left to scroll for a chip. Null where none is.
   */
  deadly: { room: RoomId; name: string } | null;
} {
  let count = 0;
  let worst: number | null = null;
  let deadly: { room: RoomId; name: string } | null = null;
  for (const step of steps) {
    // The first, in walking order: it is the one that stops the walk, and a
    // later one is a room the character never reaches. By lair or by the
    // room's own spell — `deadly` is set from either, and a room whose spell
    // takes the whole bar has no `danger` to be counted under.
    if (step.deadly === true && deadly === null) deadly = { room: step.to, name: step.name };
    if (step.danger === undefined) continue;
    count += 1;
    if (worst === null || step.danger > worst) worst = step.danger;
  }
  return { count, worst, deadly };
}

/**
 * Why a route could not be walked — the condition, not a sentence about it.
 *
 * A blocked route used to carry one line of free text: *No route from … that
 * this character can walk*. Everything needed to say better was known at the
 * moment of the refusal and thrown away — `edgePenalty` knows the requirement
 * and its numbers, and collapses all of them to the same `null`. The asymmetry
 * was the tell: a **successful** route already carries `RouteStep.requirement`
 * per step and renders it, and a failed one carried nothing.
 *
 * **Accumulated, never first-match-wins**, on the model of `HangUp`'s
 * `{safe, reasons[]}`: a route can be stopped by a level gate *and* a locked
 * door, and naming one hides the other — so somebody clears the first and is
 * refused again by a condition that was there all along.
 *
 * What bounds this union is the set of conditions the realm states *and* the
 * character cannot change by doing anything on the way: a lock with no key and
 * no skill the realm accepts instead, a level gate, a toll with nothing to pay
 * it, and the three the character simply **is** — its class, its race and its
 * standing. Everything else is *expensive* rather than impossible, because a
 * route through a trap is better than no route and the player can see the
 * requirement and judge.
 *
 * The three born conditions arrived late, and the class one arrived without a
 * block at all: `edgePenalty` learned to prune a class-gated exit (todo 03,
 * 2026-09-06) and this union did not learn to say so, so the route that took
 * the trouble to prune said *the two rooms are not joined in the data*. That
 * is why the agreement test now walks `REQUIREMENT_KINDS` rather than a list
 * somebody has to remember to extend.
 */
export type RouteBlock =
  | {
      kind: 'key';
      /** The room the way out of is shut. */
      at: RoomId;
      to: RoomId;
      /** Where it leads, named, because a room id is not something to act on. */
      name: string;
      /** `Key: 1124` — the item number, for a surface that wants the id. */
      keyId?: number;
      /**
       * What it is called, looked up before the block was built.
       *
       * `describeObstacle`'s own header settled this for the chip: *naming a
       * key means looking it up — `Key: 1124` is not something anyone can do
       * anything with*. The route's own sentence said `key 1124` for a year
       * after that, because `describeBlock` is in `src/shared` and has no
       * realm to ask; `blocksAlong` has one, so the name is put on the block
       * where the graph is rather than looked for where it is not.
       */
      itemName?: string;
    }
  | {
      kind: 'level';
      at: RoomId;
      to: RoomId;
      name: string;
      /** What the character is, or null while the stat sheet has not arrived. */
      level: number | null;
      minLevel?: number;
      maxLevel?: number;
    }
  | {
      kind: 'toll';
      at: RoomId;
      to: RoomId;
      name: string;
      /**
       * What the gate charges and what the purse holds, both in copper.
       *
       * The number that was not met is the whole of what somebody can act on —
       * the rule the level block already follows. This said *"you have nothing
       * to pay it with"* for every toll, which was the only thing it could say
       * while the price went unread, and was simply wrong for a character with
       * money that was merely not enough.
       *
       * Both are optional because both can be genuinely unknown: a gate whose
       * price the realm did not record, and a purse no listing has stated.
       */
      tollCopper?: number;
      purseCopper?: number;
    }
  | {
      /**
       * Something the exit wants in the pack, that the pack does not hold.
       *
       * `Item: 191` — `rope and grapple`, on 157 of the shipped realm's exits.
       * Its own kind rather than a second `key`, because the two are different
       * things to be told: a lock may yield to a picklock and this never does,
       * and *go and buy a rope* is a different errand from *go and find the
       * key*.
       *
       * Only ever built once a listing has landed. A pack nobody has looked in
       * does not block, so this block always means *it is not in there* rather
       * than *nobody knows*.
       */
      kind: 'carry';
      at: RoomId;
      to: RoomId;
      name: string;
      itemId?: number;
      itemName?: string;
    }
  | {
      /**
       * What the character is, against what the exit admits — one shape for
       * the three the realm decides at creation and nothing on the route can
       * change.
       *
       * `mine` is the row id or word the character carries and is null while
       * nobody has read a stat sheet or a roster, which cannot itself block:
       * an unknown class, race or standing is discouraged and never pruned, so
       * a block of this kind always names something the realm said no to.
       * `admits` and `refuses` are whichever half the instruction stated —
       * `Class: 3 OK, 0 NO` states one of each and drops the zero, and an
       * alignment window states both ends.
       */
      kind: 'born';
      at: RoomId;
      to: RoomId;
      name: string;
      /** Which of the three: the word a sentence puts in front of the numbers. */
      condition: 'class' | 'race' | 'alignment';
      mine: string | number | null;
      /**
       * What the exit lets through — a `Classes`/`Races` row id for the first
       * two, and for a standing the **window as one phrase** (`Saint to
       * Seedy`), because that is one fact with two ends and handing over the
       * ends would make the sentence reassemble them.
       */
      admits?: string | number;
      /** What it turns away. Class and race only; a standing states no such half. */
      refuses?: string | number;
    }
  | {
      /**
       * A barrier the realm lets a skill force, met by a character below every
       * skill it names. `edgePenalty` prices it as a wall rather than pruning
       * it, so the router walks it when nothing else leads there — which is
       * exactly when the head of the plan has to say so, because the walker
       * will stop at it. `keyId`/`itemName` when a key opens it as well.
       */
      kind: 'door';
      at: RoomId;
      to: RoomId;
      name: string;
      pickDifficulty?: number;
      bashDifficulty?: number;
      /** Null while the sheet is unread; never zero standing in for unknown. */
      picklocks: number | null;
      strength: number | null;
      /**
       * The skills this door names that the walker is switched off from using
       * (*Auto-Pick Locks*, *Auto-Bash Doors*), said as a setting, because a
       * figure well over the door's reads as a contradiction.
       */
      switchedOff?: Array<'picklocks' | 'strength'>;
      keyId?: number;
      itemName?: string;
      /**
       * A word said in the room the step leaves from that opens it, where the
       * realm names one, and the item it wants.
       *
       * A door's lever is not on the door — `buildRealm` writes
       * `Requirement.actions` only for an exit that states `Needs N Actions`
       * — so this is the lever index joined at the step
       * (`WorldGraph.leversHere`), and it is carried here because the block is
       * what the panel's headline is written from. Without it the head of the
       * plan said *needs 1000 picklocks; your picklocks are not known yet*
       * while the chip on that same row said *"use crowbar" here*: two
       * errands for one door, which is the disagreement `openableHere` exists
       * to prevent one kind across.
       */
      opensBySaying?: string;
      opensItemName?: string;
    }
  | {
      /**
       * A quest counter the exit wants, against what `abil` said this
       * character holds.
       *
       * Its own kind rather than a `born`: a standing or a race is what the
       * realm decided at creation and nothing on the route can change, and
       * this is the one gate on an exit that a player can go away and *open* —
       * which makes the counter's own name and the window the whole of what
       * there is to act on.
       *
       * Only ever built once a listing has landed, for the reason `carry` is:
       * before one, nobody has said, and nobody having said never blocks. So
       * `held` is a number the realm stated rather than a guess, and it is
       * zero where a **complete** listing did not name the counter at all.
       */
      kind: 'quest';
      at: RoomId;
      to: RoomId;
      name: string;
      abilityId: number;
      /** The realm's own word for the counter, where the enum knows one. */
      counterName?: string;
      held: number;
      atLeast?: number;
      atMost?: number;
    }
  | {
      /**
       * A way or a place `movement.keepOutOf` keeps walks out of (todo 806),
       * on the only way there. `word` is the list's own, as the player wrote
       * it, because that is what they would change.
       */
      kind: 'keptOut';
      at: RoomId;
      to: RoomId;
      name: string;
      word: string;
    }
  /** No path at all, gates ignored: the two rooms are not joined in the data. */
  | { kind: 'unreachable' };

/**
 * The kinds, as a list.
 *
 * A closed union has two halves and they move together: this is the half
 * `describeBlock` is checked against, so a kind added to the type and not
 * described is a failing test rather than a route that refuses in silence.
 */
export const ROUTE_BLOCK_KINDS = [
  'key',
  'level',
  'toll',
  'carry',
  'born',
  'quest',
  'door',
  'keptOut',
  'unreachable'
] as const;

/**
 * One block as a sentence, naming the condition and the number it wanted.
 *
 * *Level 12 needed, at level 9* rather than *this character cannot walk it*:
 * the number that was not met is the whole of what somebody can act on.
 */
/**
 * A copper figure as the realm would say it, for one sentence.
 *
 * Deliberately **not** in `coins.ts`, which states outright that it converts
 * only to compare and never for display — the counter's own words are what a
 * shop row shows. A toll has no counter to quote: the price comes from the
 * realm database as a bare number, so this sentence is the only place it can be
 * put into words at all, and the words it uses are the server's own (`5 gold
 * crowns` on the wire for the gate recording `Toll: 5`).
 *
 * Whole gold where it divides evenly, which every toll in the shipped realm
 * does, and copper otherwise — never a fraction of a coin nobody can hold.
 */
function coinWords(copper: number): string {
  if (copper === 0) return 'nothing';
  if (copper % COPPER_PER_GOLD === 0) {
    const gold = copper / COPPER_PER_GOLD;
    return `${gold.toLocaleString()} gold`;
  }
  return `${copper.toLocaleString()} copper`;
}

/** The rung `coinWords` reads against. `coins.ts` owns the ladder itself. */
const COPPER_PER_GOLD = 100;

export function describeBlock(block: RouteBlock): string {
  switch (block.kind) {
    case 'key':
      /*
       * The name where there is one, and the number only where there is not:
       * *the angular key, which you do not have* is an errand, and *key 1124*
       * is a number somebody has to go and look up themselves.
       */
      if (block.itemName !== undefined) {
        return `${block.name} is locked — needs ${block.itemName}, which you do not have`;
      }
      return block.keyId === undefined
        ? `${block.name} is locked, and nothing you carry opens it`
        : `${block.name} is locked — key ${block.keyId}, which you do not have`;

    case 'carry': {
      const what = block.itemName ?? (block.itemId === undefined ? null : `item ${block.itemId}`);
      return what === null
        ? `${block.name} needs something you are not carrying`
        : `${block.name} needs ${what}, which you are not carrying`;
    }
    case 'level': {
      const at =
        block.level === null ? 'and your level is not known yet' : `at level ${block.level}`;
      if (block.minLevel !== undefined && block.maxLevel !== undefined) {
        return `${block.name} admits levels ${block.minLevel}–${block.maxLevel}, ${at}`;
      }
      if (block.minLevel !== undefined) {
        return `${block.name} needs level ${block.minLevel}, ${at}`;
      }
      if (block.maxLevel !== undefined) {
        return `${block.name} is for levels up to ${block.maxLevel}, ${at}`;
      }
      return `${block.name} has a level gate you do not meet`;
    }
    case 'toll': {
      if (block.tollCopper === undefined) {
        return `${block.name} charges a toll, and you have nothing to pay it with`;
      }
      const price = coinWords(block.tollCopper);
      // The shortfall, when both numbers are known: "5 gold, and you have 2" is
      // something to act on in a way that "you cannot afford it" is not.
      return block.purseCopper === undefined
        ? `${block.name} charges a toll of ${price}`
        : `${block.name} charges a toll of ${price}, and you have ${coinWords(block.purseCopper)}`;
    }
    case 'born': {
      /*
       * The three the character *is*, in one sentence each. `mine` is never
       * null here — an unknown class, race or standing is discouraged rather
       * than pruned, so nothing unknown reaches this — but it is typed
       * nullable because the traveller's field is, and a sentence that
       * asserted a value it did not have would be exactly the confident wrong
       * answer the router refuses everywhere else.
       */
      const mine = block.mine === null ? 'yours is not known yet' : `yours is ${block.mine}`;
      if (block.condition === 'alignment') {
        // The window arrives already written — `Saint to Seedy` — because it
        // is one fact with two ends, and splitting it here would make this
        // sentence reassemble what `instructions.ts` took apart.
        return block.admits === undefined
          ? `${block.name} has a standing gate you do not meet, and ${mine}`
          : `${block.name} admits ${block.admits}, and ${mine}`;
      }
      /*
       * The condition's word only where the value is a bare number — *admits
       * Gaunt One only* reads as English and *admits Gaunt One race only* does
       * not, while *admits race 13 only* is the least this can say when the
       * realm's table does not hold the row.
       */
      const say = (value: string | number): string =>
        typeof value === 'number' ? `${block.condition} ${value}` : value;
      if (block.refuses !== undefined && block.admits === undefined) {
        return `${block.name} turns away ${say(block.refuses)}, and ${mine}`;
      }
      return block.admits === undefined
        ? `${block.name} has a ${block.condition} gate you do not meet, and ${mine}`
        : `${block.name} admits ${say(block.admits)} only, and ${mine}`;
    }
    case 'quest': {
      /*
       * The counter and what it wants, then what the character holds — the
       * level block's rule, because the number that was not met is the whole
       * of what somebody can act on. The realm's own word for the counter
       * where the enum has one, and the id where it does not: `GuildmasterQuest`
       * is an errand and `ability 204` is a number to go and look up, but both
       * beat *you may not go that way*.
       */
      const what = block.counterName ?? `ability ${block.abilityId}`;
      const wants =
        block.atLeast !== undefined && block.atMost !== undefined
          ? block.atLeast === block.atMost
            ? `exactly ${block.atLeast}`
            : `${block.atLeast}–${block.atMost}`
          : block.atLeast !== undefined
            ? `at least ${block.atLeast}`
            : block.atMost !== undefined
              ? `at most ${block.atMost}`
              : null;
      return wants === null
        ? `${block.name} wants ${what}, and yours is ${block.held}`
        : `${block.name} wants ${what} ${wants}, and yours is ${block.held}`;
    }
    case 'door': {
      /*
       * What opens it, every channel the realm named, then what the character
       * has on each — so *needs black serpent key or 81 picklocks; you have 0
       * picklocks* is an errand with two ways to run it. A skill the sheet has
       * not stated is said to be unknown, never printed as zero.
       */
      /*
       * A word that opens it is the answer, and the skills are then only what
       * the other way in would cost — so it leads, and the rest follows it.
       */
      if (block.opensBySaying !== undefined) {
        const needs = block.opensItemName === undefined ? '' : `, carrying ${block.opensItemName}`;
        return `${block.name} is locked — say "${block.opensBySaying}" here${needs}`;
      }
      const opens: string[] = [];
      if (block.itemName !== undefined) opens.push(block.itemName);
      else if (block.keyId !== undefined) opens.push(`key ${block.keyId}`);
      if (block.pickDifficulty !== undefined) opens.push(`${block.pickDifficulty} picklocks`);
      if (block.bashDifficulty !== undefined) opens.push(`${block.bashDifficulty} strength`);
      const have: string[] = [];
      const unread: string[] = [];
      if (block.pickDifficulty !== undefined) {
        if (block.picklocks === null) unread.push('picklocks');
        else have.push(`${block.picklocks} picklocks`);
      }
      if (block.bashDifficulty !== undefined) {
        if (block.strength === null) unread.push('strength');
        else have.push(`${block.strength} strength`);
      }
      const off = (block.switchedOff ?? []).map((skill) =>
        skill === 'picklocks' ? 'picking locks' : 'bashing doors'
      );
      const mine = [
        have.length > 0 ? `you have ${have.join(' and ')}` : null,
        unread.length > 0
          ? `your ${unread.join(' and ')} ${unread.length === 1 ? 'is' : 'are'} not known yet`
          : null,
        off.length > 0
          ? `${off.join(' and ')} ${off.length === 1 ? 'is' : 'are'} switched off`
          : null
      ]
        .filter((part) => part !== null)
        .join(', ');
      return `${block.name} is locked — needs ${opens.join(' or ')}; ${mine}`;
    }
    case 'keptOut':
      return `${block.name} is kept out of — "${block.word}" is on your Keep Out Of list`;
    case 'unreachable':
      return 'No way there at all — the realm data joins no path between the two';
  }
}

/**
 * The item a block wants in the pack, where it names one by both halves.
 *
 * Three of the seven kinds name an item; the rest are a level, a toll, what
 * the character was born as, or no way at all — none of them an errand. **Both
 * halves or nothing**: the errand looks a source up by number and counts the
 * pack by name, so a block stating one without the other is a refusal waiting
 * to happen rather than something to offer to go and fetch.
 */
export function blockItem(block: RouteBlock): { id: number; name: string } | null {
  switch (block.kind) {
    // A lock, and a door a key opens as well as a picklock forces.
    case 'key':
    case 'door':
      return block.keyId === undefined || block.itemName === undefined
        ? null
        : { id: block.keyId, name: block.itemName };
    case 'carry':
      return block.itemId === undefined || block.itemName === undefined
        ? null
        : { id: block.itemId, name: block.itemName };
    case 'level':
    case 'toll':
    case 'born':
    case 'quest':
    case 'keptOut':
    case 'unreachable':
      return null;
  }
}

export interface Route {
  steps: RouteStep[];
  /** Total A* cost, not step count: a door costs more than a corridor. */
  cost: number;
  /** True when no path exists under the current constraints. */
  blocked: boolean;
  /** Why, when blocked. */
  reason?: string;
  /**
   * What stood in the way — every condition, not the first.
   *
   * `reason` stays a sentence so nothing that already reads it has to change;
   * this is the same answer as facts, for a surface that wants to say more than
   * one line or to look a key's name up. On a refused route it is why. On a
   * walkable route that crosses a wall — a door the character cannot force, a
   * lair expected to kill — it is what the shorter way needed, so the reader
   * is told *needs amber talisman* rather than handed four hundred steps
   * through doors that will not open.
   */
  blocks?: RouteBlock[];
  /**
   * What this way itself crosses that the character cannot pass: a door below
   * both skills the realm accepts, walked because nothing else leads there; on
   * a way round, the key it wants instead of the death it avoids. Distinct
   * from `blocks`, which on a walkable plan is what the *cheaper* way needed.
   * The head says it before the steps, because the walker will stop there.
   */
  walls?: RouteBlock[];
  /**
   * What the rooms on the way do to whoever walks through them, folded per
   * spell. See {@link RouteHazard}. Absent where nothing on the route casts
   * anything the reader would want to know about.
   */
  hazards?: RouteHazard[];
  /**
   * A way round the worst of this one, where there is one.
   *
   * *There is no other way* was said off the price of a single search: the
   * router walls a deadly lair rather than pruning it, so such a room is
   * simply an expensive option the best route happened to include — and the
   * client asserted an absolute from a relative result. This is the search
   * that makes the sentence checkable: the rooms that priced the best route
   * badly are excluded and the question asked again. Absent means it was
   * asked and there is genuinely none, or that there was nothing bad enough
   * to ask about — or that the route was not planned for a reader
   * (`RouteOptions.alternatives`): a loop's leg pays for no second search.
   */
  otherWay?: Route;
  /**
   * The way this character would take carrying what stops the rooms on it,
   * where that is materially shorter than the plan — the river with a log
   * raft against the slums without one. Its `hazards[].needs` name what to
   * fetch. Absent where nothing an item would quieten shortens the way by
   * `tuning.world.alternativeMinSteps`, and on any route not planned for a
   * reader (`RouteOptions.alternatives`).
   */
  carrying?: Route;
  /**
   * The way this character would take by **using an item that teleports**,
   * where that is materially shorter than walking.
   *
   * Off by default and offered rather than planned, which is the difference
   * between the two kinds of landing the realms actually hold. The potion of
   * levitation is the only entrance the Catacombs have, so a route there is
   * simply impossible without it and the plain search walks it as the last
   * resort it is — the same rung `RouteOptions.alternatives` does not gate,
   * because a way that does not exist is not an alternative. Paradigm's seven
   * tokens are the other kind: every one of them lands on a room the character
   * could walk to, so taking one is a *choice* that costs a charge, and a
   * router that spent one unasked would quietly burn five recalls on a walk
   * the player would have made on foot.
   *
   * Its steps' `invoke` names what would be spent. Absent where no landing
   * shortens the way by `tuning.world.alternativeMinSteps`, where the plan
   * already uses one, and on any route not planned for a reader.
   */
  viaItem?: Route;
  /**
   * A way that is **materially different** from the plan, where one exists —
   * the third alternative, and the one asked for by name and over again:
   * *other ways of getting there if it differs by more than a few rooms*.
   *
   * The other three are defined by what they assume — a room avoided, an
   * item carried, a charge spent. This one is defined by what it *is not*:
   * the plan's own edges are priced `tuning.world.anotherWayPenalty` times
   * over and the search asked again, so it leaves the plan wherever a detour
   * costs less than that much of what it replaces. Offered when at least
   * `alternativeMinSteps` of its rooms are not on the plan and it is no more
   * than `anotherWayLonger` longer; never walled, never deadly, and never for
   * a plan that is itself walled or deadly, which `otherWay` already asks
   * round. Its `cost` is the honest one, priced without the penalty. Absent
   * on any route not planned for a reader.
   */
  another?: Route;
  /**
   * The way through a door this character holds no key for, planned as
   * though it did (todo 805) — where fetching the key and walking through
   * beats the way round by `tuning.world.alternativeMinSteps`, the fetch
   * priced in (`Router.keyedWay`). On a refused route, the way the pack
   * would open once it held what refused it. Its `needs` names what to fetch;
   * the errand fetches them before it is walked. Absent on any route not
   * planned for a reader.
   */
  unlocks?: Route;
  /**
   * What this way assumes is in the pack and is not — set on an `unlocks`
   * route only. Walking it without them walks into a locked door, so the
   * press that walks it collects them first (`itemsWanted`).
   */
  needs?: Array<{ id: number; name: string }>;
  /**
   * What this way crosses that `movement.keepOutOf` names, and the way round
   * it (todo 806) — set on a route planned for a reader whose way through
   * crosses a word this walk may not. The two are offered side by side and
   * the player picks one; nothing walks until they have. `round` is refused
   * where there is no way round.
   */
  keptOut?: { words: string[]; round: Route };
}

/**
 * What a route asks of whoever walks it, keyed so two plans can be compared.
 *
 * *The same journey* is not *the same steps*: a plan redrawn from a room two
 * corridors along is a different list of rooms and usually the same walk, and
 * what makes it a **different** one is what it now asks for — a key, a level,
 * a toll, a door nobody here can force, an item a river wants. That is the
 * question `SessionManager.walkPlan` puts to a plan the character has wandered
 * off the start of, and a set is the honest shape for it: a route asks for
 * several things and naming one hides the rest, which is `RouteBlock`'s own
 * rule one layer up.
 *
 * Keyed on the realm's instruction verbatim rather than on the room it is
 * written in, because two locked doors wanting the same key are one errand.
 * The value is the chip's own words, so a sentence built from this says what
 * the panel's steps say.
 */
export function demandsOf(route: Route): Map<string, string> {
  const demands = new Map<string, string>();
  for (const step of route.steps) {
    const requirement = step.requirement;
    if (requirement === null) continue;
    demands.set(`${requirement.kind}|${requirement.raw}`, step.obstacle?.label ?? requirement.kind);
  }
  // A wall is a requirement this character does not meet, so it is the half of
  // this most worth saying — and `walls` is what *this* plan crosses, never
  // what a cheaper way needed (`blocks`), which nobody is being offered.
  for (const wall of route.walls ?? []) {
    demands.set(`wall|${describeBlock(wall)}`, describeBlock(wall));
  }
  // And what a room's own spell wants carried: the `items` half of the
  // question, and the one thing on a plan that names an errand outright.
  for (const hazard of route.hazards ?? []) {
    for (const need of hazard.needs) demands.set(`needs|${need.id}`, need.name);
  }
  return demands;
}

/**
 * The one item an edge demands be carried, or null where it demands none.
 *
 * Two of the realm's columns state one, and from *is this thing in the pack*
 * they are the same fact: `Key: 1124` is a lock and `Item: 191` a hidden
 * exit's own action, which is `Requirement.keyId`'s own reading one layer up.
 * A hidden exit states it on the action rather than on the requirement, so
 * both are looked at, the requirement first.
 *
 * One, and the first: an exit wanting two items is a shape neither shipped
 * realm writes, and inventing an answer for it is the guess this file refuses.
 */
export function itemDemanded(requirement: Requirement | null): number | null {
  if (requirement === null) return null;
  if (requirement.keyId !== undefined) return requirement.keyId;
  for (const action of requirement.actions ?? []) {
    if (action.item !== undefined) return action.item;
  }
  return null;
}

/** The most items one collect-then-walk may name: a payload bound, for IPC. */
export const COLLECT_ITEMS_MAX = 16;

/**
 * Everything this way asks for, to go and fetch before walking it — each item
 * once, in the order the errand fetches them.
 *
 * **What this plan crosses before what its rooms cast**: a door the walker
 * will stop dead at outranks a spell that only hurts on the way past. `walls`
 * and never `blocks`, by `demandsOf`'s own rule — `blocks` on a walkable plan
 * is what a *cheaper* way needed, which is a different route and so a
 * different errand, and that way is offered as `carrying` where there is one.
 *
 * **All of them, not the first** (2026-09-23, todo 804): a way through three
 * keyed doors fetched the first key and walked into the second door.
 */
export function itemsWanted(route: Route): Array<{ id: number; name: string }> {
  const wanted = new Map<number, { id: number; name: string }>();
  const add = (item: { id: number; name: string } | null): void => {
    if (item !== null && !wanted.has(item.id))
      wanted.set(item.id, { id: item.id, name: item.name });
  };
  for (const item of needsAlong(route)) add(item);
  for (const wall of route.walls ?? []) add(blockItem(wall));
  /*
   * A room spell's `needs` are **alternatives** — any one of them stops it
   * (`hazardAvoided`): the river's log raft, skiff, canoe and punt. So one per
   * spell, the first, and none where another spell's pick already stops it.
   */
  for (const hazard of route.hazards ?? []) {
    if (hazard.needs.some((item) => wanted.has(item.id))) continue;
    add(hazard.needs[0] ?? null);
  }
  return [...wanted.values()];
}

/**
 * What a way planned as though the pack held it (`Route.needs`) wants for a
 * door among **its own** steps: a prefix of that way (*Walk here*) that stops
 * short of the door wants nothing for it. Required, where `itemsWanted`'s
 * walls and spells are the reader's to tick.
 */
export function needsAlong(route: Route): Array<{ id: number; name: string }> {
  const demanded = new Set(route.steps.map((step) => itemDemanded(step.requirement)));
  return (route.needs ?? []).filter((item) => demanded.has(item.id));
}

/**
 * The way the player picked, with the choice taken off it (todo 806): main
 * walks no route still carrying `keptOut`, since that is a choice nobody made.
 */
export function chosenWay(route: Route): Route {
  if (route.keptOut === undefined) return route;
  const way = { ...route };
  delete way.keptOut;
  return way;
}

/**
 * The `movement.keepOutOf` words this way crosses, each once (todo 806) —
 * what a walk the player chose may cross again when it is planned afresh.
 */
export function crossedWords(route: Route): string[] {
  return [
    ...new Set(route.steps.flatMap((step) => (step.keptOut === undefined ? [] : [step.keptOut])))
  ];
}

/**
 * What `after` asks that `before` did not, in the panel's own words.
 *
 * Only ever asked one way round. A redrawn plan that wants *less* than the one
 * the reader agreed to is the same journey made easier, and stopping to ask
 * about it would be the client arguing with a piece of luck.
 */
export function newDemands(before: Route, after: Route): string[] {
  const had = demandsOf(before);
  const words: string[] = [];
  for (const [key, label] of demandsOf(after)) if (!had.has(key)) words.push(label);
  return words;
}

/**
 * A loop or route being built by hand on the map, planned as far as it goes.
 *
 * The builder's picks are rooms clicked in order; every pair is planned by
 * the same `WorldGraph.route` a person's route and a loop's leg use, so what
 * is drawn is what would be walked. `legs` is one route per pair, in order,
 * and the first blocked one ends the plan — the picks after it are not
 * planned, because a route on from a room the character cannot reach is a
 * picture of nothing.
 *
 * `path` is every room of every planned leg, opening with the first pick, so
 * the map can draw the whole way regardless of which rooms turn out to be
 * waypoints. `waypoints` is the fewest of those rooms whose routes reproduce
 * `path` exactly — the same reduction `npm run build:loops` applies to
 * MegaMUD's recorded paths — because a loop here is a list of *places*, and
 * a pick in the middle of a corridor the planner would walk anyway is a
 * place nobody chose. Named, because a stop is written down by name with its
 * coordinates behind it (`Town Gates 1/2150`).
 */
export interface LoopDraft {
  legs: LoopDraftLeg[];
  path: RoomId[];
  waypoints: LoopDraftWaypoint[];
}

export interface LoopDraftLeg {
  from: RoomId;
  to: RoomId;
  route: Route;
}

export interface LoopDraftWaypoint {
  id: RoomId;
  name: string;
}

/** Nothing picked yet. A constant, so an empty draft is one value everywhere. */
export const EMPTY_LOOP_DRAFT: LoopDraft = { legs: [], path: [], waypoints: [] };

/**
 * Narrows a list of room ids that crossed the bridge, or rejects it.
 *
 * The builder sends its picks to main to be planned, and each one names a
 * room to run a search from — so an entry that is not a `map/room` pair is
 * refused rather than skipped (skipping would plan a different loop from the
 * one on screen), and the list is bounded because every room on the way is
 * one A* pass on the main process's own thread. Parse, do not validate: the
 * typed list or `null`.
 */
export function asRoomIds(value: unknown, limit: number): RoomId[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  const ids: RoomId[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    const reference = asRoomReference(entry);
    if (reference === null) return null;
    ids.push(roomId(reference.map, reference.room));
  }
  return ids;
}

/**
 * Narrows a payload that crossed the bridge into a `Route`, or rejects it.
 *
 * Parse, do not validate: this returns the typed value or `null`, so a caller
 * cannot accidentally carry on with something merely "checked".
 *
 * A route is the one payload a window sends that *drives commands to the
 * socket*, which makes it the one that most deserves zero-trust intake. It is
 * also structural rather than scalar, so a malformed one does not fail at the
 * boundary — it fails several frames later inside the walker, where the stack
 * says nothing about where it came from.
 */
export function asRoute(value: unknown): Route | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<Route>;

  if (typeof candidate.blocked !== 'boolean') return null;
  if (typeof candidate.cost !== 'number' || !Number.isFinite(candidate.cost)) return null;
  if (!Array.isArray(candidate.steps)) return null;

  for (const step of candidate.steps) {
    if (typeof step !== 'object' || step === null) return null;
    const entry = step as Partial<RouteStep>;
    if (typeof entry.command !== 'string' || entry.command.length === 0) return null;
    if (typeof entry.from !== 'string' || typeof entry.to !== 'string') return null;
    if (typeof entry.name !== 'string') return null;
  }

  return candidate as Route;
}
