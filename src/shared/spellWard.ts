/**
 * Whether a monster's spell reaches the character, as `Spell.Cast` decides it
 * for a player target: a worn item that negates the spell
 * (`ItemType.DoesNegateSpell`) takes the whole cast off it, and so does
 * ImmuPoison against any spell carrying Poison (GreaterMUD.Module
 * `Spell.cs:970-1000`). The fight sim and `menace` both read `wardedFrom`.
 * See todo 2322-01.
 */
import { carriesAbility, HAZARD_ABILITY, HURTS, IMMUNE_TO_POISON_ABILITY } from './abilities';
import { abilitySum } from './light';
import { poisons } from './spellcraft';
import type { ItemEntity } from './entities';
import { hazardWithout, type SpellHazard, type WorldSpell } from './world';

/** What the character wears and is, as far as a spell reaching it goes. */
export interface SpellWard {
  /** Spell ids a worn item negates. */
  negates: ReadonlySet<number>;
  /** ImmuPoison on a row the character holds: a spell with Poison negated whole. */
  poisonImmune: boolean;
  /**
   * ImmuPoison summing to 100 or more over those rows: a poison-typed
   * spell's damage is 0 (`Spell.CheckResistance`, `Spell.cs:745`). Festus, a
   * Kang, 2026-11-21: `You take 0 damage from the poisonous swamp!`.
   */
  poisonProof: boolean;
}

/** No ward: every spell reaches. */
export const NO_WARD: SpellWard = { negates: new Set(), poisonImmune: false, poisonProof: false };

/** The ImmuPoison sum `Spell.CheckResistance` turns a poison-typed spell's damage to 0 at. */
const POISON_PROOF_AT = 100;

/**
 * The ward of what is worn, with ImmuPoison off the class or race rows or
 * off a worn item's own rows. `immunity` is the class and race rows'
 * ImmuPoison sum where one of them holds a row, null where neither does or
 * neither is read; the worn items' sums are added to it. A carried
 * "nowhere" item also negates on the server where its wearer may use it;
 * that test is not made here, so it is left out, and the ward is a floor.
 */
export function wardOf(
  items: ReadonlyArray<Pick<ItemEntity, 'equipped' | 'negates' | 'abilities'>>,
  immunity: number | null
): SpellWard {
  const worn = items.filter((item) => item.equipped);
  const negates = new Set(worn.flatMap((item) => item.negates ?? []));
  const rows = worn.flatMap((item) => item.abilities ?? []);
  const sum = (immunity ?? 0) + abilitySum(rows, IMMUNE_TO_POISON_ABILITY);
  return {
    negates,
    poisonImmune: immunity !== null || carriesAbility(rows, IMMUNE_TO_POISON_ABILITY),
    poisonProof: sum >= POISON_PROOF_AT
  };
}

/** Whether `Spell.Cast` takes this spell off the character before it lands. */
export function wardedFrom(
  spell: Pick<WorldSpell, 'id' | 'abilities'>,
  ward: SpellWard | undefined
): boolean {
  if (ward === undefined) return false;
  if (ward.negates.has(spell.id)) return true;
  return ward.poisonImmune && poisons(spell);
}

/** The two rows `Spell.CheckResistance` is run on (`Spell.cs:1152-1171`). */
const RESISTED: ReadonlySet<number> = new Set([HAZARD_ABILITY.damage, HAZARD_ABILITY.damageWithMr]);

/**
 * A room spell's hazard as it lands on this ward's holder. A poison-typed
 * spell's Damage and DamageWithMR rows do 0 where ImmuPoison sums to 100
 * (`Spell.CheckResistance`); what else the spell does still lands. The
 * figure is kept where a drain or Poison row adds to it, which the server
 * does not resist, and where a script may deal it with a spell of another
 * type.
 */
export function hazardWarded(
  spell: Pick<WorldSpell, 'abilities' | 'element' | 'hazard'>,
  ward: SpellWard | undefined
): SpellHazard | null {
  const hazard = spell.hazard ?? null;
  if (hazard === null || ward?.poisonProof !== true || spell.element !== 'poison') return hazard;
  const rows = spell.abilities ?? [];
  const unresisted =
    rows.some(([ability]) => HURTS.has(ability) && !RESISTED.has(ability)) ||
    carriesAbility(rows, HAZARD_ABILITY.textBlock);
  return unresisted ? hazard : hazardWithout(hazard, 'damage');
}
