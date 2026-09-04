import { describe, expect, it } from 'vitest';

import {
  WOUND_BANDS,
  anchorToBand,
  isWoundBand,
  woundBandFor,
  woundRange,
  type WoundBand
} from '../wounds';

/**
 * The wound table is a *reading* of `ActionFigure.GetWoundLevel`, and the two
 * ends of it are where a plausible guess goes wrong: the server truncates its
 * percentage with integer division before comparing, so `unwounded` means
 * exactly full and `mortally wounded` means under one percent rather than dead.
 * Both are asserted here, because both are the sort of thing a later tidy-up
 * would "simplify" into round numbers.
 */
describe('the wound bands', () => {
  it('tiles the whole bar with no gap and no overlap', () => {
    const ordered = [...WOUND_BANDS];
    for (const [index, entry] of ordered.entries()) {
      if (index === 0) {
        expect(entry.lo).toBe(0);
        continue;
      }
      expect(entry.lo).toBe(ordered[index - 1]!.hi);
    }
    expect(ordered.at(-1)!.hi).toBe(1);
  });

  it('calls only a completely unhurt thing unwounded', () => {
    expect(woundBandFor(1)).toBe('unwounded');
    expect(woundBandFor(0.999)).toBe('slightly wounded');
  });

  /*
   * The detail nothing but the source would have given. `> 0.0f` in the server
   * is applied to the *truncated* percentage, so anything under one percent
   * floors to zero and is reported as mortally wounded — while still standing.
   */
  it('calls anything under one percent mortally wounded, alive or not', () => {
    expect(woundBandFor(0)).toBe('mortally wounded');
    expect(woundBandFor(0.009)).toBe('mortally wounded');
    expect(woundBandFor(0.01)).toBe('very critically wounded');
  });

  it('puts each interior boundary on the band above it', () => {
    const cases: [number, WoundBand][] = [
      [0.2, 'critically wounded'],
      [0.3, 'severely wounded'],
      [0.5, 'heavily wounded'],
      [0.7, 'moderately wounded'],
      [0.85, 'slightly wounded']
    ];
    for (const [fraction, band] of cases) expect(woundBandFor(fraction)).toBe(band);
  });

  it('says nothing about a fraction it does not have', () => {
    expect(woundBandFor(null)).toBeNull();
    expect(woundBandFor(Number.NaN)).toBeNull();
  });

  /* A closed union: a ninth word must not become a wound level by arriving. */
  it('refuses a word the server cannot produce', () => {
    expect(isWoundBand('slightly wounded')).toBe(true);
    expect(isWoundBand('a bit poorly')).toBe(false);
  });
});

describe('anchoring an estimate to what the server said', () => {
  it('keeps an estimate the band already agrees with', () => {
    // The band is a fifth of the bar wide; an estimate inside it is the finer
    // of the two readings and throwing it away would lose that.
    expect(anchorToBand(0.6, 'heavily wounded')).toBe(0.6);
  });

  /*
   * The regeneration case, which is the reason this exists. A monster heals on
   * a server tick and nothing announces it, so an estimate built from damage
   * alone only ever falls. A look pulls it back up to the band's floor.
   */
  it('raises an estimate that has drifted below what the server reports', () => {
    expect(anchorToBand(0.05, 'heavily wounded')).toBe(0.5);
  });

  it('lowers an estimate the server contradicts from the other side', () => {
    expect(anchorToBand(0.95, 'severely wounded')).toBe(0.5);
  });

  it('takes the band alone when there is no estimate to reconcile', () => {
    const [lo, hi] = woundRange('critically wounded');
    expect(anchorToBand(null, 'critically wounded')).toBe((lo + hi) / 2);
  });
});
