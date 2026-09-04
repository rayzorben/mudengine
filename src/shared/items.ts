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
  12: 'Off Hand',
  14: 'Wrist',
  15: 'Ears',
  16: 'Worn',
  17: 'Readied',
  19: 'Face'
};

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
