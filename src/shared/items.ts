/**
 * What kind of thing an item is, and the words the realm uses for its parts.
 *
 * Armour is not a weapon is not a scroll, and the `Items` table says which
 * with one column, `ItemType`, whose numbers decide which of the *other*
 * columns mean anything: `Min`/`Max`/`Speed` are a weapon's and read as zero
 * on a helm, `ArmourClass`/`DamageResist` are armour's and read as zero on a
 * sword. A card that showed every column for every item would be a table dump;
 * one that knows the kind shows the four numbers that decide whether to buy it.
 *
 * **Read out of the realm data, not from a specification.** The server's own
 * enum is not on disk here; the numbers below were settled by sampling every
 * value of each column against the names that carry it in `gmud20230902.mdb`
 * (`ItemType=1` is 496 rows of swords, maces and staves; `=9` is 251 rows every
 * one of which begins `scroll of`) and cross-checked against the words MegaMUD
 * and the legacy CoffeeScript client (`src/classes/worn.coffee`) used for the
 * same numbers. A value the sample did not contain is not named.
 *
 * Dependency-free: the build script writes the numbers, `WorldGraph` reads them
 * back, and the renderer chooses a card by them.
 */

/** `Items.ItemType`, as words. */
export type ItemKind =
  | 'armour'
  | 'weapon'
  | 'trap'
  | 'sign'
  | 'food'
  | 'drink'
  | 'light'
  | 'key'
  | 'container'
  | 'scroll'
  | 'misc';

const ITEM_KINDS: readonly ItemKind[] = [
  'armour', // 0 — padded vest, chainmail hauberk, and also every ring and amulet
  'weapon', // 1 — broadsword, quarterstaff, fist
  'trap', // 2 — net, bola, poisoned shuriken: thrown, and six rows in the whole realm
  'sign', // 3 — glyphs and signs: room furniture that is read, never taken
  'food', // 4
  'drink', // 5 — potions are drinks; `minor healing potion` is here
  'light', // 6 — torch, lantern
  'key', // 7
  'container', // 8 — chests and boxes
  'scroll', // 9
  'misc' // 10 — rope and grapple, hides, orbs; everything the table has no better word for
];

/** The kind for an `ItemType` value, or null for one the sample never showed. */
export function itemKind(type: number): ItemKind | null {
  return Number.isInteger(type) && type >= 0 ? (ITEM_KINDS[type] ?? null) : null;
}

/** The word a card puts in a chip beside the name. */
export const ITEM_KIND_WORD: Record<ItemKind, string> = {
  armour: 'armour',
  weapon: 'weapon',
  trap: 'thrown',
  sign: 'sign',
  food: 'food',
  drink: 'drink',
  light: 'light',
  key: 'key',
  container: 'container',
  scroll: 'scroll',
  misc: 'item'
};

/**
 * `Items.Worn`: where an item goes when it is worn or held.
 *
 * The same twelve-and-some slots the legacy client enumerated, which is the
 * list MegaMUD's inventory screen used — and the words the server's own `i`
 * listing prints in the trailing parenthesis, as far as it has been seen to
 * print them (`Weapon Hand`, `Head`, `Torso`, `Feet`, `Hands`). The numbers
 * 13 and 18 do not occur in the realm and are not named.
 */
export const WORN_SLOT: Readonly<Record<number, string>> = {
  1: 'Weapon Hand',
  2: 'Head',
  3: 'Hands',
  4: 'Finger',
  5: 'Feet',
  6: 'Arms',
  7: 'Back',
  8: 'Neck',
  9: 'Legs',
  10: 'Waist',
  11: 'Torso',
  /*
   * Hyphenated, and the only one of the eighteen that is. Read as `Off
   * Hand` until 2026-09-22, which matched nothing: the server's own
   * definition is `new EquippedItemLocationDefinition(12, "Off-Hand", 1)`
   * (`RealmEquippedItemManager.cs:24`) and the wire prints `(Off-Hand)`
   * 181 times in this machine's logs and `(Off Hand)` never. Every other
   * word here matches the same file exactly.
   */
  12: 'Off-Hand',
  14: 'Wrist',
  15: 'Ears',
  16: 'Worn',
  17: 'Readied',
  19: 'Face'
};

