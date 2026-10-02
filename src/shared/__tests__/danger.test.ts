import { describe, expect, it } from 'vitest';

import { openingRefusal, refusedRested, unfoughtShare } from '../danger';
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

  it('refuses at full health only a fight resting cannot open', () => {
    expect(refusedRested(fight(0.8), 0.95)).toBe(true);
    expect(refusedRested(fight(0.99), 0.95)).toBe(false);
    expect(refusedRested(fight(0.1), 0)).toBe(false);
  });

  it('leaves a fight nobody can run to combat, and waits on one still being run', () => {
    const run = (survives: number) => ({ kind: 'run' as const, survival: fight(survives) });
    expect(unfoughtShare(run(0.4), 0.95)).toBe(0.4);
    expect(unfoughtShare(run(0.99), 0.95)).toBeUndefined();
    expect(unfoughtShare({ kind: 'unrun' }, 0.95)).toBeUndefined();
    expect(unfoughtShare({ kind: 'pending' }, 0.95)).toBeNull();
    expect(unfoughtShare({ kind: 'unread' }, 0.95)).toBeNull();
    expect(unfoughtShare({ kind: 'pending' }, 0)).toBeUndefined();
  });
});
