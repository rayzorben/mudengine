/**
 * Mana regeneration measured off the statline: how fast the pool rises while
 * the character stands out of combat, neither resting nor meditating, and is
 * short of its maximum. The choice of blessings reads it where no `stat all`
 * has stated `MA Regen`.
 *
 * A stretch counts only between two lines close enough together
 * (`gapSeconds`), and one where the pool fell is passed over: a cast spent
 * mana in it, and the rise it hid cannot be read back. Dependency-free.
 */

/** One statline's worth of what the watch reads. */
export interface ManaSample {
  at: number;
  mana: number | null;
  manaMax: number | null;
  inCombat: boolean;
  resting: boolean;
  meditating: boolean;
}

export interface ManaWatch {
  last: ManaSample | null;
  /** Seconds watched short of the maximum, standing. */
  seconds: number;
  /** Mana risen over them. */
  gained: number;
}

export const NO_MANA_WATCH: ManaWatch = { last: null, seconds: 0, gained: 0 };

function standing(sample: ManaSample): boolean {
  return !sample.inCombat && !sample.resting && !sample.meditating;
}

export function watchMana(watch: ManaWatch, sample: ManaSample, gapSeconds: number): ManaWatch {
  const last = watch.last;
  if (last === null || sample.at <= last.at) return { ...watch, last: sample };
  const seconds = (sample.at - last.at) / 1000;
  const counts =
    seconds <= gapSeconds &&
    standing(last) &&
    standing(sample) &&
    last.mana !== null &&
    sample.mana !== null &&
    last.manaMax !== null &&
    last.mana < last.manaMax &&
    sample.mana >= last.mana;
  if (!counts) return { ...watch, last: sample };
  return {
    last: sample,
    seconds: watch.seconds + seconds,
    gained: watch.gained + (sample.mana! - last.mana!)
  };
}

/** Mana a second standing, once `leastSeconds` have been watched; null before. */
export function measuredManaRate(watch: ManaWatch, leastSeconds: number): number | null {
  if (watch.seconds < leastSeconds || watch.seconds <= 0) return null;
  return watch.gained / watch.seconds;
}