/**
 * `Worn` code 1 — the hand a weapon is swung with, by the word the listing
 * prints for it (`ice crystal falchion (Weapon Hand)`, live 2026-09-11).
 *
 * Named because one slot in the table decides something on its own: a refusal
 * the server blames on *this weapon* lasts as long as this weapon, and the
 * only way to notice the hand has changed is to read it. Everything else in
 * `WORN_SLOT` is the Reference card's.
 */
export const WEAPON_HAND = 'Weapon Hand';

/**
 * `Worn` code 12 — the other hand, which a two-handed weapon takes with it.
 *
 * Named for the same reason `WEAPON_HAND` is: one slot decides something on
 * its own. A shield here is what an equipment set has to take off before a
 * two-hander goes on, and the server refuses the `wear` otherwise.
 */
export const OFF_HAND = 'Off-Hand';

/**
 * `Items.WeaponType`: **handedness × damage kind**, which is two axes and not
 * one.
 *
 * This was `{blunt, staff, sharp, two-handed}` for six phases — two values
 * named by damage kind and two by a word off the sample — so nothing in the
 * table said that a `staff` needs both hands, and a reader comparing a `staff`
 * against a `two-handed` weapon would conclude only one of them did.
 *
 * The realm's own enum is a 2×2 (`GetWeaponTypeEnum` in MMUD-Explorer's
 * `modMMudFunc.bas`), and the shipped realm proves the axis rather than merely
 * asserting it: **`flail` appears under both 0 and 1**, which is exactly what
 * a one-handed and a two-handed flail look like and is unsayable in the old
 * naming. Counts and samples from `gmud20230902.mdb`, live rows only:
 *
 * | v | rows | sample |
 * |---|---|---|
 * | 0 | 113 | mace, black flail, steel nunchaku, morning-star |
 * | 1 | 68 | quarterstaff, darkwood staff, kusari gama, **flail** |
 * | 2 | 183 | broadsword, hellblade, golden battleaxe, mithril cutlass |
 * | 3 | 97 | greatsword, halberd, greataxe, witchwood spear |
 *
 * Written as two fields rather than one string because the two are asked
 * about separately: handedness decides whether an off-hand slot is free, and
 * the damage kind is what a monster's `DamageResist` is written against.
 */
export interface WeaponClass {
  /** How many hands it takes. */
  hands: 1 | 2;
  /** What it does when it lands. */
  damage: 'blunt' | 'sharp';
}

export const WEAPON_CLASS: Readonly<Record<number, WeaponClass>> = {
  0: { hands: 1, damage: 'blunt' },
  1: { hands: 2, damage: 'blunt' },
  2: { hands: 1, damage: 'sharp' },
  3: { hands: 2, damage: 'sharp' }
};

/** The same four as one phrase, for a chip that has room for one. */
export const WEAPON_TYPE: Readonly<Record<number, string>> = {
  0: 'one-handed blunt',
  1: 'two-handed blunt',
  2: 'one-handed sharp',
  3: 'two-handed sharp'
};

