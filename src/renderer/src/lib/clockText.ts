import { hasOwnClock } from '@shared/mobFind';
import type { WorldMob } from '@shared/world';

/**
 * A clock, in the shortest reading that rounds no real difference away.
 *
 * The realm states `Rooms.Delay` in whole minutes (1–120 across both shipped
 * worlds) and `Monsters.RegenTime` in whole hours, so minutes and hours are
 * what a reader recognises. But GreaterMUD's thirty-second offset lands a
 * two-minute lair on 90 seconds, and `2m` there would be the client rounding
 * away the half of the clock the player is standing about waiting for.
 *
 * Read by the Room card's lair list, the item rarity rows and the monster
 * card's regen row, so it lives here rather than in any one of them.
 *
 * Bare unit letters rather than dictionary keys, as the Hunting card's own
 * figures are: a suffix on a numeral is not a word the chrome is saying.
 */
export function clockText(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const rest = Math.round((seconds % 3600) / 60);
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * A monster's own clock, `Monsters.RegenTime` (format 36), as text; null where
 * it has none and comes back with its room. The Room card's lair chip and the
 * monster card's regen row both read it from here; "has a clock of its own" is
 * `hasOwnClock`, shared with the find that walks such a monster's lairs.
 */
export function regenClockText(mob: Pick<WorldMob, 'regenHours'>): string | null {
  return hasOwnClock(mob) ? clockText(mob.regenHours * 3600) : null;
}
