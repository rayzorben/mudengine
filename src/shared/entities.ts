/**
 * Everything is an entity.
 *
 * The rule: nothing parsed off the wire is passed around as a bare string.
 * `items: string[]` and `attackers: string[]` were the shape that made every
 * consumer re-derive the same facts from a name — the Room card asked main
 * over IPC what the realm knew about each floor item, `AutoLoot` matched names
 * by prefix and could not ask what anything weighed, and `AutoCombat` could
 * not say *this monster has 400 hit points* about a target it was already
 * fighting. An entity carries the answer once, resolved where the realm data
 * lives, so a card renders and an automation decides without asking anybody.
 *
 * ## The dual-source rule
 *
 * **A realm that does not name something must still produce a whole entity.**
 * A derivative realm, an uncatalogued monster, a player-renamed item, a
 * session with no realm file at all: every one of those is ordinary, and an
 * entity that only existed when the database knew about it would make the
 * client worse on exactly the realms that need it most. So:
 *
 * - `source` says where the entity came from: `wire` (parsed, nothing looked
 *   it up), `mdb` (the realm's row, nothing observed), or `hybrid` (both).
 * - **Every realm-derived field is optional.** Absent means *the realm does
 *   not say*, and never zero — the same rule `CharacterState` follows.
 * - The wire's facts are never overwritten by the realm's. The listing's
 *   spelling, the annotation it carried and the slot it named are what the
 *   server actually printed, and where the two disagree the wire wins.
 *
 * ## Where these are built
 *
 * In **main**, at the point a block is parsed, by `WorldGraph`'s
 * `buildItemEntity` / `buildMobEntity` / `buildNpcEntity` / `buildExitEntities`
 * — never in the renderer. That is what lets the UI drop its lazy IPC round
 * trips: the state pushed to a window already carries the whole graph, so a
 * card reads it the way it reads a name.
 *
 * Dependency-free like everything in `src/shared/`, and its imports are
 * **type-only** — a type-only cycle is erased and harmless where a value cycle
 * is not (see the module-cycle rule in `CLAUDE.md`).
 */
import type { Alignment } from './alignment';
import type { ItemKind } from './items';
import type { AlignmentCost, MobDisposition } from './mobs';
import type {
  MapObstacle,
  MobProfile,
  MobRowChoice,
  Requirement,
  RoomCommand,
  WorldClass,
  WorldLair,
  WorldRace,
  WorldShop,
  WorldSpell
} from './world';
import type { RoomCandidate, RoomLight } from './character';

/**
 * Where an entity's facts came from.
 *
 * Three values rather than a boolean because the two absences are different
 * questions: `wire` is *the realm has nothing for this*, which on a derivative
 * realm is the ordinary case and never an error, while `mdb` is a row nothing
 * has been observed about — a shop's stock, a lair's roster, a drop table.
 */
export type EntitySource = 'mdb' | 'wire' | 'hybrid';

/**
 * Coins, wherever they are counted: on the floor, in the pack, in a vault, or
 * demanded as a toll.
 *
 * One shape for all four because the arithmetic is the same and was written
 * four times. `totalCopper` is the normalised figure the ladder in
 * `./coins.ts` produces — the ladder the server's own `Wealth:` line was
 * measured against eight times — and is what a threshold compares.
 *
 * Counts are numbers rather than `number | null` here because a
 * `CurrencyEntity` is only ever built from something that *enumerated* the
 * coins: a listing, a drop line, a vault statement. Absence of the entity
 * itself is how "nobody has said" is expressed — see `RoomEntity.cash`, which
 * is null until something states it. That is deliberately unlike
 * `Inventory.coins`, which must distinguish an unlisted denomination from an
 * empty one and therefore keeps nulls.
 */
export interface CurrencyEntity {
  runic: number;
  platinum: number;
  gold: number;
  silver: number;
  copper: number;
  /** The five, normalised into copper by `./coins.ts`. */
  totalCopper: number;
  /** What the server actually printed, where one line stated the lot. */
  rawText?: string;
}

/**
 * A thing, wherever it is: carried, worn, on the floor, on a shelf, or in a
 * monster's drop table.
 *
 * This is the join of `CarriedItem` (what the listing said about *this* one)
 * with `WorldItem` (what the realm says about the kind). The wire half is
 * required and the realm half is not, because the pack is real whether or not
 * the database has heard of what is in it.
 */