/**
 * `Items.ArmourType`: what the armour is made of, which is what its class
 * restrictions are written against.
 *
 * **1 and 2 were the wrong way round.** They were sampled, and the sample for
 * `1` opened on `padded vest` — but padded and silk share class 1, because for
 * restriction purposes they are one class, the lightest. So the label was taken
 * from one member of a class of two, and `2` inherited `silk` from the only
 * word left. The realm settles it:
 *
 * ```
 *   289 silk robe        arm=1      368 black ninja robes  arm=2
 *   429 silk gloves      arm=1       54 black tabi         arm=2
 *  2213 silkweave robes  arm=1     2126 midnight sash      arm=2
 *     9 grey robes       arm=1
 *   332 padded vest      arm=1
 * ```
 *
 * Every silk and every robe is `1`; `2` is five rows and all of them ninja
 * gear. It matters because this is what a class restriction reads: a card
 * telling a mage `black ninja robes` are silk is offering something wearable
 * that is not.
 *
 * **The word for 1 is `cloth`, and neither source's word was right.** Listing
 * all 153 live rows of it: padded, cotton, silk, satin, silversilk, spider
 * silk, robes, cloaks, sandals, gloves. `padded` was true of five of them and
 * MMUD-Explorer's `Silk` of perhaps forty; `cloth` is true of the class, which
 * is what the class *is* — the lightest armour, the one a caster may wear.
 * (A handful of rows — `brass knuckles`, `iron crown` — are miscategorised in
 * the realm database itself, which is the realm's answer and not ours to fix.)
 *
 * `GetArmourTypeEnum` in MMUD-Explorer groups 3–6 as one `Leather`, where the
 * sample here tells the four apart, so the finer reading is kept.
 */
export const ARMOUR_TYPE: Readonly<Record<number, string>> = {
  0: 'none',
  1: 'cloth',
  2: 'ninja',
  3: 'leather',
  4: 'feather',
  5: 'rigid leather',
  6: 'studded leather',
  7: 'chain',
  8: 'scale',
  9: 'plate'
};

/**
 * An item's name with the listing's decorations off, for comparing two of them.
 *
 * The realm, the listings and the sentences the server volunteers do not agree
 * on how to spell one item. A listing annotates with a slot — `padded boots
 * (Feet)`, `torch (Readied/79)` — and prose puts an article in front of it, so
 * `You are now wearing the padded boots.` and the listing's own row are one
 * item written three ways.
 *
 * **Only a trailing parenthesised group, and only one.** An item genuinely
 * called `flask (empty)` has its own name read as an annotation, which is wrong
 * in a way that costs a label rather than an item. `parseCarried` makes the
 * same trade deliberately so the two cannot disagree about where a name ends.
 *
 * Here rather than beside the parser because the *renderer* needs the same
 * answer: a card that offers to put an item back on has to compare the pack's
 * spelling against a remembered one, and a second copy of this rule is how the
 * button and the command come to disagree about whether an item is held.
 */
export function bareName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s*\([^()]*\)\s*$/, '')
    .replace(/^(?:an?|the|some)\s+/, '')
    .trim();
}

/**
 * Whether two spellings name the same item.
 *
 * The two sources disagree in a way that is entirely predictable, and missing
 * it broke the thing the maintained inventory exists for. An `i` listing
 * annotates anything worn or wielded with the **slot it is in** —
 * `padded vest (Torso)`, `quarterstaff (Weapon Hand)` — and the sentence that
 * reports putting it down does not: `You dropped quarterstaff.` So every drop
 * of something equipped compared `quarterstaff (weapon hand)` against
 * `quarterstaff`, matched nothing, and left the item in the card until the next
 * `i` — which is precisely the command the maintained listing exists to save.
 *
 * The article is stripped for the same defensive reason it always was — no
 * capture has shown `a healing potion` listed against `healing potion`, and the
 * cost of being wrong is an item that can be picked up and never put down.
 */
export function sameItem(a: string, b: string): boolean {
  return bareName(a) === bareName(b);
}

