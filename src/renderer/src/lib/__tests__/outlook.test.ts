import { describe, expect, it } from 'vitest';

import type { SurvivalHorizon } from '@shared/survival';
import { horizonsShown } from '../outlook';

const at = (rounds: number, won: number): SurvivalHorizon => ({
  rounds,
  standing: 1,
  won,
  lost: { least: 0, mean: 4, most: 18 }
});

describe('horizonsShown', () => {
  it('stops at the first round that reads 100% won', () => {
    const rows = [at(1, 0), at(3, 0), at(6, 1), at(12, 1), at(24, 1)];
    expect(horizonsShown(rows).map((r) => r.rounds)).toEqual([1, 3, 6]);
  });

  it('cuts on the printed figure, so 99.6% counts as won', () => {
    const rows = [at(1, 0.2), at(3, 0.996), at(6, 1)];
    expect(horizonsShown(rows).map((r) => r.rounds)).toEqual([1, 3]);
  });

  it('keeps every round while none reads 100% won', () => {
    const rows = [at(1, 0), at(3, 0.5), at(6, 0.99)];
    expect(horizonsShown(rows)).toBe(rows);
  });
});
