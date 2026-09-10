/**
 * What a rank title says about the person wearing it.
 *
 * A `who` row carries a **rank title** and never a class or a level — `Vaelor`
 * is listed as `Kai Warrior` and nothing else. The title is not decorative: the
 * server picks it from a per-class list indexed by level, so it names the class
 * and pins the level to a five-level band. That is the only thing this client
 * can ever learn about somebody it has never met and shares no gang with, and
 * `PlayerRecord.level` / `.race` / `.className` are otherwise `null` forever
 * for every player outside this character's own gang.
 *
 * **Where the table comes from.** The realm database this client converts does
 * not carry it: `Classes` in both `mdb/` archives has no title column, and the
 * server reads the chains from its own text blocks instead
 * (`Class.cs`: `TextBlocks[TitleText][0].Data.Split('\n')`, one line per level,
 * `male|female` where the two differ). Read on 2026-09-10 from the GreaterMUD
 * server's own database script — `GreaterMUD.Database.Data.GMUDOfficial/
 * 00_Types/Textblocks.sql`, blocks 3001-3015, joined to `Classes.sql`'s
 * `Title Text` column — and folded into the level bands below. Levels past the
 * end of a chain wear no title the server will print; `GetTitleForLevel`
 * answers `Unknown` there, so a band simply stops.
 *
 * **Checked against the wire, both realms.** `captures/076` has a character
 * whose `who` row reads `Monk` and whose `look` description reads `Mystic` —
 * this table reads `Monk` as Mystic 20-24, which is why that capture is the
 * counter-example the `who` pattern cites and not a contradiction. `Squire`,
 * `Acolyte` and `Spellslinger` from the same corpus land on Paladin 10-14,
 * Cleric 15-19 and Warlock 10-14; `Kai Warrior` and `Apprentice`, recorded
 * live on the GreaterMUD realm, land on Mystic 25-29 and level 1 of every
 * class.
 *
 * **One table for every realm, and that is a claim with a date on it.** The
 * chains live on the *server*, not in the data a realm ships, so there is no
 * per-realm copy to key this on; the two realms this client has seen titles
 * from — stock MajorMUD in the corpus and Paradigm's data live — print titles
 * from this list. A derivative that renames them simply fails to match, which
 * is the honest outcome: an unrecognised title reads as nothing known rather
 * than as a class. If a realm turns up whose titles collide with these under
 * different classes, this becomes per-`RealmFamily`.
 *
 * `src/shared/` cannot read a file, and this is the realm's own vocabulary, so
 * it lives in code like `SHIPPED_WORLD_LABEL` and the direction codes.
 */

/** One title, and the lowest and highest level a class wears it at. */
export type TitleBand = readonly [title: string, from: number, to: number];

/**
 * Every class's chain, in the realm's own class order.
 *
 * A gendered rank is two bands over the same levels (`Lord` and `Lady` are both
 * Warrior 45-49), because the wire prints one of the pair and the reader is
 * looking up whichever they were shown.
 */
