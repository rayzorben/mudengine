import { describe, expect, it } from 'vitest';

import { openingRefusal } from '../danger';
import type { Survival } from '../survival';

const fight = (survives: number): Survival => ({ survives }) as unknown as Survival;

describe('the danger a fight is', () => {
  it('opens only a fight survived well enough, and never refuses one nobody can work out', () => {
    expect(openingRefusal(fight(0.99), 34, 34, 0.95)).toBeNull();
    expect(openingRefusal(null, 34, 34, 0.95)).toBeNull();
    // At full health resting changes nothing; below it, rest to full first.
    expect(openingRefusal(fight(0.8), 34, 34, 0.95)).toEqual({
      kind: 'odds',
      survives: 0.8,
      needs: null
    });
    expect(openingRefusal(fight(0.8), 30, 34, 0.95)).toEqual({
      kind: 'odds',
      survives: 0.8,
      needs: 34
    });
    expect(openingRefusal(fight(0.1), 5, 34, 0)).toBeNull();
  });
});
