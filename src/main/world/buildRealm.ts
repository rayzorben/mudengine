import type { RealmSource } from './RealmSource';
import { number, text } from './values';
import { itemsInScripts, parseRoomScript } from './roomScript';
import { itemKind } from '../../shared/items';
import { MIN_LEVEL_ABILITY } from '../../shared/abilities';
import type { MobAttack, MobCast, MobProfile } from '../../shared/world';
import {
  alignmentCost,
  costsAlignment,
  DISPOSITION_CODE,
  dispositionOf,
  worstDisposition,
  type MobDisposition
} from '../../shared/mobs';

/**
 * Turning a realm database into the one normalised form the client loads.
 *
 * **Normalisation happens here, once, and never at runtime per line.**
 * docs/legacy-assessment.md §5 consequence 4: the CoffeeScript engine issued
 * synchronous SQLite queries from inside block parsing, on the main thread, per
 * line of server output. This function is what makes that impossible — the
 * whole realm is read, indexed and written out in one pass, and nothing
 * downstream has a database handle to misuse.
 *
 * Shared by the build script and by the runtime path that converts a realm file
 * a player has chosen. One implementation, so a client-converted realm and a
 * shipped one cannot disagree about what a room is.
 */

/**
 * The realm file format.
 *
 * Bumped whenever the header gains something a consumer would otherwise have to
 * guess at. It is folded into the cache key a converted realm is stored under
 * (`RealmLibrary`), because the alternative is a client that keeps reading a
 * conversion made by an older build and silently lacks whatever the bump added
 * — which for v5 is *whether a monster attacks on sight*, a question auto-combat
 * answers `no` to when nothing says otherwise.
 *
 * | v | What it added |
 * |---|---|
 * | 3 | The monster index, by name |
 * | 4 | Shops and their stock |
 * | 5 | Monster disposition — `Align` and `Type`, per `shared/mobs.ts` |
 * | 6 | Item kind, slot, and a weapon's or armour's own numbers, per `shared/items.ts` |
 * | 7 | What kind of shop a shop is — bank, temple, inn — from `Shops.ShopType` |
 * | 8 | Stockless places kept for their kind — a bank sells nothing and is still a bank |
 * | 9 | A lair names its monsters by number, and an exit's level gate |
 * | 10 | The race and class indexes — the two words on every `look` at a player |
 * | 11 | Every item name, so a thing on the floor is recognised as one |
 * | 12 | What a monster is worth and what it takes — `EXP`, `ArmourClass`, `DamageResist`, `MagicRes`, `HPRegen`, `Follow%`, `Undead`, its coin drop and its drop table — and an item's `Abil-n` effects |
 * | 13 | The words a room answers: `Rooms.CMD` through `TBInfo.Action`, and the spell a room casts on whoever stands in it |
 * | 14 | `Abil-n` effects on the other four tables — monsters, spells, races and classes. Only the item half was ever written out, so a spell card said its level and mana and never what casting it does, and a monster's fire resistance was in the realm and on no screen |
 * | 15 | Who may use an item — `Items.ClassRest-n`, `RaceRest-n` and the `MinLevel` gate. Columns of the realm's own, read by nothing until now, so the pack offered a `wear` button for an item the realm already said this class could not have, and the server answered `You may not wear that item!` |
 * | 16 | A spell's own magnitude — `MinBase`, `MaxBase`, `Cap` and the three per-level growth pairs. The `Abil-n` row names *what* a spell affects and 1,410 spells put *how much* in these columns instead, so a card drew `M.R. 0` off a genuine zero while the 10 sat in a column nothing wrote out |
 * | 17 | `Spells.Targets` — who a spell may be cast on. Without it a heal picker had to offer all 1,990 rows, so `way of the swan` (self only) and `minor healing` (self or another) were indistinguishable, and configuring the party heal with a self-only spell produced a refusal once a round |
 * | 18 | What an entity needs that the file did not carry: `Items.Gettable`, `Not Droppable` and `Limit`; `Monsters.Type` (undecoded), `AvgDmg`, `CharmLVL`, `MidSpell-0..4` and `DeathSpell`. `Rooms.NPC` had been *written* since the file began and read by nothing — the read side arrives here |
 * | 19 | No new column: `ExpTable` on a race and a class is written when it is **non-zero** rather than when it is positive. Stock MajorMUD prices a Thief at `-20`, and it is a term of `100 + race + class` — the multiplier the whole experience table is built from — so dropping the sign charged one a fifth more per level than the realm does. The number is bumped for the *cache*: `RealmLibrary.identity` keys a converted realm on the format, the path, the size and the mtime, and none of the last three moves when the converter changes, so a player who had already converted their own database would have kept the bug this fixes, silently |
 * | 20 | How a monster fights, **per row**: the five `Att…` slot groups (type, effective chance, accuracy or spell, damage or cast odds and level, energy, hit spell) and the five `MidSpell…` groups with their marginal per-round chance and cast level — `BuiltMob.pf` — and `Spells.TypeOfResists`. Auto-combat had every monster's `AvgDmg` and nothing about *how* it was dealt, so it could not weigh a paralysing caster against a biter, and took the room in the order the server listed it |
 */
export const REALM_FORMAT = 20;

