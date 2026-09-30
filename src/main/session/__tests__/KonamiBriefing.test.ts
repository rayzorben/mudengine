import { describe, expect, it } from 'vitest';

import type { RouteStep } from '../../../shared/world';
import { walkSummary } from '../KonamiBriefing';

const step = (to: string, over: Partial<RouteStep> = {}): RouteStep =>
  ({ from: 'x', to, direction: 'e', command: 'e', name: `Room ${to}`, ...over }) as RouteStep;

const lairAt = (id: string) => ({ monsters: [`mob of ${id}`], fight: 'risky' as const });

describe('the walk to a spot, condensed', () => {
  it('sums what the lairs on the way cost and names the worst first', () => {
    const summary = walkSummary(
      [
        step('1/2'),
        step('1/3', { danger: 0.1, lairDamage: 3 }),
        step('1/4', { danger: 0.3, lairDamage: 10 })
      ],
      lairAt,
      1
    );
    expect(summary).toMatchObject({ steps: 3, lairs: 2, damage: 13, unweighed: 0 });
    expect(summary.worst).toEqual([
      { room: 'Room 1/4', share: 0.3, monsters: ['mob of 1/4'], fight: 'risky' }
    ]);
  });

  it('says the cost is unknown when a lair on the way could not be weighed', () => {
    const summary = walkSummary(
      [step('1/3', { danger: 0.1, lairDamage: 8 }), step('1/4', { lairUnweighed: true })],
      lairAt,
      3
    );
    expect(summary).toMatchObject({ lairs: 2, damage: null, unweighed: 1 });
  });
});
