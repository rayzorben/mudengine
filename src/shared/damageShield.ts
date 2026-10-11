/**
 * A monster's damage shield: what it does back to the character for each blow
 * the character lands on it (todo 56).
 *
 * GreaterMUD source, `ActionFigure.HitCheckShockShield`: `Mob.Hit` runs it
 * after every melee blow that lands, a glance included, and only when the blow
 * leaves the monster standing. Each `ShockShield` (72) row rolls
 * `rand(1, max(value, 3))` on the attacker; the attacker's armour is not
 * counted. A spell never sets it off (`Spell.cs` calls `Hit(…, false)`).
 */
import { abilityValues, SHOCK_SHIELD_ABILITY } from './abilities';
import { between, type Random } from './dice';

/** The high end of each shield a monster carries, from its realm abilities; empty for none. */
export function shieldsOf(
  abilities: ReadonlyArray<readonly [number, number]> | undefined
): number[] {
  return abilityValues(abilities, SHOCK_SHIELD_ABILITY).map((value) =>
    Math.max(Math.trunc(value), 3)
  );
}

/** What every shield does back for one landed blow, in expectation. */
export function shieldPerBlow(shields: readonly number[]): number {
  return shields.reduce((sum, high) => sum + (1 + high) / 2, 0);
}

/** One landed blow's worth of every shield, rolled. */
export function rollShields(random: Random, shields: readonly number[]): number {
  return shields.reduce((sum, high) => sum + between(random, 1, high), 0);
}