/** The ten directions, in the column order every export of this table uses. */
export const DIRECTIONS = ['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'U', 'D'] as const;

export interface BuiltRealm {
  /** The gzipped JSON-lines body, ready to write. */
  lines: string[];
  header: {
    v: number;
    source: string;
    rooms: number;
    generatedAt: string;
    items: BuiltItem[];
    mobs: BuiltMob[];
    shops: BuiltShop[];
    spells: BuiltSpell[];
    races: BuiltRace[];
    classes: BuiltClass[];
    /**
     * Every item name the realm has, for recognising one in a line of text.
     *
     * Deliberately separate from `items`, which is the *detail* index and is
     * kept narrow on purpose — about a hundred keys some exit references, plus
     * what the shops stock. That narrowness is right for "what is this worth,
     * what does it weigh"; it is wrong for "is this a thing", and the two were
     * the same list. `You notice large sign, small sign here.` — the realm's
     * own furniture, sold by nobody and needed by no exit — was therefore not
     * recognised as items at all, so the two things named in a room the
     * character was standing in were the two words on the line that could not
     * be clicked. Names alone: 2,559 of them is 41KB, where the whole detail
     * table would be an order of magnitude more for facts nothing asked for.
     */
    itemNames: string[];
  };
  /** Counts worth reporting, and worth refusing an empty realm on. */
  stats: {
    rooms: number;
    withExits: number;
    withInstructions: number;
    /** Rooms that answer a typed word, from `Rooms.CMD`. */
    scripted: number;
    items: number;
    mobs: number;
    shops: number;
    spells: number;
    races: number;
    classes: number;
    itemNames: number;
  };
}

export interface BuiltItem {
  id: number;
  n: string;
  shops?: string[];
  mobs?: string[];
  /**
   * What the realm charges for one, before a shop's markup.
   *
   * Carried because the client can then answer "what is this worth" without
   * spending a command on `appraise` — the standing rule of the world layer:
   * asking the server for something the shipped data already knows is a command
   * spent for nothing (docs/greatermud/rooms-and-items.md).
   */
  price?: number;
  /** What it weighs, in the units the status line's encumbrance is counted in. */
  enc?: number;
  /**
   * `ItemType`, kept as the realm's number rather than a word.
   *
   * The word is `shared/items.ts`'s reading of the number and may be
   * corrected; the number is what the realm said. Absent when the column is
   * missing, never defaulted — a derivative without it names no kinds.
   */
  type?: number;
  /** `Worn`, the realm's number. Absent when zero. */
  worn?: number;
  /** A weapon's `Min`, `Max`, `Speed`, `StrReq`, `Accy`, `WeaponType`. Only when `type` is a weapon's. */
  wpn?: { min: number; max: number; spd?: number; str?: number; acc?: number; kind?: number };
  /** Armour's `ArmourClass`, `DamageResist`, `ArmourType`. Only when `type` is armour's. */
  arm?: { ac?: number; dr?: number; kind?: number };
  /** `UseCount` when it is a positive count; `-1` means unlimited and is left out. */
  uses?: number;
  /**
   * `Abil-n` / `AbilVal-n`, the realm's effect system — format 12.
   *
   * `[id, value]` pairs in the realm's own numbering, decoded by
   * `src/shared/abilities.ts` at the point of display rather than here: the
   * numbering is stable and the *reading* of it is a claim from another
   * client's source that may be corrected, so what is written to disk is the
   * realm's own answer and never an interpretation of it.
   *
   * Only pairs the ability table can name are kept — `abilityIsNotable` is
   * deliberately **not** the filter, because that is a display judgement and
   * this is the file every future card reads. Empty slots (`Abil-n = 0`) are
   * dropped: an item with `Abil-3 = 0` has three effects, not four.
   */
  ab?: Array<[number, number]>;
  /**
   * `ClassRest-0..9` and `RaceRest-0..9` — who may use it. Format 15.
   *
   * Their own columns, and nothing to do with the `Abil-n` pairs: `ClassOk`
   * (ability 59) is a separate question the realm answers separately, and the
   * two disagree wherever both are stated. Row ids in `Classes` and `Races`,
   * kept as the realm's numbers for the reason `ab` is — the *reading* is the
   * client's and the number is the realm's. Zero is the empty slot.
   */
  cls?: number[];
  race?: number[];
  /** `MinLevel` (ability 135), lifted out of `ab` because it gates rather than describes. */
  lvl?: number;
  /**
   * `Items.Gettable` — **0 when the realm refuses to let it be picked up**.
   * Format 18.
   *
   * Written only for the refusal, because that is the fact worth carrying:
   * 2,594 of the shipped realm's 2,639 items are gettable, so writing the
   * ordinary answer would be a byte per item to say nothing. Absent is
   * gettable, which is also the right answer for a derivative realm without
   * the column — refusing to loot on an absent column would be the client's
   * ignorance stopping an automation that works.
   */
  ngt?: 1;
  /** `Items.Not Droppable`, written only when true. Format 18. */
  ndr?: 1;
  /** `Items.Limit` — how many may exist at once. Format 18. */
  lim?: number;
}

/**
 * A shop, and what the realm says it stocks.
 *
 * A shop is a property of a *room* — `Rooms.Shop` holds the number — so this is
 * what turns "you are standing in a shop" into "you are standing in a General
 * Store that sells a torch, a lantern and a crowbar". Which is the whole point:
 * the alternative is typing `list`, and a command is the scarce resource.
 *
 * **Stock is item ids, not names.** A name here would be a second copy of a
 * string the item index already holds, 1,386 times over, and two copies of a
 * name are two things that can disagree.
 */
export interface BuiltShop {
  id: number;
  n: string;
  /** Item numbers, in the order the realm lists them. */
  items: number[];
  /** Percentage the shop adds to the base price, when it states one. */
  markup?: number;
  /**
   * `ShopType`, the realm's number. Sampled: 5 temple, 6 tavern, 7 bank, 8
   * training room, 9 inn, 10 an ordinary shop; the rest are placeholders,
   * gang and deed shops. The legacy client's `shopTypes.coffee` names the
   * same numbers. Kept as the number; `WorldGraph` turns it into a word.
   */
  t?: number;
}

/**
 * A spell the realm knows.
 *
 * The reference a MegaMUD-era player kept on paper: what it costs, what it
 * needs, how long it lasts. Every row with a name is kept rather than a subset,
 * because unlike an exit's key there is no way to know in advance which spell
 * somebody will want to look up.
 */
export interface BuiltSpell {
  id: number;
  n: string;
  /** The abbreviation the realm accepts in place of the name. */
  short?: string;
  /** Level required to cast it. */
  level?: number;
  mana?: number;
  energy?: number;
  /** Duration, in the realm's own units. */
  dur?: number;
  /**
   * `Abil-n` / `AbilVal-n` — format 14, and the same pairs an item carries.
   *
   * Written verbatim, decoded by `src/shared/abilities.ts` at the point of
   * display. See `abilityPairs`.
   */
  ab?: Array<[number, number]>;
  /**
   * `MinBase`–`MaxBase` — how much the spell does before level scales it, and
   * the columns a spell's numbers actually live in. Format 16.
   *
   * Written because the `Abil-n` row names *what* a spell affects and often
   * says nothing about how much: `way of the owl` is `M.R.` with `AbilVal 0`
   * and a power of 10, and the card read `M.R. 0` off the column the realm
   * genuinely holds a zero in. 1,410 of 1,990 spells state a power.
   */
  pw?: [number, number];
  /** `Cap` — the ceiling the scaling reaches. 508 spells. */
  cap?: number;
  /**
   * `Spells.Targets` — who the realm lets this spell be cast on. Format 17.
   *
   * The realm's own number, written verbatim and read by
   * `spellTargeting` in `src/shared/spellcraft.ts`, for the reason
   * `ab` is written verbatim: the *reading* of an enum this database
   * writes down nowhere is a claim that may be corrected, and a
   * correction must not require every realm to be converted again.
   * Omitted for `0`, which is the realm's own empty answer.
   */
  tg?: number;
  /** `[MinIncLVLs, MinInc]`, and the `Max` and `Dur` pairs beside it. */
  mig?: [number, number];
  mag?: [number, number];
  dug?: [number, number];
  /**
   * `Spells.TypeOfResists` — format 20, verbatim, for the reason `tg` is.
   * Omitted for `0`, the realm's *never resisted*, which reads back as the
   * cast that lands.
   */
  res?: number;
}

/**
 * One row's fighting profile on disk — format 20 — in the compact shape the
 * rest of the file uses. `a` is the attack slots, each `[1, chance, accuracy,
 * min, max, energy, hitSpell]` for a blow or `[2, chance, spell, castChance,
 * level, energy]` for a cast in a blow's place; `c` is the between-round
 * spells, each `[spell, chance, level]`. Both omitted when empty; a row with
 * neither is not written at all. `WorldGraph.readProfiles` is the reader.
 */
export interface BuiltProfile {
  a?: number[][];
  c?: number[][];
}

/**
 * A race the realm offers, and the six stat ranges that distinguish one.
 *
 * The `Races` table is thirteen rows, and every one of them is a word the wire
 * prints on `look <player>` and in a gang listing — `Soul is a thin, moderately
 * built **Human Warrior**`. It was never indexed, so the two words that say
 * most about what somebody can do were the only ones on that line the client
 * could not answer a question about.
 *
 * The stat pair is a **range**, minimum to maximum, and both ends matter: the
 * minimum is what the race starts at and the maximum is the ceiling it can ever
 * train to, which is the number that decides whether a Half-Ogre Mage is a
 * plan or a mistake.
 */
export interface BuiltRace {
  id: number;
  n: string;
  /** `[minimum, maximum]` per stat, omitted where the realm states neither. */
  int?: [number, number];
  wil?: [number, number];
  str?: [number, number];
  hea?: [number, number];
  agl?: [number, number];
  chm?: [number, number];
  /** Extra hit points per level, over what the class gives. Absent when none. */
  hpPerLevel?: number;
  /**
   * The experience multiplier, as a percentage: a race on 150 needs half again
   * as much experience per level as one on 100. Kept verbatim — the realm's own
   * number, not converted, because nothing here has measured what it scales.
   */
  expTable?: number;
  /**
   * `Abil-n` / `AbilVal-n` — format 14, and the same pairs an item carries.
   *
   * Written verbatim, decoded by `src/shared/abilities.ts` at the point of
   * display. See `abilityPairs`.
   */
  ab?: Array<[number, number]>;
}

/**
 * A class the realm offers.
 *
 * Fifteen rows, and the other half of `Human Warrior`. Only the fields whose
 * meaning is settled are carried: `MinHits`/`MaxHits` are **not**, because the
 * first is larger than the second in all fifteen rows (`7-4`, `5-3`) and
 * nothing read so far says which way round they are — a hit-dice range printed
 * backwards is a claim the realm data does not make. `MageryType` is likewise
 * left out: it is 0 through 5 and only 0 (no magery at all) is certain, so the
 * *level* is carried and the numbering is not invented.
 */
export interface BuiltClass {
  id: number;
  n: string;
  /** Experience multiplier as a percentage, as on a race. */
  expTable?: number;
  /** Magery level, 1–3. Absent for a class that casts nothing. */
  magery?: number;
  /** How well it fights, on the realm's own 1–7 scale. */
  combat?: number;
  /**
   * `Abil-n` / `AbilVal-n` — format 14, and the same pairs an item carries.
   *
   * Written verbatim, decoded by `src/shared/abilities.ts` at the point of
   * display. See `abilityPairs`.
   */
  ab?: Array<[number, number]>;
}

/**
 * A monster the realm can name a maximum health for.
 *
 * Keyed by **name**, because a name is all the wire ever gives: `You slash the
 * giant rat for 12 damage!` carries no number, and nothing in the stream ever
 * names a monster's record id. The realm data is keyed by id and several rows
 * frequently share a name — a `cocoon` is five different monsters between 100
 * and 250 health — so a name genuinely resolves to a *range*, and this says so
 * rather than picking one and sounding certain.
 *
 * `hp` is the low end and `hi` the high, omitted when they agree. A consumer
 * showing a bar works from the **high** end: over-stating a monster's health
 * makes it die sooner than the bar promised, and under-stating it says "nearly
 * dead" about something that is not, which is the error that gets a character
 * killed.
 */
export interface BuiltMob {
  /** Lowercased and trimmed — the form the wire produces after the article. */
  n: string;
  /**
   * The realm's own numbers for every row sharing this name. Format 9: a
   * lair names its monsters by number (`(Max 2): 781,190,`) and the number
   * is the only key the room table has for them.
   */
  i?: number[];
  /** Lowest maximum health any row with this name has. */
  hp: number;
  /** Highest, when the rows disagree. Absent when they do not. */
  hi?: number;
  /**
   * Whether it starts the fight: `h`, `g`, `e` or `p`. See `shared/mobs.ts`.
   *
   * A letter rather than a word because it is written once per name into a file
   * that ships with the client, and the word buys nothing a lookup does not.
   * Absent when the realm states neither column, which is a realm that cannot
   * answer the question rather than one whose monsters are all peaceable.
   */
  d?: string;
  /** 1 when the rows sharing this name disagree about `d`. Absent otherwise. */
  x?: 1;
  /**
   * What it is worth, and what it costs to take — format 12.
   *
   * Every one of these is a **span collapsed to the answer that cannot get
   * somebody killed**, on the rule the health span already follows and for the
   * same reason: a name resolves to several rows, and the reassuring end of a
   * range is the dangerous one to act on.
   *
   * - `ac`, `dr`, `mr` take the **highest** of the rows: the hardest to hit,
   *   the most absorbed, the most resistant.
   * - `xp` takes the **lowest**: the least it might be worth.
   * - `rgn` takes the **highest**: never claim a monster is closer to death
   *   than it is. It is per regeneration tick, and the tick is realm-wide —
   *   see `MOB_REGEN_ROUNDS` in `src/shared/mobs.ts`.
   * - `fol` takes the **highest**: assume it follows when you leave.
   * - `und` is set when *any* row sharing the name is undead.
   *
   * All absent where no row states them, which is a realm that does not say
   * rather than a monster with no armour.
   */
  ac?: number;
  dr?: number;
  mr?: number;
  xp?: number;
  rgn?: number;
  fol?: number;
  und?: 1;
  /**
   * What it drops, by item name, capped — format 12.
   *
   * The reverse of `BuiltItem.mobs`, which has always been built: that answers
   * *where do I get one of these* and this answers *what is in this thing*,
   * and they are the two halves of the question every MUD player asks about a
   * monster. Names rather than numbers, because a number is not something
   * anybody can act on and the item index does not carry every item.
   */
  drops?: string[];
  /**
   * `Monsters.Type`, undecoded — format 18.
   *
   * Every distinct value the rows sharing this name state, gathered rather
   * than reduced, because there is no reading to reduce *toward*. Measured
   * 2026-09-02 on the shipped realm: four values (905 / 221 / 247 / 460) and
   * none of the obvious readings survives — it does not separate named
   * characters from wandering monsters (69% of the largest value are
   * lower-case), nor greeters from mutes, nor the charmable from the rest. It
   * is carried so a later capture can decode it without reconverting every
   * realm, and read by nothing until one does.
   */
  ty?: number[];
  /**
   * The average damage a blow does, from `Monsters.AvgDmg` — format 18.
   *
   * The **highest** of the rows sharing the name, on the rule every other span
   * here follows: the reassuring end of a range is the dangerous one to act
   * on.
   */
  dmg?: number;
  /** `Monsters.CharmLVL` — the level at which it can be charmed. Format 18. */
  chl?: number;
  /**
   * The spells it casts mid-fight and on death — `MidSpell-0..4` and
   * `DeathSpell`, as realm spell ids. Format 18.
   *
   * The fact behind *avoid anything that casts a death spell*: a monster that
   * detonates when it dies is one an automation should decline, and nothing in
   * the stream says so until it has already happened.
   */
  cast?: number[];
  ds?: number;
  /**
   * How each row sharing this name fights — format 20, one entry per
   * *distinct* row profile, in the order the rows came.
   *
   * Per row and not folded, which is the one place besides `ab` this file
   * refuses to reduce, and for a different reason: `ab` cannot be reduced
   * without a display judgement, and this cannot be reduced without the
   * *character* — which of two rows is the more dangerous depends on the
   * armour class standing in front of them. `src/shared/menace.ts` folds it
   * at the moment of the decision. See `BuiltProfile` for the shape.
   */
  pf?: BuiltProfile[];
  /**
   * Whether attacking one costs ten evil points: `a` always, `s` sometimes.
   *
   * Absent means never. Its own field rather than something derivable from `d`,
   * because the two questions come apart: a `LawfulGood` monster on a gate is
   * `passive` and still charges for being hit. `s` is the case where the rows
   * sharing a name disagree — see `AlignmentCost`.
   */
  ep?: 'a' | 's';
  /**
   * `Abil-n` / `AbilVal-n` — format 14. What it resists, what it ignores, what
   * it calls for help.
   *
   * **Every distinct value every row sharing the name states**, gathered and
   * not reduced — which is the one place this differs from `hp`, `ac` and the
   * rest, and deliberately.
   *
   * It matters: 100 of the 234 shared names disagree about their effects, and
   * `zombie` is three rows where one is 100% cold-resistant and another is
   * not. The first attempt folded to the maximum on the reasoning `hp` uses —
   * the reassuring end of a range is the dangerous one to plan a fight on —
   * and that is right for a magnitude and wrong for a row id. `SpellImmu 40`
   * and `45` are two different spells rather than a bigger number, and
   * `dwarven warrior` row 446 states `MonsGuards` twice in one row; a maximum
   * silently dropped one of each.
   *
   * Choosing per id would mean reading `ABILITY_SHAPE` here, and that is the
   * display judgement this file refuses to make — see `BuiltItem.ab`. So the
   * realm's own answer is written whole and the card reduces it
   * (`effectValues`), where the shape is known and a correction to it takes
   * effect without a rebuild.
   */
  ab?: Array<[number, number]>;
}

/**
 * `1/41 (Door [1000 picklocks/strength])` → destination plus raw instruction.
 * `0` means no exit at all.
 */
export function parseExit(raw: unknown): { m: number; r: number; i?: string } | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text.length === 0 || text === '0') return null;
  const match = /^(\d+)\/(\d+)(?:\s*\((.+)\))?$/.exec(text);
  if (!match) return null;
  const exit: { m: number; r: number; i?: string } = {
    m: Number(match[1]),
    r: Number(match[2])
  };
  if (match[3]) exit.i = match[3];
  return exit;
}

