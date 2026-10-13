/**
 * Every item the realm puts in one slot that this character can use, best
 * first: the slot quick view's answer. Pure over the realm's rows, the equip
 * check (`shared/gear.ts`) and the round arithmetic (`shared/prowess.ts`).
 *
 * Armour ranks by worth (armour class and the abilities by the player's
 * weights, `shared/gearWeighing.ts`, todo 117), then armour class, then damage
 * resistance. The weapon hand ranks by damage a round swung the way
 * `combat.attack` swings (attack, bash or smash); any other verb swings no
 * weapon, so the ranking is a plain attack's.
 */
import { gearEffect, NO_EFFECT, sumEffects } from '../../shared/blessingeffects';
import { commandOf } from '../../shared/commands';
import { equipBlock, type Wearer } from '../../shared/gear';
import {
  gearFiguresOf,
  weighedWorth,
  type GearWeighing,
  type GearWeights
} from '../../shared/gearWeighing';
import { WEAPON_CLASS, WEAPON_WORN, WORN_SLOT } from '../../shared/items';
import {
  roundDamage,
  type ProwessClass,
  type ProwessSheet,
  type SwingMethod
} from '../../shared/prowess';
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
  /** The sheet with the weapon hand empty, so a candidate's rows replace the hand's rather than add to them. */
  sheet: ProwessSheet;
  family: RealmFamily | null;
  /** `combat.attack`, the verb the character opens a fight with. */
  attack: string;
  /** What an armour slot weighs beside armour class (todo 117). */
  weighing: GearWeighing;
}

/** The settings the weighing reads, as every caller holds them. */
export interface WeighingSettings {
  loot: { gearWeights: GearWeights };
  movement: { sneak: boolean };
}

/** The asker for a character: who it is in the realm's rows, its sheet, how it swings and what it weighs. */
export function slotAskerOf(
  state: CharacterState,
  world: WearerRealm | null,
  cls: ProwessClass & { family: RealmFamily | null },
  attack: string,
  settings: WeighingSettings
): SlotAsker {
  const items = state.inventory.items.filter((item) => !(item.equipped && item.kind === 'weapon'));
  return {
    wearer: wearerOf(state, world),
    sheet: prowessSheetOf({ ...state, inventory: { ...state.inventory, items } }, cls),
    family: cls.family,
    attack,
    weighing: weighingOf(cls, settings)
  };
}

/** What the character's settings and class say to weigh: mana only for a class with magery, Stealth only while sneaking. */
export function weighingOf(
  cls: Pick<ProwessClass, 'magery'>,
  settings: WeighingSettings
): GearWeighing {
  return {
    weights: settings.loot.gearWeights,
    casts: cls.magery === null ? null : cls.magery > 0,
    sneaks: settings.movement.sneak
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
export function figuresOfItem(
  item: Pick<WorldItem, 'armour' | 'weapon' | 'abilities'>,
  weighing: GearWeighing
): SlotFigures {
  const figures = gearFiguresOf(item);
  const weighed =
    item.armour !== undefined || weighedWorth(figures, weighing) !== figures.armourClass;
  return {
    figures,
    worth: item.weapon === undefined && weighed ? weighedWorth(figures, weighing) : null,
    // The realm omits a zero, and armour stating none has none.
    ac: item.armour === undefined ? null : (item.armour.ac ?? 0),
    dr: item.armour === undefined ? null : (item.armour.dr ?? 0),
    damage: item.weapon === undefined ? null : { min: item.weapon.min, max: item.weapon.max },
    perRound: null
  };
}

function rowOf(item: WorldItem, asker: SlotAsker, method: SwingMethod | null): SlotGearRow {
  const weapon = item.weapon;
  const { ac, dr, damage, figures, worth } = figuresOfItem(item, asker.weighing);
  return {
    figures,
    worth,
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
        : roundDamage(holding(asker.sheet, item), weapon, method, asker.family)
  };
}

/** The sheet with the candidate in hand: its `MaxDamage` and `Speed` rows on top of the rest of the gear. */
function holding(sheet: ProwessSheet, item: WorldItem): ProwessSheet {
  const own = gearEffect([{ equipped: true, abilities: item.abilities }]);
  return own === null
    ? sheet
    : { ...sheet, effects: sumEffects([sheet.effects ?? NO_EFFECT, own]) };
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
    return (a, b) =>
      descending(a.worth, b.worth) || descending(a.ac, b.ac) || descending(a.dr, b.dr);
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
