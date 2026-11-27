import { describe, expect, it } from 'vitest';

import { asSellPicks, planSales, type SellRunPlan } from '../sellRun';

describe('the Sell face`s picks at the boundary', () => {
  it('keeps a name, where it is and a count, a row once', () => {
    expect(
      asSellPicks([
        { name: 'silk robe', from: 'pack', count: 2 },
        { name: 'silk robe', from: 'floor', count: 1 },
        { name: 'silk robe', from: 'pack', count: 5 }
      ])
    ).toEqual([
      { name: 'silk robe', from: 'pack', count: 2 },
      { name: 'silk robe', from: 'floor', count: 1 }
    ]);
  });

  it('refuses the lot for anything that is not a pick', () => {
    expect(asSellPicks('silk robe')).toBeNull();
    expect(asSellPicks([{ name: '', from: 'pack', count: 1 }])).toBeNull();
    expect(asSellPicks([{ name: 'silk robe', from: 'bank', count: 1 }])).toBeNull();
    expect(asSellPicks([{ name: 'silk robe', from: 'pack', count: 0 }])).toBeNull();
    expect(asSellPicks([{ name: 'silk robe', from: 'pack', count: 1.5 }])).toBeNull();
    expect(asSellPicks([null])).toBeNull();
  });
});

describe('a sell plan', () => {
  it('counts what its shops buy, never what is picked up', () => {
    const leg = { steps: 1, fights: [], hazards: [], walls: [], needs: [], blocked: null };
    const sword = { name: 'iron sword', item: 2, count: 2, copper: 300, weight: 30 };
    const plan: SellRunPlan = {
      from: '1/0',
      stops: [
        { kind: 'floor', round: 1, room: '1/0', place: 'Square', items: [sword], leg },
        {
          kind: 'shop',
          round: 1,
          room: '1/6',
          place: 'Smithy',
          shop: 'Smithy',
          items: [sword],
          leg
        }
      ],
      moves: 6,
      copper: 600,
      rounds: 1,
      left: []
    };
    expect(planSales(plan)).toBe(2);
  });
});