export interface ItemEntity {
  /** As the wire spelled it, with the listing's annotations taken off. */
  name: string;
  /** The listing's own text, annotations and all, where one printed it. */
  rawText?: string;
  source: EntitySource;

  // --- what the wire observed about this one -------------------------------
  /**
   * The slot the listing named — `Head`, `Weapon Hand` — or null.
   *
   * Null while an item is merely carried **and** while it is worn somewhere no
   * listing has named yet, which is why this is not the same question as
   * `equipped`. See `CarriedItem.slot`.
   */
  slot: string | null;
  /** Where the slot word came from, when a listing did not print it. */
  slotSource?: 'realm';
  /** Worn, wielded or lit — in use rather than in the pack. */
  equipped: boolean;
  /** Uses left, where the listing stated one. Null when it does not count down. */
  charges: number | null;
  /**
   * How many the line named — `You dropped 2 padded gloves.`
   *
   * Absent is one. The server counts, and without this the item reads as one
   * called "2 padded gloves".
   */
  count?: number;

  // --- what the realm says about the kind ----------------------------------
  /**
   * The realm's row for this kind of thing — **the first one, where the name
   * holds several**, because that is the row the shops reference
   * (`WorldGraph.itemsByName`).
   *
   * So it is not what to *print* as this thing's number: see `ids` and
   * `entityNumber`.
   */
  id?: number;
  /**
   * Every row the name belongs to, where the realm knows the name at all.
   *
   * The honest answer to *what number is this*: twenty of the shipped realm's
   * 1,918 item names are shared by two or more rows (`iron key` is three,
   * `void sphere` four), and picking one of them to print would be the same
   * guess `Traveller.keys` refuses to make about a keyed door. One entry is a
   * name the realm places once.
   */
  ids?: readonly number[];
  /**
   * The row the room settled a shared name to: the one it places (format 42,
   * `WorldGraph.itemPlacedHere`). Every figure below is that row's then.
   */
  row?: { id: number };
  /** Base cost in copper, before a shop's markup. */
  price?: number;
  encumbrance?: number;
  kind?: ItemKind;
  /** The realm's raw `Worn` code, for the slot lore. */
  wornSlotCode?: number;
  /**
   * Where the realm says this *kind* of thing is worn, as a word.
   *
   * A different fact from `slot`, and kept apart for the reason `slotSource`
   * exists: `slot` is what a listing said about **this one** and this is the
   * client's reading of the realm's `Worn` number for the kind. The equip gate
   * wants this — "is this kit at all" is a question about the kind — and a
   * card must never print it under a heading that looks like the server's.
   */
  realmSlot?: string;
  weapon?: {
    min: number;
    max: number;
    speed?: number;
    strength?: number;
    accuracy?: number;
    type?: string;
    hands?: 1 | 2;
  };
  armour?: { ac?: number; dr?: number; material?: string };
  /** Maximum uses the realm records, against `charges` observed. */
  uses?: number;
  abilities?: Array<[number, number]>;
  /** Allow-lists of `Classes` / `Races` row ids. Absent restricts nothing. */
  classes?: number[];
  races?: number[];
  minLevel?: number;
  /** `Items.Gettable` — false is the realm saying it cannot be picked up. */
  gettable?: boolean;
  /** `Items.Not Droppable`. */
  notDroppable?: boolean;
  /** `Items.Limit` — how many may exist. */
  limit?: number;
  /** Shops known to stock it, and monsters known to drop it. */
  shops?: string[];
  droppedBy?: string[];
}

/**
 * A monster, wherever it is: in the room, in a fight, or in a lair's roster.
 *
 * `name` is normalised for lookup and `rawName` is what the server printed.
 * They differ because `MobNameModifierType` hangs a word off either end — the
 * room says `large lashworm` and the table says `lashworm` — and both are
 * needed: the raw one is what a command must name, the normalised one is what
 * the realm was asked about.
 */
export interface MobEntity {
  /** The realm's own spelling where it was found, else the wire's. */
  name: string;
  /** Verbatim, as the listing printed it. What a command must use. */
  rawName: string;
  source: EntitySource;

  // --- what the wire observed ----------------------------------------------
  /** The listing's ` (Charmed)` annotation — a monster somebody has charmed. */
  charmed: boolean;