export const CLASS_TITLES: Readonly<Record<string, readonly TitleBand[]>> = {
  Warrior: [
    ['Apprentice', 1, 1],
    ['Warrior Novice', 2, 4],
    ['Grunt', 5, 9],
    ['Fighter', 10, 14],
    ['Veteran', 15, 19],
    ['Mercenary', 20, 24],
    ['Duelist', 25, 29],
    ['Dragoon', 30, 34],
    ['Gladiator', 35, 39],
    ['Myrmidon', 40, 44],
    ['Lady', 45, 49],
    ['Lord', 45, 49],
    ['Hero', 50, 54],
    ['Heroine', 50, 54],
    ['Weaponmaster', 55, 59],
    ['Weaponmistress', 55, 59],
    ['Warmonger', 60, 64],
    ['Warlady', 65, 69],
    ['Warlord', 65, 69],
    ['Dragonslayer', 70, 100]
  ],
  Witchunter: [
    ['Apprentice', 1, 1],
    ['Witchunter Novice', 2, 4],
    ['Persecutor', 5, 9],
    ['Magehunter', 10, 14],
    ['Magebane', 15, 19],
    ['Spellbreaker', 20, 24],
    ['Enforcer', 25, 29],
    ['Disenchanter', 30, 34],
    ['Eradicator', 35, 39],
    ['Demonhunter', 40, 44],
    ['Mageslayer', 45, 49],
    ['Annihilator', 50, 54],
    ['Inquisitor', 55, 59],
    ['High Inquisitor', 60, 64],
    ['Master Confessor', 65, 69],
    ['Demonbane', 70, 100]
  ],
  Paladin: [
    ['Apprentice', 1, 1],
    ['Paladin Novice', 2, 4],
    ['Knave', 5, 9],
    ['Squire', 10, 14],
    ['Gallant', 15, 19],
    ['Defender', 20, 24],
    ['Cavalier', 25, 29],
    ['Avenger', 30, 34],
    ['Knight', 35, 39],
    ['Crusader', 40, 44],
    ['Templar', 45, 49],
    ['Champion', 50, 54],
    ['First Knight', 55, 59],
    ['Lady Justice', 60, 64],
    ['Lord Justice', 60, 64],
    ['Supreme Justice', 65, 69],
    ['Grand Exemplar', 70, 100]
  ],
  Cleric: [
    ['Apprentice', 1, 1],
    ['Cleric Novice', 2, 4],
    ['Auxiliary', 5, 9],
    ['Venerator', 10, 14],
    ['Acolyte', 15, 19],
    ['Fighter Priest', 20, 24],
    ['Fighter Priestess', 20, 24],
    ['Canon', 25, 29],
    ['Warrior Priest', 30, 34],
    ['Warrior Priestess', 30, 34],
    ['Guardian', 35, 39],
    ['Chaplain', 40, 44],
    ['Vicar', 45, 49],
    ['Chancellor', 50, 54],
    ['Rector', 55, 59],
    ['High Cleric', 60, 64],
    ['Divine Protector', 65, 69],
    ['Exalted Shield', 70, 100]
  ],
  Priest: [
    ['Apprentice', 1, 1],
    ['Priest Novice', 2, 4],
    ['Clergyman', 5, 9],
    ['Clergywoman', 5, 9],
    ['Curate', 10, 14],
    ['Pastor', 15, 19],
    ['Reverend', 20, 24],
    ['Parson', 25, 29],
    ['Minister', 30, 34],
    ['Cardinal', 35, 39],
    ['Pontiff', 40, 44],
    ['Bishop', 45, 49],
    ['High Priest', 50, 54],
    ['High Priestess', 50, 54],
    ['Archbishop', 55, 59],
    ['Chosen', 60, 64],
    ['Prophet', 65, 69],
    ['Voice of God', 70, 100]
  ],
  Missionary: [
    ['Apprentice', 1, 1],
    ['Missionary Novice', 2, 4],
    ['Initiate', 5, 9],
    ['Witness', 10, 14],
    ['Rogue Priest', 15, 19],
    ['Rogue Priestess', 15, 19],
    ['Converter', 20, 24],
    ['Infiltrator', 25, 29],
    ['Oracle', 30, 34],
    ['Evangelist', 35, 39],
    ['Diviner', 40, 44],
    ['Faithbringer', 45, 49],
    ['Zealot', 50, 54],
    ['Divine Messenger', 55, 59],
    ['Apostle', 60, 64],
    ['Archangel', 65, 69],
    ["God's Hand", 70, 100]
  ],
  Ninja: [
    ['Apprentice', 1, 1],
    ['Ninja Novice', 2, 4],
    ['Menace', 5, 9],
    ['Cutthroat', 10, 14],
    ['Stalker', 15, 19],
    ['Killer', 20, 24],
    ['Nightstalker', 25, 29],
    ['Murderer', 30, 34],
    ['Manhunter', 35, 39],
    ['Nightblade', 40, 44],
    ['Assassin', 45, 49],
    ['Executioner', 50, 54],
    ['Revenant', 55, 59],
    ['Master Assassin', 60, 64],
    ['Shadow Master', 65, 69],
    ['Shadow Mistress', 65, 69],
    ["Death's Hand", 70, 100]
  ],
  Thief: [
    ['Apprentice', 1, 1],
    ['Thief Novice', 2, 4],
    ['Rascal', 5, 9],
    ['Footpad', 10, 14],
    ['Pilferer', 15, 19],
    ['Pickpocket', 20, 24],
    ['Cutpurse', 25, 29],
    ['Bandit', 30, 34],
    ['Burglar', 35, 39],
    ['Rogue', 40, 44],
    ['Sharper', 45, 49],
    ['Magsman', 50, 54],
    ['Master Rogue', 55, 59],
    ['Rogue Prince', 60, 64],
    ['Rogue Princess', 60, 64],
    ['Underlord', 65, 69],
    ['The Hand', 70, 100]
  ],
  Bard: [
    ['Apprentice', 1, 1],
    ['Bard Novice', 2, 4],
    ['Jester', 5, 9],
    ['Lyricist', 10, 14],
    ['Entertainer', 15, 19],
    ['Sonnateer', 20, 24],
    ['Skald', 25, 29],
    ['Troubadour', 30, 34],
    ['Musician', 35, 39],
    ['Minstrel', 40, 44],
    ['Swashbuckler', 45, 49],
    ['Songweaver', 50, 54],
    ['Chanteur', 55, 59],
    ['Chanteuse', 55, 59],
    ['Virtuoso', 60, 64],
    ['Artiste', 65, 69],
    ['Maestro', 70, 100]
  ],
  Gypsy: [
    ['Apprentice', 1, 1],
    ['Gypsy Novice', 2, 4],
    ['Scallywag', 5, 9],
    ['Trickster', 10, 14],
    ['Charlatan', 15, 19],
    ['Vixen', 15, 19],
    ['Traveler', 20, 24],
    ['Wanderer', 25, 29],
    ['Wayfarer', 30, 34],
    ['Nomad', 35, 39],
    ['Voyager', 40, 44],
    ['Arbiter', 45, 49],
    ['Visionary', 50, 54],
    ['Seer', 55, 59],
    ['Seeress', 55, 59],
    ['Gypsy Prince', 60, 64],
    ['Gypsy Princess', 60, 64],
    ['Lady of Fortune', 65, 69],
    ['Lord of Fortune', 65, 69],
    ["Fortune's Hand", 70, 100]
  ],
  Warlock: [
    ['Apprentice', 1, 1],
    ['Warlock Novice', 2, 4],
    ['Dabbler', 5, 9],
    ['Spellslinger', 10, 14],
    ['Occultist', 15, 19],
    ['Cabalist', 20, 24],
    ['Warrior Mage', 25, 29],
    ['Erudite', 30, 34],
    ['Rubicant', 35, 39],
    ['Evoker', 40, 44],
    ['Diabolist', 45, 49],
    ['Spellbinder', 50, 54],
    ['Swordsmage', 55, 59],
    ['Battlemage', 60, 64],
    ['Warmage', 65, 69],
    ['Grand Magiavant', 70, 100]
  ],
  Mage: [
    ['Apprentice', 1, 1],
    ['Mage Novice', 2, 4],
    ['Adept', 5, 9],
    ['Prestidigator', 10, 14],
    ['Illusionist', 15, 19],
    ['Theurgist', 20, 24],
    ['Conjurer', 25, 29],
    ['Magician', 30, 34],
    ['Sorcerer', 35, 39],
    ['Arcanist', 40, 44],
    ['Magus', 45, 49],
    ['Wizard', 50, 54],
    ['High Mage', 55, 59],
    ['Archmage', 60, 64],
    ['Lady Magus', 65, 69],
    ['Lord Magus', 65, 69],
    ['Supreme Archmagi', 70, 100]
  ],
  Druid: [
    ['Apprentice', 1, 1],
    ['Druid Novice', 2, 4],
    ['Naturalist', 5, 9],
    ['Cultivator', 10, 14],
    ['Herbalist', 15, 19],
    ['Elementalist', 20, 24],
    ["Nature's Servant", 25, 29],
    ['Sage', 30, 34],
    ['Savant', 35, 39],
    ['Shaman', 40, 44],
    ['Shamaness', 40, 44],
    ['Astromancer', 45, 49],
    ['High Druid', 50, 54],
    ['Archdruid', 55, 59],
    ['Woodland Lady', 60, 64],
    ['Woodland Lord', 60, 64],
    ['Lady of Nature', 65, 69],
    ['Lord of Nature', 65, 69],
    ["Nature's Spirit", 70, 100]
  ],
  Ranger: [
    ['Apprentice', 1, 1],
    ['Ranger Novice', 2, 4],
    ['Strider', 5, 9],
    ['Excursionist', 10, 14],
    ['Scout', 15, 19],
    ['Explorer', 20, 24],
    ['Guide', 25, 29],
    ['Woodsman', 30, 34],
    ['Woodswoman', 30, 34],
    ['Courser', 35, 39],
    ['Tracker', 40, 44],
    ['Pathfinder', 45, 49],
    ['Hunter', 50, 54],
    ['Huntress', 50, 54],
    ['Ranger Lady', 55, 59],
    ['Ranger Lord', 55, 59],
    ['Master Hunter', 60, 64],
    ['Master Huntress', 60, 64],
    ['Lady of the Hunt', 65, 69],
    ['Lord of the Hunt', 65, 69],
    ["Nature's Fury", 70, 100]
  ],
  Mystic: [
    ['Apprentice', 1, 1],
    ['Mystic Novice', 2, 4],
    ['Student', 5, 9],
    ['Disciple', 10, 14],
    ['Seeker', 15, 19],
    ['Monk', 20, 24],
    ['Kai Warrior', 25, 29],
    ['Monk Lady', 30, 34],
    ['Monk Lord', 30, 34],
    ['Maharishi', 35, 39],
    ['Sensei', 40, 44],
    ['Guru', 45, 49],
    ['Lama', 50, 54],
    ['Master of the Way', 55, 59],
    ['Mistress of the Way', 55, 59],
    ['Kai Lady', 60, 64],
    ['Kai Lord', 60, 64],
    ['Kai Master', 65, 69],
    ['Kai Mistress', 65, 69],
    ['Supreme Kai', 70, 99]
  ]
};

