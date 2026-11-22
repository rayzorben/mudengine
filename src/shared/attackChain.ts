/**
 * The round spell as an ordered chain: `attack`, then `attackFallback`, then
 * `attackThird`, each with its own cap per target and its own mana floor
 * (`spells.attackCasts` / `attackMinMana`, `fallbackCasts` / `fallbackMinMana`,
 * `thirdCasts` / `thirdMinMana`). The first step that is not capped, refused,
 * under its floor or unpayable is cast; with none left the melee round
 * carries the fight. See `mudengine-automation` › combat.
 */
import type { SpellsConfig } from './config';

export interface AttackStep {
  spell: string;
  /** Casts per target before the next step takes over; 0 is no limit. */
  casts: number;
  /** Fraction of maximum mana this step needs; 0 is no floor. */
  minMana: number;
}

/**
 * The steps in order. Empty while `attack` is blank, since the fallback is
 * never cast first; a blank later step is left out.
 */
export function attackChain(spells: SpellsConfig): AttackStep[] {
  if (spells.attack.trim().length === 0) return [];
  const steps: AttackStep[] = [
    { spell: spells.attack, casts: spells.attackCasts, minMana: spells.attackMinMana },
    { spell: spells.attackFallback, casts: spells.fallbackCasts, minMana: spells.fallbackMinMana },
    { spell: spells.attackThird, casts: spells.thirdCasts, minMana: spells.thirdMinMana }
  ];
  return steps.filter((step) => step.spell.trim().length > 0);
}