  // --- what the realm says -------------------------------------------------
  /**
   * Every `Monsters` row the name belongs to — 229 of the shipped realm's
   * 1,514 names hold more than one, up to eight.
   *
   * The wire never states a number, so a bare name resolves to this list and
   * `row` is the one entry a *room* could settle it to. One entry is a name
   * the realm places once. See `entityNumber`.
   */
  ids?: readonly number[];
  /** The high end of what the realm records, which is what a bar works from. */
  hp?: number;
  /**
   * Which of the realm's rows this is, where a room resolved it to one.
   *
   * Present only where the name held several rows and something could tell
   * them apart — the room's own lair, or a row spawning decisively nearer
   * than the rest (`WorldGraph.resolveMobRow`). Every figure below is then
   * that row's own and `span` is absent, because one row states one number.
   */
  row?: MobRowChoice;
  /** `[low, high]` where rows sharing this name disagree. */
  span?: [number, number];
  /**
   * Whether it opens the fight. Null for a player, for a monster the realm
   * cannot place, and on a realm file built before dispositions were indexed —
   * and null is never *safe*.
   */
  disposition: MobDisposition | null;
  /** True where the realm's rows for this name disagree about that. */
  uncertain: boolean;
  /** What attacking it costs this character in alignment. */
  costly: AlignmentCost;
  armour?: number;
  damageResist?: number;
  magicResist?: number;
  experience?: number;
  /** Hit points regained per server tick. */
  regen?: number;
  /** Hours a placed monster stays dead — `Monsters.RegenTime`. A lair room has its own clock. */
  regenHours?: number;
  /** Percentage chance it follows you out when you run. */
  follows?: number;
  undead?: boolean;
  /** Resolved drop table, so a target can be chosen by what it carries. */
  drops?: ItemEntity[];
  abilities?: Array<[number, number]>;
  /** The average damage a blow does — `Monsters.AvgDmg`. */
  averageDamage?: number;
  /** The level at which it can be charmed — `Monsters.CharmLVL`. */
  charmLevel?: number;
  /** Realm spell ids it casts mid-fight — `MidSpell-0..4`. */
  casts?: number[];
  /**
   * The realm spell id it casts **when it dies** — `Monsters.DeathSpell`.
   *
   * 146 of the shipped realm's monsters carry one, and nothing in the stream
   * says so until it already has. It is the fact behind declining a fight with
   * something that detonates.
   */
  deathSpell?: number;
  /**
   * How the realm's rows for this name fight — `WorldMob.profiles`, carried
   * whole because which row is worst depends on the character reading it.
   */
  profiles?: MobProfile[];
  /**
   * The realm's row for every spell this monster can bring to a fight — cast
   * between rounds, cast in place of a blow, applied on a landed blow, or
   * cast when it dies — keyed by spell id.
   *
   * Resolved here, where the realm data lives, for the reason `drops` is: a
   * decision about what to hit first is made from the room's occupants in
   * `AutoCombat`, which holds no realm and must not ask one per status line.
   * Only the ids the profiles and `deathSpell` name; a realm that cannot name
   * a spell simply has no entry for it.
   */
  spells?: Record<number, WorldSpell>;
  /**
   * `Monsters.Type`, undecoded.
   *
   * Carried as the realm's own number and read by nothing, deliberately. The
   * column has four values on the shipped realm (905 / 221 / 247 / 460) and
   * **no reading of it survives the data**: measured 2026-09-02, it does not
   * separate named characters from wandering monsters (69% of the largest
   * value are lower-case), nor greeters from mutes, nor the charmable from the
   * rest. It is here so a later capture can decode it without a realm rebuild
   * — the same reason `abilities` keeps numbers rather than words.
   */
  realmType?: number;
}

/**
 * A creature the realm ties to a room — `Rooms.NPC`.
 *
 * **Not "a friendly character".** Measured against the shipped realm
 * (2026-09-02): 701 rooms name one, and the rows they point at are `mariana`
 * behind her own shop counter, `old gypsy woman`, and equally `werewolf`,
 * `night hag` and `wild turkey`. So this is *who lives here*, which is worth
 * knowing before walking in, and it is emphatically not a disposition.
 *
 * `npcType` is therefore filled **only from the room's own shop**, which is a
 * join the data supports: the realm records which shop a room holds and what
 * kind it is. Everything else is left undefined rather than guessed — in
 * particular `Monsters.Type` is *not* read as shopkeeper/trainer/guard, because
 * it does not mean that.
 */