/** What a title was read as: the classes that wear it, and the levels they do. */
export interface TitleReading {
  /** Every class whose chain carries this title, in the realm's class order. */
  classes: readonly string[];
  /** The lowest level any of them wears it at. */
  from: number;
  /** The highest. */
  to: number;
}

/**
 * The lookup, built once: a title is one string in a table of 270.
 *
 * Keyed on the title folded to lower case with its runs of spaces collapsed —
 * the chains carry trailing spaces (`Venerator  `, `Grand Magiavant `) and a
 * `who` row is read out of a fixed-width column, so neither side's spacing is
 * worth trusting.
 */
const BY_TITLE = ((): ReadonlyMap<string, TitleReading> => {
  const index = new Map<string, { classes: string[]; from: number; to: number }>();
  for (const [className, bands] of Object.entries(CLASS_TITLES)) {
    for (const [title, from, to] of bands) {
      const key = titleKey(title);
      const found = index.get(key);
      if (found === undefined) {
        index.set(key, { classes: [className], from, to });
        continue;
      }
      if (!found.classes.includes(className)) found.classes.push(className);
      found.from = Math.min(found.from, from);
      found.to = Math.max(found.to, to);
    }
  }
  return index;
})();

function titleKey(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The class and level band a rank title names, or `null` for one this table
 * does not carry.
 *
 * Several classes share `Apprentice` at level 1, so `classes` is a list and not
 * a name: reading it as one class would state a class from a title that says
 * only "level 1". The caller decides whether one candidate is worth drawing.
 */
export function titleReading(title: string | null | undefined): TitleReading | null {
  if (typeof title !== 'string') return null;
  const key = titleKey(title);
  if (key.length === 0) return null;
  return BY_TITLE.get(key) ?? null;
}