/**
 * What a *blank* looks like once a text value has been read out of a numeric
 * column: `0x2020`, two ASCII spaces, little-endian.
 *
 * 348 rows of the shipped realm's `Items.Speed` read as this. Nothing in the
 * database distinguishes it from a real 8224, and no column in it has a
 * plausible value there — weapon speeds run 900–3000, a monster's armour class
 * tops out at 9999 — so it is refused wherever a new column is read. It costs
 * one impossible value and removes the whole class of bug where an empty cell
 * becomes a confident number.
 */
export const BLANK_AS_NUMBER = 8224;

/**
 * How many `Abil-n` slots a row has.
 *
 * Twenty on `Items` and ten on `Monsters`, `Spells`, `Races` and `Classes`;
 * reading twenty everywhere is safe because a column that is not there reads as
 * absent, and one number is one fewer thing to keep in step with the schema.
 */
export const ABILITY_SLOTS = 20;

/**
 * How many `ClassRest-n` / `RaceRest-n` slots an item row has.
 *
 * Ten of each on `Items`, and the same argument as `ABILITY_SLOTS`: a column
 * that is not there reads as absent, so one number covers every derivative.
 */
export const RESTRICTION_SLOTS = 10;

/**
 * `MidSpell-0..4` on `Monsters`, and the same argument as `ABILITY_SLOTS`: a
 * column count the realm fixed, read as a bound rather than discovered.
 */
export const MID_SPELL_SLOTS = 5;

/** `Attack Type 0`–`4`: the five attack slot groups a monster row carries. */
export const ATTACK_SLOTS = 5;

/**
 * The effective chance of each attack slot, transcribed from
 * `Mob.GetAttackType` rather than derived from it.
 *
 * The realm stores the slots' `Att%` as **cumulative thresholds**: one roll
 * of 1–100 walks the slots in order and takes the first whose threshold covers
 * it, with `covered` advanced to each slot's threshold whether or not it
 * matched — so a threshold *lower* than the one before it can never fire and
 * pulls the floor back down for the slot after. A roll above the last
 * threshold falls back to the first slot. That is a loop with two quirks, so
 * the hundred rolls are walked exactly as the server walks them and counted,
 * rather than turned into arithmetic that would have to get both quirks
 * right.
 *
 * The editor's `AttTrue%` column is **not** read, and not because it is
 * redundant: measured 2026-09-04 over the 1,610 GMUD rows whose column
 * states a total of 100, it agrees with this walk within a point on half the
 * slots and disagrees by up to 73 points on others (`hooded man`, thresholds
 * 5/100, stated 78.3 for the first slot where the server rolls it 5 times in
 * 100). Whatever model produced it, it is not this server's loop, and a
 * cached column that can be edited out from under is exactly the kind of
 * figure the wire outranks. `profiles.realm.test.ts` keeps the measurement.
 */
