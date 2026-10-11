/**
 * What a damage spell's roll comes to on the way to its target, as GreaterMUD
 * `Spells/Spell.cs` works it out: the caster's spellcasting bonus
 * (`GetSpellDamageWithModifier`) and the target's resistance to the
 * element (`CheckResistance`). Read by the attack-spell choice and by a
 * weapon's hit spells (`hitSpells.ts`).
 */
import { IMMUNE_TO_POISON_ABILITY } from './abilities';
import { abilitySum } from './light';

/**
 * `Spells.AttType`, as `Spell.GetSpellAttackType` reads the column: 0 cold,
 * 1 hot, 2 stone, 3 lightning, 4 normal, 5 water, 6 poison; anything else is
 * normal. The realm's own words for the elements, not this client's.
 */
export type SpellElement = 'cold' | 'fire' | 'stone' | 'lightning' | 'normal' | 'water' | 'poison';

export function spellElementOf(code: number | null | undefined): SpellElement | undefined {
  switch (code) {
    case 0:
      return 'cold';
    case 1:
      return 'fire';
    case 2:
      return 'stone';
    case 3:
      return 'lightning';
    case 4:
      return 'normal';
    case 5:
      return 'water';
    case 6:
      return 'poison';
    default:
      return undefined;
  }
}

/**
 * The ability a monster resists each element with, as `Spell.CheckResistance`
 * reads it off the target: a percentage taken off the damage. Poison is the
 * odd one: `ImmuPoison` at 100 or more turns the whole cast to nothing and
 * anything less lets all of it through.
 */
export const RESIST_ABILITY: Record<Exclude<SpellElement, 'normal' | 'poison'>, number> = {
  cold: 3,
  fire: 5,
  stone: 65,
  lightning: 66,
  water: 147
};

/** The share of an element the target turns away, `CheckResistance` transcribed. */
export function elementFactor(
  element: SpellElement | undefined,
  abilities: ReadonlyArray<readonly [number, number]> | undefined
): number {
  if (element === undefined || element === 'normal') return 1;
  const sum = (id: number): number => abilitySum(abilities ?? [], id);
  if (element === 'poison') return sum(IMMUNE_TO_POISON_ABILITY) >= 100 ? 0 : 1;
  return Math.max(0, 1 - sum(RESIST_ABILITY[element]) / 100);
}

/** `Spell.baseToAccrueSpellCastingDamageBonus` and `extraSpellCastingRequiredToIncrementBonus`. */
const SPELLCASTING_BONUS_FROM = 100;
const SPELLCASTING_PER_PERCENT = 50;

/**
 * `GetSpDmgMultiplierFromSC` as a factor: one per cent for each whole 50
 * spellcasting above 100, applied to every spell a player casts, a hit spell
 * included. The caster's `AlterSpellDamage` rows are not counted, and an
 * unread spellcasting is taken as no bonus, so the figure is a floor.
 */
export function spellcastingFactor(spellcasting: number | null): number {
  if (spellcasting === null) return 1;
  const percent = Math.trunc(
    Math.max(0, spellcasting - SPELLCASTING_BONUS_FROM) / SPELLCASTING_PER_PERCENT
  );
  return 1 + percent / 100;
}
