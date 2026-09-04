/**
 * How the realm describes a wounded thing, and what each word is worth.
 *
 * `look <mob>` answers with the mob's name, its description, and one sentence:
 * *"He appears to be severely wounded."* That sentence is the **only** statement
 * of a monster's health this server ever volunteers — nothing prints a number —
 * so it is what re-anchors an estimate that has drifted.
 *
 * **A reading, not a capture.** `ActionFigure.GetWoundLevel` in the GreaterMUD
 * source (docs/greatermud/combat.md), which is one build of a server we may not
 * be connected to. Where this and the wire disagree, the wire wins.
 *
 * Two details from that function that a guess would have got wrong:
 *
 * - **It is fed an integer.** `(CurHP * 100) / MaxHP` divides two `int`s, so the
 *   percentage is truncated before the comparisons run. `floor(x) >= k` is
 *   `x >= k` for whole `k`, so the interior boundaries are exactly the round
 *   fractions below — but the two ends are not. `unwounded` needs a truncated
 *   100, which is only `cur == max`; `mortally wounded` is everything the
 *   truncation floors to zero, which is **under one percent and not
 *   necessarily dead**. A monster described as mortally wounded is still
 *   swinging.
 * - **The band is wide.** `heavily wounded` spans a fifth of the bar. It is a
 *   correction, never a measurement: it says which fifth, and an estimate
 *   already inside that fifth is the better number of the two.
 *
 * Dependency-free, like everything in `shared/`: the tracker anchors estimates
 * with it in main and the card prints the word in the renderer.
 */

export type WoundBand =
  | 'unwounded'
  | 'slightly wounded'
  | 'moderately wounded'
  | 'heavily wounded'
  | 'severely wounded'
  | 'critically wounded'
  | 'very critically wounded'
  | 'mortally wounded';

/**
 * Every band, worst first, with the fraction range it covers as `[lo, hi)`.
 *
 * Worst first because that is the order the ranges tile the bar in, and because
 * a lookup that walks it can stop at the first band whose floor a fraction
 * clears — which is the same shape the server's own `if` ladder has, read
 * upwards.
 */
export const WOUND_BANDS: readonly { band: WoundBand; lo: number; hi: number }[] = [
  { band: 'mortally wounded', lo: 0, hi: 0.01 },
  { band: 'very critically wounded', lo: 0.01, hi: 0.2 },
  { band: 'critically wounded', lo: 0.2, hi: 0.3 },
  { band: 'severely wounded', lo: 0.3, hi: 0.5 },
  { band: 'heavily wounded', lo: 0.5, hi: 0.7 },
  { band: 'moderately wounded', lo: 0.7, hi: 0.85 },
  { band: 'slightly wounded', lo: 0.85, hi: 1 },
  // The one closed range: a truncated 100 means current *equals* maximum.
  { band: 'unwounded', lo: 1, hi: 1 }
];

const BY_BAND = new Map(WOUND_BANDS.map((entry) => [entry.band, entry]));

/** Whether a word the server used is one of the eight. Never widened by guess. */
export function isWoundBand(word: string): word is WoundBand {
  return BY_BAND.has(word as WoundBand);
}

/** The band a known fraction falls in, or null when the fraction is unknown. */
export function woundBandFor(fraction: number | null): WoundBand | null {
  if (fraction === null || !Number.isFinite(fraction)) return null;
  if (fraction >= 1) return 'unwounded';
  const clamped = Math.max(0, fraction);
  for (const entry of WOUND_BANDS) {
    if (clamped < entry.hi) return entry.band;
  }
  return 'unwounded';
}

/**
 * The fraction range a band asserts, as `[lo, hi]` — both **inclusive**, which
 * is what makes it usable as a clamp.
 *
 * The half-open `[lo, hi)` above is what the server tests; a clamp needs a
 * closed interval and the difference is one part in ten thousand, which is
 * below what a band this wide can claim to distinguish.
 */
export function woundRange(band: WoundBand): [number, number] {
  const entry = BY_BAND.get(band);
  if (!entry) return [0, 1];
  return [entry.lo, entry.hi];
}

/**
 * An estimate corrected by what the server actually said.
 *
 * The band is authoritative about the *range*; an estimate already inside it is
 * the finer of the two and is kept. Outside it, the estimate is pulled to the
 * nearest edge rather than to the middle — the middle would throw away the half
 * of the estimate the band agrees with, and the edge is the least movement that
 * makes the two consistent.
 *
 * This is what handles a monster healing itself. Mobs regenerate on a tick
 * (`TimedEventManager.DoMobHPTick`, every other 15-second rest tick, by
 * `HPRegen` from the realm data), and nothing on the wire announces it — so an
 * estimate built from damage alone only ever falls, and drifts further below
 * the truth the longer a fight runs. A `look` pulls it back up.
 */
export function anchorToBand(estimate: number | null, band: WoundBand): number {
  const [lo, hi] = woundRange(band);
  if (estimate === null || !Number.isFinite(estimate)) {
    // Nothing to reconcile: the band alone, taken at its midpoint, which is the
    // best single number a range supports.
    return (lo + hi) / 2;
  }
  if (estimate < lo) return lo;
  if (estimate > hi) return hi;
  return estimate;
}
