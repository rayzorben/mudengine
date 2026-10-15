/**
 * A weapon's hit spells (todo 36): the procs `itemHitProcs` reads off the
 * item's slots the way `ItemType` does, joined to their spell rows.
 * `PlayerAttackType` rolls each on every blow that does damage and does not
 * kill, at level 0 (`RollAndApplySpellAbilities(…, 0, …)`): the spell's base
 * power, where `stat all`'s `(+xtra)` scales it to the character's level and
 * counts no miss or resistance. A martial attack casts none
 * (`ApplyWeaponHitSpell`).
 */
import { HAZARD_ABILITY } from './abilities';
import { between, type Random } from './dice';
import { itemHitProcs } from './items';
import { magicResistance, RESIST_ROLL_CEILING } from './menace';
import { elementFactor, spellcastingFactor } from './spellDamage';
import { spellReaches, type MonsterNature } from './spellReach';
import type { WorldSpell } from './world';

export interface HitSpell {
  /** Per cent of qualifying blows that cast it. */
  chance: number;
  spell: WorldSpell;
}

/** What of the target a hit spell reads; absent is unknown. */
export interface HitSpellTarget {
  magicRes?: number | null;
  abilities?: ReadonlyArray<readonly [number, number]> | undefined;
  nature?: MonsterNature | undefined;
}

/** The hit spells an item casts on a blow, each joined to its spell row; a row the realm lacks is left out. */
export function hitSpellsOf(
  item: Parameters<typeof itemHitProcs>[0],
  spellById: (id: number) => WorldSpell | null
): HitSpell[] {
  return itemHitProcs(item).flatMap(({ spell, chance }) => {
    const row = spellById(spell);
    return row === null || chance <= 0 ? [] : [{ chance, spell: row }];
  });
}

/** The abilities whose figure comes off the target's health on the cast, and whether magic resistance scales it. */
const DAMAGE: ReadonlyMap<number, { magicRes: boolean; element: boolean }> = new Map([
  [HAZARD_ABILITY.damage, { magicRes: false, element: true }],
  [HAZARD_ABILITY.damageWithMr, { magicRes: true, element: true }],
  [HAZARD_ABILITY.drain, { magicRes: false, element: false }]
]);

/** One hit spell as it meets a target: the chance a damaging blow casts it and lands, and its damage per roll. */
export interface HitSpellCast {
  /** Fraction of damaging blows that cast it and are not resisted. */
  chance: number;
  /** The damage of each roll from the low end to the high, equally likely. */
  damage: readonly number[];
}

/**
 * The weapon's hit spells that do damage to this target, each with its
 * chance and its damage per roll. A spell that does something other than
 * damage, or poisons over time, is left out; a target whose nature is not
 * known to let the spell through takes nothing from it; an unread magic
 * resistance is taken as the most there is; and the caster's
 * `AlterSpellDamage` is not counted.
 */
export function hitSpellCasts(
  hits: readonly HitSpell[] | undefined,
  target: HitSpellTarget,
  spellcasting: number | null
): HitSpellCast[] {
  if (hits === undefined || hits.length === 0) return [];
  const bonus = spellcastingFactor(spellcasting);
  const casts: HitSpellCast[] = [];
  for (const { chance, spell } of hits) {
    if (spellReaches(spell, target.nature, true) !== true) continue;
    const [low, high] = spell.power ?? [0, 0];
    if (high < low) continue;
    const { factor, resist } = magicResistance(spell, target.magicRes ?? RESIST_ROLL_CEILING);
    const element = elementFactor(spell.element, target.abilities);
    const damage: number[] = [];
    for (let roll = low; roll <= high; roll++) {
      let total = 0;
      for (const [ability, stated] of spell.abilities ?? []) {
        const how = DAMAGE.get(ability);
        if (how === undefined) continue;
        // A figure the row states is hit as it stands, past every modifier (`abil.Sum == 0 ? modifiedValue : abil.Sum`, Spell.cs).
        if (stated !== 0) {
          total += Math.max(0, stated);
          continue;
        }
        const value = Math.trunc(Math.trunc(roll * bonus) * (how.magicRes ? factor : 1));
        if (value > 0) total += how.element ? Math.trunc(value * element) : value;
      }
      damage.push(total);
    }
    if (damage.some((each) => each > 0)) {
      casts.push({ chance: (Math.min(100, chance) / 100) * (1 - resist), damage });
    }
  }
  return casts;
}

/** What the casts add to one damaging blow, the mean over the rolls. */
export function hitSpellMean(casts: readonly HitSpellCast[]): number {
  let total = 0;
  for (const { chance, damage } of casts) {
    total += (chance * damage.reduce((sum, each) => sum + each, 0)) / damage.length;
  }
  return total;
}

/** What the casts do after one damaging blow, rolled as `PlayerAttackType` rolls each. */
export function rollHitSpells(random: Random, casts: readonly HitSpellCast[]): number {
  let total = 0;
  for (const { chance, damage } of casts) {
    if (random() < chance) total += damage[between(random, 0, damage.length - 1)]!;
  }
  return total;
}