export function attackChances(thresholds: readonly number[]): number[] {
  const counts = thresholds.map(() => 0);
  if (thresholds.length === 0) return counts;
  for (let roll = 1; roll <= 100; roll += 1) {
    let covered = 0;
    let taken = -1;
    for (let slot = 0; slot < thresholds.length; slot += 1) {
      const threshold = thresholds[slot]!;
      if (roll > covered && roll <= threshold) {
        taken = slot;
        break;
      }
      covered = threshold;
    }
    const landed = taken === -1 ? 0 : taken;
    counts[landed] = (counts[landed] ?? 0) + 1;
  }
  return counts.map((count) => count / 100);
}

/**
 * The marginal per-round chance of each between-round spell, transcribed
 * from the loop in `TimedEventManager` that fires them.
 *
 * **One roll per monster per round**, checked against each slot's `Spell
 * Cast %` in order, and the first slot it falls under fires — so the column
 * is a cumulative figure too, and a second slot at 20% behind a first at 10%
 * fires on a tenth of rounds. Walked and counted for the reason
 * `attackChances` is.
 */
export function castChances(thresholds: readonly number[]): number[] {
  const counts = thresholds.map(() => 0);
  for (let roll = 1; roll <= 100; roll += 1) {
    const slot = thresholds.findIndex((threshold) => roll <= threshold);
    if (slot !== -1) counts[slot] = (counts[slot] ?? 0) + 1;
  }
  return counts.map((count) => count / 100);
}

/**
 * One monster row's fighting profile, or null for a row that states neither
 * an attack nor a between-round spell.
 *
 * Only slot types 1 (a blow) and 2 (a spell in a blow's place) are loaded,
 * because those are the only two `MobType.GetAttackTypes` loads — the GMUD
 * database's one `3`, on the first `giant rat` row, is a slot the server never
 * rolls. A slot the walk gives no chance to is left out the same way: it is
 * not an attack this monster can make.
 */
export function rowProfile(row: Record<string, unknown>): MobProfile | null {
  const cell = (value: unknown): number => {
    const figure = number(value);
    return figure === null || figure === BLANK_AS_NUMBER ? 0 : figure;
  };

  const slots: Array<{
    type: number;
    threshold: number;
    figure: number;
    min: number;
    max: number;
    energy: number;
    hit: number;
  }> = [];
  for (let slot = 0; slot < ATTACK_SLOTS; slot += 1) {
    const type = number(row[`AttType-${slot}`]);
    if (type !== 1 && type !== 2) continue;
    slots.push({
      type,
      threshold: cell(row[`Att%-${slot}`]),
      figure: cell(row[`AttAcc-${slot}`]),
      min: cell(row[`AttMin-${slot}`]),
      max: cell(row[`AttMax-${slot}`]),
      energy: cell(row[`AttEnergy-${slot}`]),
      hit: cell(row[`AttHitSpell-${slot}`])
    });
  }
  const chances = attackChances(slots.map((slot) => slot.threshold));
  const attacks: MobAttack[] = [];
  slots.forEach((slot, index) => {
    const chance = chances[index] ?? 0;
    if (chance <= 0) return;
    if (slot.type === 1) {
      const attack: MobAttack = {
        kind: 'melee',
        chance,
        accuracy: slot.figure,
        min: slot.min,
        max: slot.max,
        energy: slot.energy
      };
      if (slot.hit > 0) attack.onHit = slot.hit;
      attacks.push(attack);
    } else if (slot.figure > 0) {
      // `Attack Accu/Spell` is the spell id, `Min Hit/Cast %` the chance the
      // cast succeeds, `Max Hit/Cast LVL` the level it is cast at.
      attacks.push({
        kind: 'spell',
        chance,
        spell: slot.figure,
        castChance: Math.min(100, Math.max(0, slot.min)) / 100,
        level: slot.max,
        energy: slot.energy
      });
    }
  });

  const named: Array<{ spell: number; threshold: number; level: number }> = [];
  for (let slot = 0; slot < MID_SPELL_SLOTS; slot += 1) {
    const spell = cell(row[`MidSpell-${slot}`]);
    if (spell <= 0) continue;
    named.push({
      spell,
      threshold: cell(row[`MidSpell%-${slot}`]),
      level: cell(row[`MidSpellLVL-${slot}`])
    });
  }
  const odds = castChances(named.map((each) => each.threshold));
  const casts: MobCast[] = [];
  named.forEach((each, index) => {
    const chance = odds[index] ?? 0;
    if (chance > 0) casts.push({ spell: each.spell, chance, level: each.level });
  });

  if (attacks.length === 0 && casts.length === 0) return null;
  return { attacks, casts };
}

/** `MobProfile` in the file's compact shape — see `BuiltProfile`. */
function compactProfile(profile: MobProfile): BuiltProfile {
  const out: BuiltProfile = {};
  if (profile.attacks.length > 0) {
    out.a = profile.attacks.map((attack) =>
      attack.kind === 'melee'
        ? [
            1,
            attack.chance,
            attack.accuracy,
            attack.min,
            attack.max,
            attack.energy,
            attack.onHit ?? 0
          ]
        : [2, attack.chance, attack.spell, attack.castChance, attack.level, attack.energy]
    );
  }
  if (profile.casts.length > 0) {
    out.c = profile.casts.map((cast) => [cast.spell, cast.chance, cast.level]);
  }
  return out;
}

/**
 * The `Abil-n` / `AbilVal-n` pairs on one row, in slot order and undecoded.
 *
 * Five tables carry them — `Items`, `Monsters`, `Spells`, `Races` and
 * `Classes` — and until 2026-08-31 only the item half was ever written out, so
 * the client showed a spell's level and mana and never what casting it does. A
 * shared reader rather than the loop copied five times: the empty-slot rule
 * (`0`) and the blank-cell rule (`8224`) are properties of the *format*, and
 * five copies of them is five places for one of them to be forgotten.
 *
 * Kept as the realm's own numbers; `src/shared/abilities.ts` names them at the
 * point of display, because the reading is a claim from another client's
 * source and may be corrected while the number is what the realm said.
 */
export function abilityPairs(row: Record<string, unknown>): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let slot = 0; slot < ABILITY_SLOTS; slot += 1) {
    const which = number(row[`Abil-${slot}`]);
    if (which === null || which <= 0 || which === BLANK_AS_NUMBER) continue;
    const value = number(row[`AbilVal-${slot}`]);
    pairs.push([which, value === null || value === BLANK_AS_NUMBER ? 0 : value]);
  }
  return pairs;
}

export class RealmBuildError extends Error {}

/**
 * Reads a whole realm and returns what to write.
 *
 * Refuses rather than producing a confident empty realm: a file with no `Rooms`
 * table, or one whose rooms carry no usable coordinates, is a file somebody
 * pointed at by mistake — and a client that accepts it stops knowing where it
 * is with nothing on screen saying why.
 */
