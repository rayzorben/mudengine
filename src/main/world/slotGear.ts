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
import { WEAPON_CLASS, WEAPON_WORN, WORN_SLOT } from '../../shared/items';
import { roundDamage, type ProwessSheet, type SwingMethod } from '../../shared/prowess';
import type { RealmFamily } from '../../shared/realm';
import {
  meanBlow,
  type SlotFigures,
  type SlotGear,
  type SlotGearRow,
  type SlotRanking
} from '../../shared/slotGear';
import type { CharacterState } from '../../shared/character';
import { prowessSheetOf } from '../../shared/verdict';
import type { WorldItem } from '../../shared/world';
import { wearerOf, type WearerRealm } from './wearer';

/** Who is asking, and how they swing. */
export interface SlotAsker {
  wearer: Wearer;
  sheet: ProwessSheet;
  family: RealmFamily | null;
  /** `combat.attack`, the verb the character opens a fight with. */
  attack: string;
}

/** The asker for a character: who it is in the realm's rows, its sheet, and how it swings. */
export function slotAskerOf(
  state: CharacterState,
  world: WearerRealm | null,
  cls: { combat: number | null; magery: number | null; family: RealmFamily | null },
  attack: string
): SlotAsker {
  return {
    wearer: wearerOf(state, world),
    sheet: prowessSheetOf(state, cls),
    family: cls.family,
    attack
  };
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

/**
 * An item's own figures, where no round is reckoned: a row's, or a worn item
 * the list does not hold.
 */
export function figuresOfItem(item: Pick<WorldItem, 'armour' | 'weapon'>): SlotFigures {
  return {
    // The realm omits a zero, and armour stating none has none.
    ac: item.armour === undefined ? null : (item.armour.ac ?? 0),
    dr: item.armour === undefined ? null : (item.armour.dr ?? 0),
    damage: item.weapon === undefined ? null : { min: item.weapon.min, max: item.weapon.max },
    perRound: null
  };
}

function rowOf(item: WorldItem, asker: SlotAsker, method: SwingMethod | null): SlotGearRow {
  const weapon = item.weapon;
  const { ac, dr, damage } = figuresOfItem(item);
  return {
    id: item.id,
    name: item.name,
    minLevel: item.minLevel ?? null,
    ac,
    dr,
    weight: item.encumbrance ?? 0,
    weaponClass: weapon?.kind === undefined ? null : (WEAPON_CLASS[weapon.kind] ?? null),
    damage,
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

/**
 * Which of two rows gives more in the slot, by its figures alone: negative
 * where `a` does, 0 where they give the same. An upgrade is a row this puts
 * ahead of what is worn; two that tie are not upgrades over each other
 * (2026-10-01: sandals and cloth shoes, 10 AC each, bought in turn).
 */
export function outranks(ranking: SlotRanking): (a: SlotFigures, b: SlotFigures) => number {
  if (ranking.by === 'armour') {
    return (a, b) => descending(a.ac, b.ac) || descending(a.dr, b.dr);
  }
  // Where no round can be reckoned, the mean blow still orders the weapons.
  return (a, b) =>
    descending(a.perRound?.value ?? null, b.perRound?.value ?? null) ||
    descending(meanBlow(a.damage), meanBlow(b.damage));
}

function better(ranking: SlotRanking): (a: SlotGearRow, b: SlotGearRow) => number {
  const figures = outranks(ranking);
  return (a, b) => figures(a, b) || a.name.localeCompare(b.name) || a.id - b.id;
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