export interface NpcEntity {
  name: string;
  source: EntitySource;
  id?: number;
  /** From the room's shop, where it has one. Undefined is *the realm does not say*. */
  npcType?: 'shopkeeper' | 'banker' | 'trainer' | 'innkeeper' | 'tavernkeeper' | 'priest';
  shopId?: number;
  /** `Monsters.GreetTXT` — what it says when you walk in. */
  greetingText?: string;
  /** The same three-state the room's occupants carry: null is not safe. */
  disposition: MobDisposition | null;
  costly: AlignmentCost;
}

/**
 * A person: in the room, on the roster, in the party, or merely remembered.
 *
 * One shape for all four because they are one person, and holding four was how
 * the Realm card and the Room card came to disagree about somebody's alignment.
 * Everything the realm's own tables can add — the race and class rows behind
 * the two words a `look` prints — hangs off it.
 */
export interface PlayerEntity {
  name: string;
  /** `wire` is present now; `book` is the realm's record of somebody absent. */
  source: 'wire' | 'book';
  /** Null is *nothing has said*, and is never Neutral and never safe. */
  alignment: Alignment | null;
  title: string | null;
  /** The listing's trailing status letters — `R` resting, `M` meditating. */
  flags: string | null;
  gang: string | null;
  gangRank: string | null;
  level: number | null;
  race: string | null;
  className: string | null;
  /** The realm's own rows behind those two words, where it names them. */
  raceEntity?: WorldRace | null;
  classEntity?: WorldClass | null;

  /** What a `look` last showed them wearing, as entities. */
  equipment: ItemEntity[];
  /** When that look happened. Null is *nobody has looked*. */
  equipmentAt: number | null;

  /** The listing's `(Hidden)`, and its `*` — attacking them is free. */
  hidden: boolean;
  free: boolean;
  inParty: boolean;
  partyRank?: 'front' | 'mid' | 'back' | null;
  /**
   * What their own client answered to `@health`, or the party listing's
   * percentages. Null throughout is *not yet listed*, never zero.
   */
  vitals: {
    hp: number | null;
    hpMax: number | null;
    mana: number | null;
    manaMax: number | null;
  } | null;
  online: boolean;
  lastSeen: number;
  lastRoom?: number | null;
  lastRoomName?: string | null;
}

/**
 * A way out, with the realm's answer about where it goes already attached.
 *
 * The wire prints a direction and sometimes a note (`closed gate`); the realm
 * knows the destination, what the passage demands, and which item opens it.
 * Joining them here is what lets the Room card draw an obstacle badge and name
 * a key without a round trip — and what lets a route be read before it is
 * walked.
 */
export interface ExitEntity {
  /** Canonical short (`n`, `ne`), or the realm's own word for a text exit. */
  direction: string;
  /** The wire's note for it. Null for a plain exit. */
  note: string | null;
  targetMap: number | null;
  targetRoom: number | null;
  /** The destination's name, from the realm. Null when it cannot say. */
  targetName: string | null;
  requirement: Requirement | null;
  /** The key the passage demands, resolved. Null when nothing is needed. */
  keyItem?: ItemEntity | null;
  obstacle?: MapObstacle | null;
  /** Whether the far side is dark, where the realm records a light level. */
  dark?: boolean;
}

/**
 * The room, whole: what the server printed and what the realm knows about it,
 * joined once at the point the room completed.
 *
 * This is the entity that pays for the rest. `Room` carried `items: string[]`
 * and coordinates, and every question beyond that — is there a shop, is this a
 * lair, what does that thing on the floor weigh, where does that exit go — was
 * a separate IPC call made by a React effect after the card had already drawn
 * once without the answer.
 */
export interface RoomEntity {
  map: number | null;
  number: number | null;
  name: string | null;
  description: string | null;
  /** What the server said about the light, as it said it. */
  light: RoomLight | null;
  /** The realm's own light level, which is a different claim from the phrase. */
  lightLevel?: number;
  resolvedBy: string | null;
  confidence: number;
  candidates: RoomCandidate[];

