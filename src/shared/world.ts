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
import type { FightSummary } from './fights';
import type { MobLoreEntry } from './lore';
import type { ItemKind } from './items';
import type { AlignmentCost, MobDisposition } from './mobs';

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
export type RequirementKind =
  | 'door'
  | 'key'
  | 'level'
  | 'toll'
  | 'text'
  | 'item'
  | 'class'
  | 'race'
  | 'alignment'
  | 'ability'
  | 'cast'
  | 'spell'
  | 'trap'
  | 'hidden'
  | 'timed'
  | 'unknown';

export interface Requirement {
  kind: RequirementKind;
  /** The instruction verbatim, for display and for anything not yet modelled. */
  raw: string;
  /**
   * Commands that traverse this exit instead of the bare direction.
   * `Text: go crimson, enter crimson` yields both, first one preferred.
   */
  commands?: string[];
  /** `Key: 1124` — the item number that opens it. */
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
  /** `Trap, 30 damage`. */
  damage?: number;
  /** `Hidden/Searchable` — must be searched for before it can be used. */
  searchable?: boolean;
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
  /** What the realm charges, before a shop's markup. Absent when it says none. */
  price?: number;
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
}

export type ShopKind = 'shop' | 'temple' | 'tavern' | 'bank' | 'trainer' | 'inn';

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
   * Where each shop named in a returned item's `Sold by` row is, by the shop's
   * name lower-cased.
   *
   * Resolved here rather than at click time, so reading the row and acting on
   * it are one round trip — and so the card never has to hold a channel of its
   * own to answer *where is that*. Absent for a query that named no item, and
   * a shop the realm places nowhere simply has no key. See `ShopPlace`.
   */
  shopPlaces?: Record<string, ShopPlace>;
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
   * What can spawn, de-duplicated, in the realm's order. Empty when the
   * descriptor names only ids this table lacks — a derivative's additions —
   * which the face says rather than hides.
   */
  mobs: WorldMob[];
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
  /** What it wants, in the realm's own words. */
  need?: string[];
}

/** `map/room`, the key used everywhere. */
export type RoomId = string;

export function roomId(map: number, room: number): RoomId {
  return `${map}/${room}`;
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
 * Only three kinds can actually stop a route, which is what bounds this union:
 * a lock with no key and no skill the realm accepts instead, a level gate, and
 * a toll with nothing to pay it. Everything else is *expensive* rather than
 * impossible, because a route through a trap is better than no route and the
 * player can see the requirement and judge.
 */
export type RouteBlock =
  | {
      kind: 'key';
      /** The room the way out of is shut. */
      at: RoomId;
      to: RoomId;
      /** Where it leads, named, because a room id is not something to act on. */
      name: string;
      /** `Key: 1124` — the item number. Look the name up before showing it. */
      keyId?: number;
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
  /** No path at all, gates ignored: the two rooms are not joined in the data. */
  | { kind: 'unreachable' };

/**
 * The kinds, as a list.
 *
 * A closed union has two halves and they move together: this is the half
 * `describeBlock` is checked against, so a kind added to the type and not
 * described is a failing test rather than a route that refuses in silence.
 */
export const ROUTE_BLOCK_KINDS = ['key', 'level', 'toll', 'unreachable'] as const;

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
      // The item *number* is not something anybody can act on, so it is said
      // only when there is one and always beside the place it shuts.
      return block.keyId === undefined
        ? `${block.name} is locked, and nothing you carry opens it`
        : `${block.name} is locked — key ${block.keyId}, which you do not have`;
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
    case 'unreachable':
      return 'No way there at all — the realm data joins no path between the two';
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
   * What stood in the way, when blocked — every condition, not the first.
   *
   * `reason` stays a sentence so nothing that already reads it has to change;
   * this is the same answer as facts, for a surface that wants to say more than
   * one line or to look a key's name up.
   */
  blocks?: RouteBlock[];
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