export function buildRealm(source: RealmSource, today: string): BuiltRealm {
  const rooms = source.table('Rooms');
  if (rooms === null) {
    throw new RealmBuildError(
      `${source.path} has no Rooms table. Its tables are: ${source.tableNames().join(', ') || '(none)'}.`
    );
  }

  /*
   * Rooms are held as objects and serialised at the end rather than as they are
   * read, because a room's command script names items and the item index is
   * built from what every room, shop and monster between them asked for. One
   * pass could not name a key it had not finished collecting.
   */
  const drafts: Array<{ room: Record<string, unknown>; cmd: number | null }> = [];
  /** Item numbers an exit refers to, so only those need naming. */
  const neededItems = new Set<number>();

  /*
   * The words each room answers, from `Rooms.CMD` into `TBInfo.Action`.
   *
   * Read before the room loop because the item index is built after it and the
   * scripts name 192 items of their own — a script that says `roomitem 3389` is
   * telling nobody anything, and `roomitem shimmering key` is telling them
   * where to start. See `roomScript.ts` for what this table is and why the
   * router is deliberately not given its thousand teleports yet.
   */
  const scripts = new Map<number, string>();
  for (const row of source.table('TBInfo')?.rows ?? []) {
    const id = number(row['Number']);
    // A `TBInfo` action is stored with trailing NULs; they are padding, not text.
    const action = text(row['Action']).replaceAll('\u0000', '').trim();
    if (id !== null && action.length > 0) scripts.set(id, action);
  }
  const scriptedRooms = new Set<number>();
  for (const row of rooms.rows) {
    const cmd = number(row['CMD']);
    if (cmd !== null && cmd > 0 && scripts.has(cmd)) scriptedRooms.add(cmd);
  }
  for (const id of itemsInScripts([...scriptedRooms].map((id) => scripts.get(id) ?? ''))) {
    neededItems.add(id);
  }
  let withExits = 0;
  let withInstructions = 0;
  let placed = 0;

  // Sorted the way the build script's query sorted, so a realm converted at
  // runtime and one built at build time produce byte-identical output.
  const ordered = [...rooms.rows].sort(
    (a, b) =>
      (number(a['Map Number']) ?? 0) - (number(b['Map Number']) ?? 0) ||
      (number(a['Room Number']) ?? 0) - (number(b['Room Number']) ?? 0)
  );

  for (const row of ordered) {
    const map = number(row['Map Number']);
    const roomNumber = number(row['Room Number']);
    // A room with no address cannot be reached, referred to or drawn. Skipped
    // rather than given a zero, which would collide with every other skipped
    // room at 0/0.
    if (map === null || roomNumber === null) continue;
    placed += 1;

    const exits: Record<string, { m: number; r: number; i?: string }> = {};
    for (const direction of DIRECTIONS) {
      const exit = parseExit(row[direction]);
      if (!exit) continue;
      exits[direction.toLowerCase()] = exit;
      if (exit.i) {
        withInstructions += 1;
        for (const match of exit.i.matchAll(/(?:Key|Item):\s*(\d+)/g)) {
          neededItems.add(Number(match[1]));
        }
      }
    }
    if (Object.keys(exits).length > 0) withExits += 1;

    const room: Record<string, unknown> = {
      m: map,
      r: roomNumber,
      n: text(row['Name']),
      x: exits
    };
    // Optional columns, omitted when empty so the file stays small.
    if (row['Shop']) room['s'] = row['Shop'];
    if (row['NPC']) room['npc'] = row['NPC'];
    if (row['Light']) room['li'] = row['Light'];
    /*
     * The spell the room casts on whoever is standing in it — format 13.
     * 13,016 of the shipped realm's 55,806 rooms carry one, and it resolves
     * cleanly against the spell table: `bigheal`, `inn rest`, `stop drowning`,
     * `web spell`, `under level teleport`. Kept as the realm's id and named at
     * the point of display, like every other id here.
     */
    if (row['Spell']) room['sp'] = row['Spell'];
    if (row['Lair'] && row['Lair'] !== '') room['lair'] = row['Lair'];
    if (row['Placed'] && row['Placed'] !== '') room['placed'] = row['Placed'];

    drafts.push({ room, cmd: number(row['CMD']) });
  }

  if (placed === 0) {
    throw new RealmBuildError(
      `${source.path} has a Rooms table with no addressable rooms in it. ` +
        'Expected "Map Number" and "Room Number" columns.'
    );
  }

  /*
   * Shops first: what they stock decides which items need naming. An exit's key
   * and a shop's stock are the same question — "what is item 1124" — asked from
   * two directions, and answering it once is what keeps the file small enough
   * to ship.
   */
  const shops = indexShops(source);
  for (const shop of shops) for (const id of shop.items) neededItems.add(id);

  /*
   * And what monsters drop, so `BuiltMob.drops` can name something. 237 more
   * items on the shipped realm (1,506 → 1,743 of 2,639), which is the price of
   * being able to answer *what is in this thing* — the question every MUD
   * player asks about a monster and the one the client could not answer at all.
   */
  const monsterTable = source.table('Monsters');
  for (const row of monsterTable?.rows ?? []) {
    for (const [column, value] of Object.entries(row)) {
      if (!/^DropItem-\d+$/.test(column)) continue;
      const dropped = number(value);
      if (dropped !== null && dropped > 0) neededItems.add(dropped);
    }
  }

  const items = indexItems(source, neededItems);
  const named = new Map(items.map((item) => [item.id, item.n]));
  const mobs = indexMobs(source, named);

  /*
   * And now the rooms, with the words each one answers attached — format 13.
   * Serialised here rather than in the loop above because the phrases name
   * items, and the item index is only complete at this point.
   */
  const lines: string[] = [];
  let scripted = 0;
  for (const { room, cmd } of drafts) {
    const action = cmd === null ? undefined : scripts.get(cmd);
    if (action !== undefined) {
      const answers = parseRoomScript(action, (id) => named.get(id));
      if (answers.length > 0) {
        room['cmd'] = answers;
        scripted += 1;
      }
    }
    lines.push(JSON.stringify(room));
  }

  const spells = indexSpells(source);
  const races = indexRaces(source);
  const classes = indexClasses(source);
  const itemNames = indexItemNames(source);

  return {
    lines,
    header: {
      v: REALM_FORMAT,
      source: source.path.split(/[\\/]/).pop() ?? source.path,
      rooms: placed,
      generatedAt: today,
      items,
      mobs,
      shops,
      spells,
      races,
      classes,
      itemNames
    },
    stats: {
      rooms: placed,
      withExits,
      withInstructions,
      scripted,
      items: items.length,
      mobs: mobs.length,
      shops: shops.length,
      spells: spells.length,
      races: races.length,
      classes: classes.length,
      itemNames: itemNames.length
    }
  };
}

/**
 * Every shop that stocks anything, and what.
 *
 * A shop with no stock is left out rather than carried empty: the table has 283
 * rows and 175 of them sell something, and the rest are placeholders — one is
 * literally called "Leave this blank". A room pointing at one of those is a
 * room the realm data cannot say anything useful about, and an empty card
 * saying "sells nothing" is worse than no card.
 *
 * Sorted by id, like every other index here, so a realm converted at runtime
 * and one built by the script produce byte-identical output.
 */
export function indexShops(source: RealmSource): BuiltShop[] {
  const shops = source.table('Shops');
  if (shops === null) return [];

  const built: BuiltShop[] = [];
  for (const row of shops.rows) {
    const id = number(row['Number']);
    if (id === null || id <= 0) continue;

    const items: number[] = [];
    for (const [column, value] of Object.entries(row)) {
      if (!/^Item-\d+$/.test(column)) continue;
      const item = number(value);
      // Zero is the realm's empty slot, not item zero.
      if (item !== null && item > 0) items.push(item);
    }
    const kind = number(row['ShopType']);
    /*
     * A shop with nothing on its shelves is a placeholder — unless it is a
     * bank, a temple, an inn or a training room, which stock nothing and are
     * still the place they are. Those are kept for their kind alone: the
     * glyph beside `Bank of Godfrey` comes from exactly this row.
     */
    const placeOnly = kind !== null && [5, 7, 8, 9].includes(kind);
    if (items.length === 0 && !placeOnly) continue;

    const entry: BuiltShop = { id, n: text(row['Name']).trim(), items };
    const markup = number(row['Markup%']);
    if (markup !== null && markup > 0) entry.markup = markup;
    if (kind !== null && kind > 0) entry.t = kind;
    built.push(entry);
  }

  return built.sort((a, b) => a.id - b.id);
}

/**
 * Every spell the realm names.
 *
 * The whole table, for the reason the monster index takes the whole table and
 * the item index does not: an exit tells you in advance which key it wants, and
 * nothing tells you in advance which spell somebody will look up.
 *
 * A row with no name is a gap in the table rather than a spell, and is skipped.
 */
export function indexSpells(source: RealmSource): BuiltSpell[] {
  const spells = source.table('Spells');
  if (spells === null) return [];

  const built: BuiltSpell[] = [];
  for (const row of spells.rows) {
    const id = number(row['Number']);
    const name = text(row['Name']).trim();
    if (id === null || name.length === 0) continue;

    const entry: BuiltSpell = { id, n: name };
    const short = text(row['Short']).trim();
    if (short.length > 0 && short.toLowerCase() !== name.toLowerCase()) entry.short = short;
    // Each omitted when the realm does not state it: zero mana is a real
    // answer for some spells, and absent is not zero.
    const level = number(row['ReqLevel']);
    if (level !== null && level > 0) entry.level = level;
    const mana = number(row['ManaCost']);
    if (mana !== null && mana > 0) entry.mana = mana;
    const energy = number(row['EnergyCost']);
    if (energy !== null && energy > 0) entry.energy = energy;
    const dur = number(row['Dur']);
    if (dur !== null && dur > 0) entry.dur = dur;
    /*
     * Who it may be cast on. Zero is the realm's *no target* answer — every
     * one of the 72 rows holding it is a monster's breath, a trap or a
     * caster-only effect — so it is left out like every other zero here and
     * read back as "the realm does not say", which keeps a picker open
     * rather than closing it on an absence.
     */
    const targets = number(row['Targets']);
    if (targets !== null && targets > 0) entry.tg = targets;
    // Format 20. Zero is the realm's *never resisted* and is left out like
    // every zero here; absent reads back as the cast that lands.
    const resists = number(row['TypeOfResists']);
    if (resists !== null && resists > 0 && resists !== BLANK_AS_NUMBER) entry.res = resists;
    const ab = abilityPairs(row);
    if (ab.length > 0) entry.ab = ab;
    /*
     * The spell's own magnitude — format 16.
     *
     * Signed and kept as stated: 167 spells state a negative power, which is a
     * spell that takes something away, and clamping those to zero would turn a
     * debuff into a no-op on the card. A growth pair is written only when both
     * halves are real, because `+3 every 0 levels` is not a rate — measured on
     * the shipped realm, no row states one without the other.
     */
    const minBase = number(row['MinBase']) ?? 0;
    const maxBase = number(row['MaxBase']) ?? 0;
    if (minBase !== 0 || maxBase !== 0) entry.pw = [minBase, maxBase];
    const cap = number(row['Cap']);
    if (cap !== null && cap > 0) entry.cap = cap;
    for (const [levels, amount, field] of [
      ['MinIncLVLs', 'MinInc', 'mig'],
      ['MaxIncLVLs', 'MaxInc', 'mag'],
      ['DurIncLVLs', 'DurInc', 'dug']
    ] as const) {
      const per = number(row[levels]);
      const step = number(row[amount]);
      if (per !== null && per > 0 && step !== null && step !== 0) entry[field] = [per, step];
    }
    built.push(entry);
  }

  return built.sort((a, b) => a.id - b.id);
}