/**
 * A listing entry split into how many and what, because the count is not part
 * of the name.
 *
 * Every listing this server prints counts the same way — `2 scroll of magic
 * missile` in the pack, `66 bone key` on the floor, `2 black star keys` among
 * the keys — and every one of them reads as an item called "2 …" until the
 * figure is taken off the front. The pack's own listing has done this since
 * 2026-08-26 (`parseCarriedEntries`); the other two did not, and the cost was
 * the reported failure: a character holding `2 bone key` could not be seen to
 * hold *bone key*, so the realm's row for it was never found and the keyed
 * door it opens stayed a wall (todo 01).
 *
 * **The name is left exactly as the listing spelled it otherwise** — no
 * article stripped, no annotation taken off, no plural undone. Those are
 * `bareName`'s job and a caller's, and a realm that pluralises a counted
 * entry (`2 black star keys` for the row `black star key`, captures/002) is a
 * name only an index can settle. Guessing here would put a name the realm
 * does not have into the client's own state.
 *
 * **A figure no listing could have written is not a figure**, and the entry is
 * returned whole with a count of one. `LISTING_COUNT_CEILING` is a sanity
 * bound rather than a threshold anything decides on — callers expand a count
 * into that many instances, and `Array.from({ length: 1e23 })` is a thrown
 * `RangeError` in the middle of the parse path. It lives here because
 * `src/shared` is dependency-free by rule and cannot read `internal.yaml`.
 * `count === 1` and no figure at all are deliberately the same answer: one of
 * a thing is one of a thing.
 */
export function countedName(entry: string): { count: number; name: string } {
  const trimmed = entry.trim();
  const match = /^(?<count>\d+) (?<rest>\S.*)$/.exec(trimmed);
  if (!match?.groups) return { count: 1, name: trimmed };
  const count = Number(match.groups['count']);
  if (!Number.isSafeInteger(count) || count < 1 || count > LISTING_COUNT_CEILING) {
    return { count: 1, name: trimmed };
  }
  return { count, name: match.groups['rest']!.trim() };
}

/**
 * The largest count `countedName` will read off a listing entry.
 *
 * The floor of a mummy's crypt held 66 bone keys and a starter shop stocks 31
 * quarterstaffs, so the realm's own numbers are two orders of magnitude under
 * this. Anything above it is a garbled line, and reading it as a count is a
 * caller allocating an array that size.
 */
const LISTING_COUNT_CEILING = 10_000;

/**
 * A counted entry written back the way the server wrote it.
 *
 * The inverse of {@link countedName}, and it exists because the split has a
 * reader on the other side: a card drawing `item.name` alone after the figure
 * moved onto `count` would show *bone key* where the floor holds sixty-six,
 * which is a listing that lies about what is there. One statement of the
 * spelling, so the readout and the clipboard cannot disagree.
 *
 * Absent and one are the same answer, because the server prints neither.
 */
export function countedLabel(item: { name: string; count?: number }): string {
  return item.count !== undefined && item.count > 1 ? `${item.count} ${item.name}` : item.name;
}

/**
 * A list of instances read back as the server would print it.
 *
 * The key ring is held as instances — `2 bone key` is two keys, which is what
 * lets the realm's row for one be found at all — and a card joining those
 * would read *bone key, bone key*, then *bone key, bone key, bone key*. Both
 * spellings are things this server has actually printed (`golden idol, golden
 * idol` on one realm, `2 golden idols` on another), so neither is wrong; the
 * counted one is the one that stays readable when a character is standing on a
 * crypt floor holding sixty-six.
 *
 * First appearance decides the order, so the ring does not reshuffle itself
 * between listings, and the spelling is the listing's own — nothing here
 * pluralises a name the realm did not.
 */
export function countedList(names: readonly string[]): string[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const name of names) {
    const seen = counts.get(name);
    if (seen === undefined) order.push(name);
    counts.set(name, (seen ?? 0) + 1);
  }
  return order.map((name) => countedLabel({ name, count: counts.get(name)! }));
}

/**
 * The ability id an item's `Abil-n` slot uses to name a spell it casts.
 *
 * `CastsSp` in MegaMUD's vocabulary and `CastSpell` in the server's
 * (`GMUDAbilities.CastSpell = 43`).
 */
const CASTS_SPELL = 43;

/**
 * And the one that turns the *next* `CastsSp` into a hit-proc instead.
 *
 * `GMUDAbilities.PercentSpell = 114`. The server's own comment on this is
 * *"this is retarded logic, but it's the way MajorMUD works so we're stuck
 * with it"* — a `CastsSp` preceded by a `PercentSpell` is the chance-on-hit
 * pair, and a bare one is something the player invokes.
 */