  mobs: MobEntity[];
  npcs: NpcEntity[];
  players: PlayerEntity[];
  items: ItemEntity[];
  /** Coins on the floor. Null is *none stated*, never zero. */
  cash: CurrencyEntity | null;
  exits: ExitEntity[];

  // --- attached the moment the room resolved -------------------------------
  shop?: WorldShop | null;
  lair?: WorldLair | null;
  commands?: RoomCommand[];
  /** The spell the realm casts on whoever stands here. */
  spell?: WorldSpell | null;
}

/**
 * An item entity from the wire alone.
 *
 * The dual-source rule's floor: this is what an entity looks like when the
 * realm contributes nothing, and it is a real answer rather than a stand-in —
 * a derivative realm produces these for everything. Stated once so the
 * tracker's fallback, the renderer and every fixture agree on the shape.
 */
export function wireItem(
  name: string,
  observed: {
    slot?: string | null;
    slotSource?: 'realm';
    equipped?: boolean;
    charges?: number | null;
    count?: number;
    rawText?: string;
  } = {}
): ItemEntity {
  const entity: ItemEntity = {
    name: name.trim(),
    source: 'wire',
    slot: observed.slot ?? null,
    equipped: observed.equipped ?? false,
    charges: observed.charges ?? null
  };
  if (observed.slotSource !== undefined) entity.slotSource = observed.slotSource;
  if (observed.count !== undefined) entity.count = observed.count;
  if (observed.rawText !== undefined) entity.rawText = observed.rawText;
  return entity;
}

/**
 * Anything the realm gives a row number to, as far as printing that number
 * goes.
 *
 * Structural rather than a union of the entity types, because the same two
 * questions are asked of six shapes — `ItemEntity`, `MobEntity`, `WorldItem`,
 * `WorldMob`, `WorldSpell`, `NpcEntity` — and half of them live in
 * `./world.ts`, which this module may not import values from.
 */
export interface Numbered {
  /** A single row's number, for the tables where a name means one row. */
  id?: number;
  /** Every row a name belongs to, where the name is what was looked up. */
  ids?: readonly number[];
  /** The row a *room* settled a name holding several to. */
  row?: { id: number };
}

/**
 * The realm's own number for a thing, or null where no single row answers.
 *
 * Three readings, in order, and the order is the argument:
 *
 * 1. **`row`** — a room's own lair named this row, or it is the only one that
 *    spawns anywhere near. That is evidence about *this* monster and outranks
 *    the list it was chosen from.
 * 2. **`ids` of exactly one** — the realm places the name once, so the name
 *    *is* the row.
 * 3. **`id`** — the shapes that have no `ids` because they were looked up as a
 *    row rather than as a name: a spell, a race, a class, a room's resident,
 *    and every `WorldItem` a reference lookup returns (four `void sphere`
 *    rows come back as four entries, each answering for itself).
 *
 * Null for `ids` holding several with no `row` to settle it, which is the
 * refuse-rather-than-guess rule applied to a figure: `iron key` is three rows
 * and printing one of their numbers would be the same coin toss
 * `Traveller.keys` declines to make. `entityRows` is what says so instead.
 */
export function entityNumber(of: Numbered): number | null {
  if (of.row !== undefined) return of.row.id;
  if (of.ids !== undefined) return of.ids.length === 1 ? of.ids[0]! : null;
  return of.id ?? null;
}

/**
 * How many of the realm's rows share this name, where more than one does and
 * nothing has settled which.
 *
 * Null whenever `entityNumber` answers, so the two are exclusive and a caller
 * draws one or the other. What it buys is a reader who can tell *the realm
 * does not know this thing* from *the realm knows four of them*, which is the
 * difference between an empty figure and an honest one.
 */
export function entityRows(of: Numbered): number | null {
  if (entityNumber(of) !== null) return null;
  const rows = of.ids?.length ?? 0;
  return rows > 1 ? rows : null;
}

/**
 * An exit from the wire alone — a direction and maybe a note, going nowhere
 * the client can name.
 *
 * The room completes with these before it is placed, and they are rebuilt with
 * destinations once it is. Drawing an unplaced room's exits with no
 * destination is the honest answer: nothing knows where they go yet.
 */
export function wireExit(direction: string, note: string | null = null): ExitEntity {
  return {
    direction,
    note,
    targetMap: null,
    targetRoom: null,
    targetName: null,
    requirement: null
  };
}