/**
 * A stat's `[minimum, maximum]`, or nothing.
 *
 * Both ends or neither: half a range is not a range, and a maximum drawn
 * against a missing minimum reads as a range starting at zero.
 */
function span(row: Record<string, unknown>, stat: string): [number, number] | undefined {
  const low = number(row[`m${stat}`]);
  const high = number(row[`x${stat}`]);
  if (low === null || high === null || low <= 0 || high <= 0) return undefined;
  return [low, high];
}

/**
 * Every race the realm offers.
 *
 * Thirteen rows on the shipped realm, and small enough to carry whole. Unlike
 * the monster table there is no `In Game` flag here: a race in the table is a
 * race the character-creation screen offers.
 */
export function indexRaces(source: RealmSource): BuiltRace[] {
  const races = source.table('Races');
  if (races === null) return [];

  const built: BuiltRace[] = [];
  for (const row of races.rows) {
    const id = number(row['Number']);
    const name = text(row['Name']).trim();
    if (id === null || name.length === 0) continue;

    const entry: BuiltRace = { id, n: name };
    for (const [key, stat] of [
      ['int', 'INT'],
      ['wil', 'WIL'],
      ['str', 'STR'],
      ['hea', 'HEA'],
      ['agl', 'AGL'],
      ['chm', 'CHM']
    ] as const) {
      const range = span(row, stat);
      if (range) entry[key] = range;
    }
    // Zero is "no bonus" and is left out rather than drawn as a bonus of none;
    // only the Half-Ogre states one on the shipped realm.
    const hp = number(row['HPPerLVL']);
    if (hp !== null && hp > 0) entry.hpPerLevel = hp;
    /*
     * **Any stated number is kept, including a negative one**, unlike the hit
     * points above. This is not a bonus that zero means nothing about — it is
     * one of the two terms of `100 + race + class`, which is the multiplier the
     * whole experience table is built from (`src/shared/experience.ts`). Stock
     * MajorMUD prices a Thief at **-20**, and dropping the sign there costs
     * every Thief a fifth more experience per level than the realm charges.
     * Zero is left out because zero contributes nothing to a sum.
     */
    const exp = number(row['ExpTable']);
    if (exp !== null && exp !== 0) entry.expTable = exp;
    const ab = abilityPairs(row);
    if (ab.length > 0) entry.ab = ab;
    built.push(entry);
  }

  return built.sort((a, b) => a.id - b.id);
}

/**
 * Every class the realm offers.
 *
 * Fifteen rows. See `BuiltClass` for the two columns deliberately not carried:
 * a hit-dice pair whose order nothing has settled, and a magery *type* whose
 * numbering only says something for zero.
 */
export function indexClasses(source: RealmSource): BuiltClass[] {
  const classes = source.table('Classes');
  if (classes === null) return [];

  const built: BuiltClass[] = [];
  for (const row of classes.rows) {
    const id = number(row['Number']);
    const name = text(row['Name']).trim();
    if (id === null || name.length === 0) continue;

    const entry: BuiltClass = { id, n: name };
    // Negative is a real price and zero is not; see `indexRaces`.
    const exp = number(row['ExpTable']);
    if (exp !== null && exp !== 0) entry.expTable = exp;
    // A class with no magery states level 0, which is an absence rather than a
    // level: a Warrior drawn as "magery 0" reads as a caster with none left.
    const magery = number(row['MageryLVL']);
    if (magery !== null && magery > 0) entry.magery = magery;
    const combat = number(row['CombatLVL']);
    if (combat !== null && combat > 0) entry.combat = combat;
    const ab = abilityPairs(row);
    if (ab.length > 0) entry.ab = ab;
    built.push(entry);
  }

  return built.sort((a, b) => a.id - b.id);
}

/**
 * Every monster the realm has, by name, with the health it is worth.
 *
 * The whole table rather than the referenced subset the item index takes, and
 * deliberately: an item index only needs the hundred-odd keys some exit asks
 * for, while *any* monster in the realm can walk into the room and start
 * hitting somebody. About 1,800 rows collapse to roughly 1,450 names and a few
 * tens of kilobytes before compression, which is a fair price for the one
 * number a fight is judged on.
 *
 * **Rows the realm has switched off are left out.** `In Game` is the realm
 * builder's own flag for content that exists in the table and not in the world;
 * including it would let a retired monster's health widen the range of a name a
 * live one shares, and the widening is invisible from the outside.
 *
 * Sorted by name so a realm converted at runtime and one built by the script
 * produce byte-identical output.
 */