const PERCENT_SPELL = 114;

/** What an item casts when it is used, and whether using it costs a charge. */
export interface ItemInvocation {
  /** The `Spells` row it casts. */
  spell: number;
  /**
   * True where the realm states `UseCount: -1`.
   *
   * The distinction is the whole of whether invoking it is free: 39 items in
   * the shipped realm are unlimited and 266 are not, and an item with three
   * charges spent on a buff is three charges somebody was saving.
   */
  unlimited: boolean;
}

/**
 * What an item casts when somebody types `use <it>`, or null for one that
 * casts nothing that way.
 *
 * **Read out of the server rather than inferred from the ability's name.**
 * `ItemType.cs` walks an item's ability slots in order and rewrites a bare
 * `CastSpell` into `UseSpell` as it loads — so an item carrying `CastsSp` with
 * no `PercentSpell` immediately before it is a `use`-able item, and one with
 * it is a chance-on-hit proc that no command can trigger. A `shimmering
 * longsword` carries **both**: `[43, 114]` at slot 2 is the bless it can be
 * asked for, and `[114, 40], [43, 170]` at slots 3 and 4 are a forty-per-cent
 * proc it cannot.
 *
 * The first bare one wins. No item in either database on this machine carries
 * two, and picking between them would be a guess about which the player meant.
 */
export function itemInvocation(item: {
  /**
   * `WorldItem.abilities` — the runtime spelling. The *built* record calls the
   * same column `ab`; this reads the one the client holds at runtime, which is
   * the one every caller has.
   */
  abilities?: ReadonlyArray<readonly [number, number]>;
  uses?: number;
}): ItemInvocation | null {
  const pairs = item.abilities ?? [];
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (pair === undefined || pair[0] !== CASTS_SPELL) continue;
    if (index > 0 && pairs[index - 1]?.[0] === PERCENT_SPELL) continue;
    const spell = pair[1];
    // Slot zero is the realm's empty cell, not a spell.
    if (spell <= 0) continue;
    return { spell, unlimited: item.uses === -1 };
  }
  return null;
}

/** A chance-on-hit the realm hangs off an item. */
export interface HitProc {
  /** The `Spells` row it casts when it fires. */
  spell: number;
  /** The realm's own percentage, as `PercentSpell` states it. */
  chance: number;
}

/**
 * The chance-on-hit procs `itemInvocation` deliberately steps over.
 *
 * The other half of the same pair, and read the same way round: `ItemType.cs`
 * leaves a `CastSpell` preceded by a `PercentSpell` alone, so *that* one is the
 * proc no command can trigger — a `shimmering longsword` carries `[43, 114]`
 * (the bless `use` invokes) and then `[114, 40], [43, 170]`, a forty-per-cent
 * chance of casting `silvery mace` on a blow that lands.
 *
 * It matters because **the sentence a proc prints names nobody**. `A shining
 * spark strikes cave worm for 3 damage!` is the spell's own message data with
 * the target and the number substituted in; there is no attacker in it to
 * read, and a damage line with no attacker was being booked to everybody
 * *else* in the room. This is the only thing on the client that can say the
 * blow was this character's own — the realm stating that what it wields fires
 * one.
 *
 * Every pair, not the first: an item may carry several, and the question the
 * caller asks is whether this thing procs at all.
 */
export function itemHitProcs(item: {
  abilities?: ReadonlyArray<readonly [number, number]>;
}): HitProc[] {
  const pairs = item.abilities ?? [];
  const found: HitProc[] = [];
  for (let index = 1; index < pairs.length; index += 1) {
    const pair = pairs[index];
    const before = pairs[index - 1];
    if (pair === undefined || pair[0] !== CASTS_SPELL) continue;
    if (before === undefined || before[0] !== PERCENT_SPELL) continue;
    // Slot zero is the realm's empty cell, not a spell.
    if (pair[1] <= 0) continue;
    found.push({ spell: pair[1], chance: before[1] });
  }
  return found;
}
