/**
 * What a portrait request says about the character (todo 20261019-0931-01):
 * race and class, the look's phrase for each of the six stats, gender, hair
 * and eyes where the look said them, and what is worn where a listing printed
 * the slot. Never the name, and never the wounds: health moves all the time
 * and each change would be a new drawing against the server's ten an hour.
 */
import { createHash } from 'node:crypto';

import { hairWords } from '../../shared/appearance';
import type { CharacterState } from '../../shared/character';
import { READIED } from '../../shared/items';
import { bandOf, LOOK_STATS, type LookStat } from '../../shared/lookBands';
import type { PortraitFacts, PortraitGear } from '../../shared/portrait';

/**
 * The facts, or null until everything they are made of has been read: `st`
 * for race, class and stats, `i` for the gear, and the look at this character.
 */
export function portraitFactsOf(state: CharacterState): PortraitFacts | null {
  const { race, className, appearance, progress, inventory } = state;
  if (race === null || className === null || appearance === null) return null;
  if (inventory.listedAt === null) return null;
  const phrases: Partial<Record<LookStat, string>> = {};
  for (const stat of LOOK_STATS) {
    const phrase = bandOf(stat, progress[stat]);
    if (phrase === null) return null;
    phrases[stat] = phrase;
  }
  const gear: PortraitGear[] = inventory.items
    // A slot guessed from the realm's data is not one the listing printed, and
    // the lit light comes and goes: neither is drawn.
    .filter(
      (item) =>
        item.equipped && item.slot !== null && item.slot !== READIED && item.slotSource !== 'realm'
    )
    .map((item) => ({ slot: item.slot!, item: item.name }))
    .sort((a, b) => a.slot.localeCompare(b.slot) || a.item.localeCompare(b.item));
  return {
    race,
    class: className,
    ...(appearance.gender === null ? {} : { gender: appearance.gender }),
    ...(appearance.hair === null ? {} : { hair: hairWords(appearance.hair) }),
    ...(appearance.eyes === null ? {} : { eyes: appearance.eyes }),
    ...(phrases as Record<LookStat, string>),
    gear
  };
}

/** One name for one set of facts: what the portrait is kept under, and asked again by. */
export function factsHash(facts: PortraitFacts): string {
  const keys = Object.keys(facts).sort();
  const canonical = JSON.stringify(facts, keys.concat('slot', 'item'));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}
