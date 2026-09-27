/**
 * Every item the realm puts in one slot that this character can use, best
 * first: the slot quick view's answer. Pure over the realm's rows, the equip
 * check (`shared/gear.ts`) and the round arithmetic (`shared/prowess.ts`).
 *
 * Armour ranks by armour class then damage resistance. The weapon hand ranks
 * by damage a round swung the way `combat.attack` swings (attack, bash or
 * smash); any other verb swings no weapon, so the ranking is a plain attack's.
 */
import { commandOf } from '../../shared/commands';
import { equipBlock, type Wearer } from '../../shared/gear';
import { WEAPON_WORN, WORN_SLOT } from '../../shared/items';
import { roundDamage, type ProwessSheet, type SwingMethod } from '../../shared/prowess';
import type { RealmFamily } from '../../shared/realm';
import { meanBlow, type SlotGear, type SlotGearRow, type SlotRanking } from '../../shared/slotGear';
import type { WorldItem } from '../../shared/world';

/** Who is asking, and how they swing. */
export interface SlotAsker {
  wearer: Wearer;
  sheet: ProwessSheet;
  family: RealmFamily | null;
  /** `combat.attack`, the verb the character opens a fight with. */
  attack: string;
}

/** The swing a verb makes, by the realm's command table. */
function swingOf(verb: string): SwingMethod {
  switch (commandOf(verb.trim())) {
    case 'Bash':
      return 'bash';
    case 'Smash':
      return 'smash';
    default:
      return 'attack';
  }
}

function rowOf(item: WorldItem, asker: SlotAsker, method: SwingMethod | null): SlotGearRow {
  const weapon = item.weapon;
  return {
    id: item.id,
    name: item.name,
    minLevel: item.minLevel ?? null,
    // The realm omits a zero, and armour stating none has none.
    ac: item.armour === undefined ? null : (item.armour.ac ?? 0),
    dr: item.armour === undefined ? null : (item.armour.dr ?? 0),
    damage: weapon === undefined ? null : { min: weapon.min, max: weapon.max },
    speed: weapon?.speed ?? null,
    perRound:
      weapon === undefined || method === null
        ? null
        : roundDamage(asker.sheet, weapon, method, asker.family)
  };
}

/** Larger first, an absent figure last. */
function descending(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function better(ranking: SlotRanking): (a: SlotGearRow, b: SlotGearRow) => number {
  const tie = (a: SlotGearRow, b: SlotGearRow): number =>
    a.name.localeCompare(b.name) || a.id - b.id;
  if (ranking.by === 'armour') {
    return (a, b) => descending(a.ac, b.ac) || descending(a.dr, b.dr) || tie(a, b);
  }
  // Where no round can be reckoned, the mean blow still orders the weapons.
  return (a, b) =>
    descending(a.perRound?.value ?? null, b.perRound?.value ?? null) ||
    descending(meanBlow(a.damage), meanBlow(b.damage)) ||
    tie(a, b);
}

/** One `Items.Worn` slot (`wornOfWord`), ranked for this character. */
export function slotGear(
  worn: number,
  realm: { itemsWornIn(worn: number): readonly WorldItem[] },
  asker: SlotAsker
): SlotGear {
  const method = worn === WEAPON_WORN ? swingOf(asker.attack) : null;
  const rows: SlotGearRow[] = [];
  let refused = 0;
  for (const item of realm.itemsWornIn(worn)) {
    if (item.name.trim().length === 0) continue;
    if (equipBlock(item, asker.wearer) !== null) {
      refused += 1;
      continue;
    }
    rows.push(rowOf(item, asker, method));
  }
  const ranking: SlotRanking =
    method === null
      ? { by: 'armour' }
      : { by: 'weapon', method, rounds: rows.some((row) => row.perRound !== null) };
  const { classId, raceId, level, alignment } = asker.wearer;
  return {
    slot: WORN_SLOT[worn] ?? String(worn),
    ranking,
    rows: rows.sort(better(ranking)),
    refused,
    unread: classId === null || raceId === null || level === null || alignment === null
  };
}
