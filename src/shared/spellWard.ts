/**
 * Whether a monster's spell reaches the character, as `Spell.Cast` decides it
 * for a player target: a worn item that negates the spell
 * (`ItemType.DoesNegateSpell`) takes the whole cast off it, and so does
 * ImmuPoison against any spell carrying Poison (GreaterMUD.Module
 * `Spell.cs:970-1000`). The fight sim and `menace` both read `wardedFrom`.
 * See todo 2322-01.
 */
import { HAZARD_ABILITY, IMMUNE_TO_POISON_ABILITY } from './abilities';
import type { ItemEntity } from './entities';
import type { WorldSpell } from './world';

/** What the character wears and is, as far as a spell reaching it goes. */
export interface SpellWard {
  /** Spell ids a worn item negates. */
  negates: ReadonlySet<number>;
  /** ImmuPoison on a row the character holds: a spell with Poison negated whole. */
  poisonImmune: boolean;
}

/** No ward: every spell reaches. */
export const NO_WARD: SpellWard = { negates: new Set(), poisonImmune: false };

/**
 * The ward of what is worn, with ImmuPoison off the class or race rows
 * (`poisonImmune`, null where neither is read) or off a worn item's own
 * rows. A carried "nowhere" item also negates on the server where its
 * wearer may use it; that test is not made here, so it is left out, and the
 * ward is a floor.
 */
export function wardOf(
  items: ReadonlyArray<Pick<ItemEntity, 'equipped' | 'negates' | 'abilities'>>,
  poisonImmune: boolean | null
): SpellWard {
  const worn = items.filter((item) => item.equipped);
  const negates = new Set(worn.flatMap((item) => item.negates ?? []));
  const itemImmune = worn.some((item) =>
    (item.abilities ?? []).some(([id]) => id === IMMUNE_TO_POISON_ABILITY)
  );
  return { negates, poisonImmune: poisonImmune === true || itemImmune };
}

/** Whether `Spell.Cast` takes this spell off the character before it lands. */
export function wardedFrom(
  spell: Pick<WorldSpell, 'id' | 'abilities'>,
  ward: SpellWard | undefined
): boolean {
  if (ward === undefined) return false;
  if (ward.negates.has(spell.id)) return true;
  return ward.poisonImmune && (spell.abilities ?? []).some(([id]) => id === HAZARD_ABILITY.poison);
}