export function indexMobs(source: RealmSource, itemNames?: Map<number, string>): BuiltMob[] {
  const monsters = source.table('Monsters');
  if (monsters === null) return [];

  /**
   * The worst of the rows sharing a name, for a column where "worst" is
   * *higher*.
   *
   * The health span's rule applied to every number added in format 12: a name
   * resolves to several rows, and the reassuring end of a range is the
   * dangerous one to act on. `8224` is refused along the way — it is two ASCII
   * spaces in a numeric column, which `mdb-reader` surfaces as an integer, and
   * it appears on 348 rows of the shipped realm's `Items.Speed` alone.
   */
  const worse = (held: number | undefined, value: number | null): number | undefined => {
    if (value === null || value <= 0 || value === BLANK_AS_NUMBER) return held;
    return held === undefined || value > held ? value : held;
  };
  /** And for a column where the cautious answer is *lower* — what it is worth. */
  const least = (held: number | undefined, value: number | null): number | undefined => {
    if (value === null || value <= 0 || value === BLANK_AS_NUMBER) return held;
    return held === undefined || value < held ? value : held;
  };

  const spans = new Map<
    string,
    {
      lo: number;
      hi: number;
      how: Set<MobDisposition>;
      costs: boolean[];
      ids: number[];
      ac?: number;
      dr?: number;
      mr?: number;
      xp?: number;
      rgn?: number;
      fol?: number;
      und?: 1;
      /** Format 18: gathered rather than reduced, for the reason `ty` states. */
      types: Set<number>;
      dmg?: number;
      chl?: number;
      /** Every spell any row casts mid-fight, and every death spell. */
      casts: Set<number>;
      deathSpell?: number;
      /** Format 20: each distinct row profile, keyed on its own JSON. */
      profiles: Map<string, MobProfile>;
      drops: Set<string>;
      /**
       * Ability id → every value the rows sharing this name state for it.
       *
       * A **set**, not the maximum, because "worst" only means "highest" for a
       * magnitude. See the fold below.
       */
      abil: Map<number, Set<number>>;
    }
  >();
  for (const row of monsters.rows) {
    // Absent column and present-but-zero are both "this realm does not say",
    // and neither may become a maximum of zero — a bar against zero is a
    // division nobody can read.
    const hp = number(row['HP']);
    if (hp === null || hp <= 0) continue;
    // `In Game` is 0/1 in every export seen; a realm without the column at all
    // is taken at face value rather than emptied.
    if ('In Game' in row && number(row['In Game']) === 0) continue;

    const name = text(row['Name']).trim().toLowerCase();
    if (name.length === 0) continue;

    /*
     * Whether it starts the fight, from the two columns the server reads.
     *
     * Spelled `Align` in the `.mdb` every derivative distributes and
     * `Alignment` in the extraction the GreaterMUD server itself loads, which
     * is the same drift `In Game` has — so both are accepted rather than one
     * of them producing a realm whose monsters are all silently peaceable.
     * A realm stating neither column contributes nothing, and the name is
     * written without a disposition rather than with a made-up one.
     */
    const align = number(row['Align'] ?? row['Alignment']);
    const kind = number(row['Type']);

    const span = spans.get(name);
    const how = span?.how ?? new Set<MobDisposition>();
    if (align !== null) how.add(dispositionOf(align, kind ?? 0));
    /*
     * Every row's answer is kept rather than folded to a single flag, because
     * *all of them* and *some of them* are different facts and the difference
     * is what keeps the refusal from swallowing the first monster anybody
     * meets. `giant rat` is two ChaoticEvil rows and one Good one.
     */
    const costs = span?.costs ?? [];
    if (align !== null) costs.push(costsAlignment(align));

    const id = number(row['Number']);
    const entry = span ?? {
      lo: hp,
      hi: hp,
      how,
      costs,
      ids: id === null ? [] : [id],
      types: new Set<number>(),
      casts: new Set<number>(),
      profiles: new Map<string, MobProfile>(),
      drops: new Set<string>(),
      abil: new Map<number, Set<number>>()
    };
    if (span) {
      if (id !== null) entry.ids.push(id);
      if (hp < entry.lo) entry.lo = hp;
      if (hp > entry.hi) entry.hi = hp;
    }

    /*
     * Format 12. Every one of these is optional in the realm data and several
     * derivatives omit whole columns, so each is folded through `worse`/`least`
     * rather than read — a column this realm does not have contributes nothing
     * instead of contributing a zero.
     */
    entry.ac = worse(entry.ac, number(row['ArmourClass']));
    entry.dr = worse(entry.dr, number(row['DamageResist']));
    entry.mr = worse(entry.mr, number(row['MagicRes']));
    entry.xp = least(entry.xp, number(row['EXP']));
    entry.rgn = worse(entry.rgn, number(row['HPRegen']));
    entry.fol = worse(entry.fol, number(row['Follow%']));
    if (number(row['Undead']) === 1) entry.und = 1;
    /*
     * Format 18. `ty` is gathered because nothing reduces it — see the field.
     * `dmg` takes the worst, like `ac` and `dr`; `chl` takes the worst too,
     * which here is the *highest* level required to charm it. The spells are
     * gathered: a name that resolves to several rows may have one row that
     * detonates on death, and that is the row an automation must decline.
     */
    const kindOf = number(row['Type']);
    if (kindOf !== null) entry.types.add(kindOf);
    entry.dmg = worse(entry.dmg, number(row['AvgDmg']));
    entry.chl = worse(entry.chl, number(row['CharmLVL']));
    for (let slot = 0; slot < MID_SPELL_SLOTS; slot += 1) {
      const cast = number(row[`MidSpell-${slot}`]);
      if (cast !== null && cast > 0) entry.casts.add(cast);
    }
    const onDeath = number(row['DeathSpell']);
    if (onDeath !== null && onDeath > 0) entry.deathSpell = onDeath;
    /*
     * Format 20: how this row fights, kept per row and de-duplicated on its
     * own JSON so four identical `barmaid` rows are one profile. The insertion
     * order is the rows' order, which is what keeps two builds byte-identical.
     */
    const profile = rowProfile(row);
    if (profile !== null) {
      const key = JSON.stringify(profile);
      if (!entry.profiles.has(key)) entry.profiles.set(key, profile);
    }
    /*
     * The effect system — format 14. Every value every row states, gathered
     * here and reduced per id below, because how to reduce depends on the id.
     *
     * 100 of the 234 names shared by several rows disagree about their effects
     * (measured against `gmud20230902`, 2026-08-31): a `zombie` is three rows,
     * one of them 100% cold-resistant and another not.
     */
    for (const [which, value] of abilityPairs(row)) {
      const held = entry.abil.get(which);
      if (held === undefined) entry.abil.set(which, new Set([value]));
      else held.add(value);
    }
    /*
     * Its drop table, by name. The item numbers are useless to a reader and the
     * item index does not carry every item, so a drop whose name nothing knows
     * is left out rather than written as a number.
     */
    if (itemNames !== undefined) {
      for (const [column, value] of Object.entries(row)) {
        if (!/^DropItem-\d+$/.test(column)) continue;
        const dropped = number(value);
        if (dropped === null || dropped <= 0) continue;
        const named = itemNames.get(dropped);
        if (named !== undefined && named.length > 0) entry.drops.add(named);
      }
    }

    if (!span) spans.set(name, entry);
  }

  return [...spans.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([n, span]) => {
      const mob: BuiltMob = { n, hp: span.lo };
      if (span.ids.length > 0) mob.i = span.ids;
      if (span.hi > span.lo) mob.hi = span.hi;
      if (span.how.size > 0) mob.d = DISPOSITION_CODE[worstDisposition(span.how)];
      // 21 of 1,514 names in the shipped realm, `giant rat` among them. The
      // flag is what stops the worst case being acted on as though it were the
      // answer; see `WorldMob.uncertain`.
      if (span.how.size > 1) mob.x = 1;
      const cost = alignmentCost(span.costs);
      if (cost !== 'never') mob.ep = cost === 'always' ? 'a' : 's';
      // Format 12, each omitted where the realm said nothing.
      if (span.ac !== undefined) mob.ac = span.ac;
      if (span.dr !== undefined) mob.dr = span.dr;
      if (span.mr !== undefined) mob.mr = span.mr;
      if (span.xp !== undefined) mob.xp = span.xp;
      if (span.rgn !== undefined) mob.rgn = span.rgn;
      if (span.fol !== undefined) mob.fol = span.fol;
      if (span.und !== undefined) mob.und = span.und;
      // Format 18. Sorted so a file written twice from one database matches.
      if (span.types.size > 0) mob.ty = [...span.types].sort((a, b) => a - b);
      if (span.dmg !== undefined) mob.dmg = span.dmg;
      if (span.chl !== undefined) mob.chl = span.chl;
      if (span.casts.size > 0) mob.cast = [...span.casts].sort((a, b) => a - b);
      if (span.deathSpell !== undefined) mob.ds = span.deathSpell;
      // Format 20. Row order, not sorted: a profile has no natural key and
      // the rows' order is the one order every build of one database shares.
      if (span.profiles.size > 0) mob.pf = [...span.profiles.values()].map(compactProfile);
      // Capped and sorted: "one of these six" is a lead, a list of forty is
      // not, and a stable order is what keeps two builds byte-identical.
      if (span.drops.size > 0) mob.drops = [...span.drops].sort().slice(0, 6);
      /*
       * **Every distinct value every row states**, and no reduction here.
       *
       * The first attempt folded to the maximum, on the reading that the worst
       * of the rows is the highest — which is right for a magnitude and wrong
       * for the two shapes whose value is a *row id*. `SpellImmu 40` and
       * `SpellImmu 45` on the two `ancient sand dragon` rows are two different
       * spells, not a bigger number, and `dwarven warrior` row 446 states
       * `MonsGuards` twice in one row (424 and 426): a maximum silently drops
       * one of them.
       *
       * Deciding per id would mean reading `ABILITY_SHAPE` here, and that is
       * exactly the display judgement this file refuses to make — see the note
       * on `BuiltItem.ab`. A shape is a claim from another client's source and
       * may be corrected; baking one into the file every future card reads
       * would make the correction unreachable without a rebuild.
       *
       * So the realm's own answer is written whole, one pair per distinct
       * value — which is the shape `EffectRows` already collects by id, the
       * same way `ClassOk` lists several classes. It costs 178 extra pairs
       * across the whole realm (measured 2026-08-31), and the card decides how
       * to read them: the *high* end of a magnitude, every one of a reference.
       *
       * Sorted throughout rather than kept in the realm's slot order, because
       * the fold is across rows and "the order" is no longer any one row's. A
       * stable order is what keeps a realm converted at runtime byte-identical
       * to one built by the script.
       */
      if (span.abil.size > 0) {
        const pairs: Array<[number, number]> = [];
        for (const [which, values] of [...span.abil.entries()].sort(([a], [b]) => a - b)) {
          for (const value of [...values].sort((a, b) => a - b)) pairs.push([which, value]);
        }
        mob.ab = pairs;
      }
      return mob;
    });
}

/**
 * Every item name the realm has, lower-cased and sorted.
 *
 * The recognition half of the item table, kept apart from `indexItems`'s
 * detail half — see `BuiltRealm.header.itemNames` for why the two are not one
 * list. A row with no name is a gap in the table rather than an item.
 */
export function indexItemNames(source: RealmSource): string[] {
  const items = source.table('Items');
  if (items === null) return [];

  const names = new Set<string>();
  for (const row of items.rows) {
    const name = text(row['Name']).trim().toLowerCase();
    if (name.length > 0) names.add(name);
  }
  // Sorted so a realm converted at runtime and one built by the script produce
  // byte-identical output, as every other index here is.
  return [...names].sort();
}

