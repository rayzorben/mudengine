/**
 * What an item's abilities are worth beside its armour class (todo 117), in
 * the item's own AC points: the `ArmourClass` column the Reference card lists,
 * ten to a point of the sheet's `Armour Class` (`StatCommand.cs:26`). The
 * player sets each weight per character (`automation.loot.gearWeights`); the
 * slot rankings read it, so the floor gear, the Gear card and the gear trip
 * weigh an item the same way. See `mudengine-automation` › `parts/gear.md`.
 */
import {
  abilityName,
  EFFECT_ABILITY,
  MANA_ABILITY,
  PROTECTION_ABILITY,
  SHOCK_SHIELD_ABILITY,
  STEALTH_ABILITY
} from './abilities';
import { abilitySum } from './light';
import { int, isRecord } from './values';

/** Every ability a weight is set for, in the order the settings draw them. */
export const GEAR_WEIGHT_FIELDS = [
  'damageResist',
  'protectionEvil',
  'protectionGood',
  'maxDamage',
  'accuracy',
  'maxHp',
  'hpRegen',
  'maxMana',
  'manaRegen',
  'stealth',
  'shockShield'
] as const;

export type GearWeightField = (typeof GEAR_WEIGHT_FIELDS)[number];

/** AC points one point of each ability is worth. */
export type GearWeights = Readonly<Record<GearWeightField, number>>;

/** The most a weight may be: a hundred sheet points of armour class for one point of an ability. */
export const MOST_GEAR_WEIGHT = 1000;

/** The weights as a file states them, each read on its own and bounded; a missing or broken one keeps `fallback`'s. */
export function asGearWeights(value: unknown, fallback: GearWeights): GearWeights {
  const raw = isRecord(value) ? value : {};
  return Object.fromEntries(
    GEAR_WEIGHT_FIELDS.map((field) => [
      field,
      int(raw[field], fallback[field], 0, MOST_GEAR_WEIGHT)
    ])
  ) as Record<GearWeightField, number>;
}

/**
 * The shipped weights. ProtEvil and ProtGood at ten AC points a point, as the
 * server adds them against a monster of that alignment (`Mob.cs:1449`); the
 * rest is a judgement each player sets (todo 117, open question).
 */
export const DEFAULT_GEAR_WEIGHTS: GearWeights = {
  damageResist: 1,
  protectionEvil: 10,
  protectionGood: 10,
  maxDamage: 10,
  accuracy: 10,
  maxHp: 5,
  hpRegen: 2,
  maxMana: 2,
  manaRegen: 2,
  stealth: 10,
  shockShield: 5
};

/** The ability row each weight reads. */
export const GEAR_WEIGHT_ABILITY: Readonly<Record<GearWeightField, number>> = {
  damageResist: EFFECT_ABILITY.damageResist,
  protectionEvil: PROTECTION_ABILITY.evil,
  protectionGood: PROTECTION_ABILITY.good,
  maxDamage: EFFECT_ABILITY.maxDamage,
  accuracy: EFFECT_ABILITY.accuracy,
  maxHp: EFFECT_ABILITY.maxHp,
  hpRegen: EFFECT_ABILITY.hpRegen,
  maxMana: MANA_ABILITY.max,
  manaRegen: MANA_ABILITY.regen,
  stealth: STEALTH_ABILITY,
  shockShield: SHOCK_SHIELD_ABILITY
};

/** The weights and the two facts about the character that switch some of them off. */
export interface GearWeighing {
  weights: GearWeights;
  /** The class has a magery level above 0; null while the class is unread, when mana counts nothing and the floor gear swaps no armour. */
  casts: boolean | null;
  /** `movement.sneak` is on: a Stealth loss is a loss only to a character that sneaks. */
  sneaks: boolean;
}

/** What an item states for each weighed ability, and its armour class with any `AC` row (2). */
export interface GearFigures {
  armourClass: number;
  abilities: Readonly<Record<GearWeightField, number>>;
}

/** An item's figures: the `ArmourClass` and `DamageResist` columns plus the rows that add to them. */
export function gearFiguresOf(item: {
  armour?: { ac?: number; dr?: number };
  abilities?: ReadonlyArray<readonly [number, number]>;
}): GearFigures {
  const rows = item.abilities ?? [];
  const abilities = Object.fromEntries(
    GEAR_WEIGHT_FIELDS.map((field) => [field, abilitySum(rows, GEAR_WEIGHT_ABILITY[field])])
  ) as Record<GearWeightField, number>;
  abilities.damageResist += item.armour?.dr ?? 0;
  return {
    armourClass: (item.armour?.ac ?? 0) + abilitySum(rows, EFFECT_ABILITY.armourClass),
    abilities
  };
}

/** The weight that counts for this character: a field it cannot use counts nothing. */
export function weightFor(field: GearWeightField, weighing: GearWeighing): number {
  switch (field) {
    case 'maxMana':
    case 'manaRegen':
      return weighing.casts === true ? weighing.weights[field] : 0;
    case 'stealth':
      return weighing.sneaks ? weighing.weights.stealth : 0;
    case 'damageResist':
    case 'protectionEvil':
    case 'protectionGood':
    case 'maxDamage':
    case 'accuracy':
    case 'maxHp':
    case 'hpRegen':
    case 'shockShield':
      return weighing.weights[field];
    default: {
      const never: never = field;
      return never;
    }
  }
}

/** The item's worth in AC points: its armour class and each ability by its weight. */
export function weighedWorth(figures: GearFigures, weighing: GearWeighing): number {
  return GEAR_WEIGHT_FIELDS.reduce(
    (worth, field) => worth + figures.abilities[field] * weightFor(field, weighing),
    figures.armourClass
  );
}

/** One figure a swap moves, by the realm's ability id (2 for armour class). */
export interface TradePart {
  ability: number;
  by: number;
}

/** What wearing `item` in place of `worn` gains and gives up, counting only what the weights count. */
export interface GearTrade {
  gained: TradePart[];
  lost: TradePart[];
}

export function gearTrade(item: GearFigures, worn: GearFigures, weighing: GearWeighing): GearTrade {
  const parts: TradePart[] = [
    { ability: EFFECT_ABILITY.armourClass, by: item.armourClass - worn.armourClass },
    ...GEAR_WEIGHT_FIELDS.filter((field) => weightFor(field, weighing) !== 0).map((field) => ({
      ability: GEAR_WEIGHT_ABILITY[field],
      by: item.abilities[field] - worn.abilities[field]
    }))
  ];
  return {
    gained: parts.filter((part) => part.by > 0),
    lost: parts.filter((part) => part.by < 0)
  };
}

/** A trade's parts as the realm names its abilities: `AC +75, DR +7`. */
export function tradeWords(parts: readonly TradePart[]): string {
  return parts
    .map(
      ({ ability, by }) =>
        `${abilityName(ability, 'other') ?? `#${ability}`} ${by > 0 ? '+' : ''}${by}`
    )
    .join(', ');
}
