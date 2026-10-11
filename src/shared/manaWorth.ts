/**
 * Whether a monster is worth the mana a spell would spend killing it, next to
 * another the room lists (todo 54). Each kill is priced by the spell the
 * choice would cast (`castsToKill`), as experience per point of mana. The
 * spell is held back for the melee round when the pool cannot pay for both
 * kills and the other one buys more experience per point. No threshold: the
 * figures are the realm's and the round's. Unknown experience, health or cost
 * holds nothing. See `mudengine-automation` › `parts/combat.md`.
 */
import { castsToKill, type KillCasting, type SpellTarget } from './spellchoice';

/** One kill priced in mana. */
export interface KillPrice {
  name: string;
  experience: number;
  mana: number;
}

/** The figures that held the spell: this kill, the better one, and the pool. */
export interface ManaHeld {
  here: KillPrice;
  next: KillPrice;
  pool: number;
}

/**
 * Mana the chosen spell spends killing the monster `name`, with its
 * experience; null where either is unknown.
 */
export function killPrice(
  casting: KillCasting,
  name: string,
  experience: number | undefined,
  target: SpellTarget
): KillPrice | null {
  if (experience === undefined || experience <= 0) return null;
  const kill = castsToKill(casting, {
    name,
    hp: target.remaining,
    magicRes: target.magicRes,
    abilities: target.abilities,
    nature: target.nature
  });
  if (kill === null || kill.mana === null || kill.mana <= 0) return null;
  return { name, experience, mana: kill.rounds * kill.mana };
}

const perMana = (price: KillPrice): number => price.experience / price.mana;

/**
 * The hold, or null: the pool pays for `here` or for the best of `others`
 * but not both, and that one buys more experience a point of mana.
 */
export function saveTheMana(
  pool: number | null,
  here: KillPrice | null,
  others: readonly KillPrice[]
): ManaHeld | null {
  if (pool === null || here === null) return null;
  let next: KillPrice | null = null;
  for (const other of others) {
    if (other.mana > pool || perMana(other) <= perMana(here)) continue;
    if (next === null || perMana(other) > perMana(next)) next = other;
  }
  if (next === null || pool >= here.mana + next.mana) return null;
  return { here, next, pool };
}