/**
 * Which items the exits actually need, and where a player might get one.
 *
 * A locked door says `Key: 1124`, which tells nobody anything. Only the items
 * some exit references are indexed — about a hundred of them — so this costs a
 * few kilobytes rather than carrying the whole item table.
 *
 * Provenance is best-effort and says so. Roughly half of these keys are dropped
 * by a monster and a handful are sold in a shop; the rest are not answerable
 * from this database at all, and an entry with neither is more honest than a
 * guess.
 */
export function indexItems(source: RealmSource, needed: Set<number>): BuiltItem[] {
  if (needed.size === 0) return [];

  const rowsOf = (name: string): Record<string, unknown>[] => source.table(name)?.rows ?? [];

  const names = new Map<number, string>();
  const prices = new Map<number, number>();
  const weights = new Map<number, number>();
  /** Format 18: `Gettable`, `Not Droppable` and `Limit`, only where notable. */
  const flags = new Map<number, { ngt?: 1; ndr?: 1; lim?: number }>();
  const abilities = new Map<number, Array<[number, number]>>();
  /** Who the realm lets use a thing — `ClassRest-n` / `RaceRest-n`, format 15. */
  const restrictions = new Map<number, Pick<BuiltItem, 'cls' | 'race'>>();
  /** Everything about an item that depends on what kind of thing it is. */
  const kinds = new Map<number, Pick<BuiltItem, 'type' | 'worn' | 'wpn' | 'arm' | 'uses'>>();
  /** A column's value when it is a positive number, else undefined. */
  const positive = (row: Record<string, unknown>, column: string): number | undefined => {
    const value = number(row[column]);
    return value !== null && value > 0 ? value : undefined;
  };
  for (const item of rowsOf('Items')) {
    const id = number(item['Number']);
    if (id === null || !needed.has(id)) continue;
    names.set(id, text(item['Name']));
    const price = number(item['Price']);
    if (price !== null && price > 0) prices.set(id, price);
    const encumbrance = number(item['Encum']);
    if (encumbrance !== null && encumbrance > 0) weights.set(id, encumbrance);
    /*
     * Format 18: the two refusals and the cap.
     *
     * Only the refusals are written. 2,594 of the shipped realm's 2,639 items
     * are gettable, so recording the ordinary answer costs a byte per item to
     * say nothing — and absent must read as *gettable*, because on a
     * derivative realm without the column the alternative is an automation
     * that quietly stops looting everything.
     */
    if (number(item['Gettable']) === 0) flags.set(id, { ...flags.get(id), ngt: 1 });
    if (number(item['Not Droppable']) === 1) flags.set(id, { ...flags.get(id), ndr: 1 });
    const limit = number(item['Limit']);
    if (limit !== null && limit > 0) flags.set(id, { ...flags.get(id), lim: limit });

    /*
     * Who may use it — `ClassRest-0..9` and `RaceRest-0..9`, format 15.
     *
     * Read **before** the kind gate below, which is a `continue`: a derivative
     * realm without `ItemType` would otherwise restrict nothing, and an item
     * whose restrictions the client cannot see is one it offers a button for
     * and the server refuses out loud. Same reason the ability pairs moved
     * above that gate.
     *
     * An allow-list where it is stated at all, and zero is the empty slot —
     * exactly like `Abil-n`. Sorted so a file written twice from the same
     * database is the same file.
     */
    const restrictedTo = (prefix: string): number[] | undefined => {
      const found = new Set<number>();
      for (let slot = 0; slot < RESTRICTION_SLOTS; slot += 1) {
        const which = positive(item, `${prefix}-${slot}`);
        if (which !== undefined) found.add(which);
      }
      return found.size > 0 ? [...found].sort((a, b) => a - b) : undefined;
    };
    const cls = restrictedTo('ClassRest');
    const race = restrictedTo('RaceRest');
    if (cls !== undefined || race !== undefined) {
      restrictions.set(id, { ...(cls ? { cls } : {}), ...(race ? { race } : {}) });
    }

    /*
     * What it does — read **before** the kind, because the kind gate below is a
     * `continue`.
     *
     * The effect pairs used to be read after it, so an item on a derivative
     * whose `Items` table lacks `ItemType` was written with no effects at all,
     * silently. The read side had the identical bug in `WorldGraph` and was
     * fixed in the same change; a fix on only one side leaves a realm whose
     * effects were never *written*, which no reader can recover.
     */
    const pairs = abilityPairs(item);
    if (pairs.length > 0) abilities.set(id, pairs);

    /*
     * The kind decides which of the other columns mean anything: `Min`/`Max`
     * are a weapon's and read as zero on a helm; `ArmourClass` is armour's and
     * reads as zero on a sword. Reading them all for every item would carry
     * six zeros per row and invite a card to print them. `ItemType` is a
     * column a derivative may lack, in which case nothing here is claimed.
     */
    const type = number(item['ItemType']);
    if (type === null) continue;
    const kind: Pick<BuiltItem, 'type' | 'worn' | 'wpn' | 'arm' | 'uses'> = { type };
    const worn = positive(item, 'Worn');
    if (worn !== undefined) kind.worn = worn;
    const uses = positive(item, 'UseCount');
    if (uses !== undefined) kind.uses = uses;
    if (itemKind(type) === 'weapon') {
      const min = number(item['Min']) ?? 0;
      const max = number(item['Max']) ?? 0;
      const wpn: NonNullable<BuiltItem['wpn']> = { min, max };
      const spd = positive(item, 'Speed');
      if (spd !== undefined) wpn.spd = spd;
      const str = positive(item, 'StrReq');
      if (str !== undefined) wpn.str = str;
      const acc = positive(item, 'Accy');
      if (acc !== undefined) wpn.acc = acc;
      const weaponType = number(item['WeaponType']);
      if (weaponType !== null) wpn.kind = weaponType;
      kind.wpn = wpn;
    } else if (itemKind(type) === 'armour') {
      const arm: NonNullable<BuiltItem['arm']> = {};
      const ac = positive(item, 'ArmourClass');
      if (ac !== undefined) arm.ac = ac;
      const dr = positive(item, 'DamageResist');
      if (dr !== undefined) arm.dr = dr;
      const armourType = number(item['ArmourType']);
      if (armourType !== null) arm.kind = armourType;
      kind.arm = arm;
    }
    kinds.set(id, kind);

    /*
     * The effect system — format 12. Twenty slots, `Abil-n` naming what and
     * `AbilVal-n` how much, and `0` is the empty slot rather than ability zero.
     * Read in slot order and kept verbatim; `shared/abilities.ts` names them at
     * the point of display, because the *reading* is a claim from another
     * client's source and the number is what the realm said.
     */
  }

  const collect = (
    rows: Record<string, unknown>[],
    columnPattern: RegExp
  ): Map<number, Set<string>> => {
    const found = new Map<number, Set<string>>();
    for (const row of rows) {
      for (const [column, value] of Object.entries(row)) {
        if (!columnPattern.test(column)) continue;
        const id = number(value);
        if (id === null || !needed.has(id)) continue;
        if (!found.has(id)) found.set(id, new Set());
        found.get(id)!.add(text(row['Name']));
      }
    }
    return found;
  };

  const soldBy = collect(rowsOf('Shops'), /^Item-\d+$/);
  const droppedBy = collect(rowsOf('Monsters'), /^DropItem-\d+$/);

  return [...needed]
    .sort((a, b) => a - b)
    .map((id) => {
      const entry: BuiltItem = { id, n: names.get(id) ?? '' };
      const price = prices.get(id);
      if (price !== undefined) entry.price = price;
      const weight = weights.get(id);
      if (weight !== undefined) entry.enc = weight;
      const flag = flags.get(id);
      if (flag?.ngt !== undefined) entry.ngt = flag.ngt;
      if (flag?.ndr !== undefined) entry.ndr = flag.ndr;
      if (flag?.lim !== undefined) entry.lim = flag.lim;
      // Capped: "one of these six" is a lead; a list of forty is not.
      const sold = [...(soldBy.get(id) ?? [])].filter(Boolean).slice(0, 6);
      const dropped = [...(droppedBy.get(id) ?? [])].filter(Boolean).slice(0, 6);
      if (sold.length > 0) entry.shops = sold;
      if (dropped.length > 0) entry.mobs = dropped;
      const effects = abilities.get(id);
      if (effects !== undefined) entry.ab = effects;
      /*
       * The level gate, lifted out of the pairs into a field of its own.
       *
       * It stays in `ab` as well — that array is what the realm said and the
       * Reference card draws it from there — but a *gate* every equip check
       * consults must not make each caller re-scan an untyped pair list for
       * one id. `MinLevel` is ability 135; the realm states it on 953 items.
       */
      const gate = effects?.find(([which]) => which === MIN_LEVEL_ABILITY);
      if (gate !== undefined && gate[1] > 0) entry.lvl = gate[1];
      return { ...entry, ...restrictions.get(id), ...kinds.get(id) };
    });
}
