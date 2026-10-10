import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CARDS, type CardId } from '../cards';
import { NARROWEST_CARD, NOTHING_KEPT, onRail, preferredOn, railFor } from '../railCards';
import { overlaps } from '../railGrid';

const on = (columns: number, stacked = false) => ({ columns, stacked });

const ALL: CardId[] = CARDS.map((card) => card.id);

/*
 * Every card's preferred box (todo 06): the rail with every card open, on
 * festus's rail of 49 cells. A rail card is laid out from these, so they are
 * held to the rules the rail is.
 */
describe('where each card is wanted on the rail', () => {
  it('is festus’s rail for the six festus keeps open', () => {
    expect(preferredOn('map', on(49))).toEqual({ x: 0, y: 0, w: 29, h: 27 });
    expect(preferredOn('vitals', on(49))).toEqual({ x: 29, y: 0, w: 20, h: 14 });
    expect(preferredOn('combat', on(49))).toEqual({ x: 29, y: 14, w: 20, h: 13 });
    expect(preferredOn('stats', on(49))).toEqual({ x: 0, y: 27, w: 29, h: 22 });
    expect(preferredOn('navigation', on(49))).toEqual({ x: 29, y: 27, w: 20, h: 22 });
    expect(preferredOn('conversation', on(49))).toEqual({ x: 0, y: 49, w: 49, h: 21 });
  });

  it('shares a cell with no other card’s, with every card open', () => {
    const boxes = ALL.map((id) => preferredOn(id, on(49)));
    expect(boxes.every((a, i) => boxes.every((b, j) => i === j || !overlaps(a, b)))).toBe(true);
  });

  it('is tall enough for every card to draw its medium design', () => {
    // 11 rows is 164px of card at the 12px gap, over the 160px medium starts at.
    const short = ALL.filter((id) => id !== 'toolbar' && preferredOn(id, on(49)).h < 11);
    expect(short).toEqual([]);
  });

  it('stands in two columns down to 26 cells, and stacks under that', () => {
    const open: CardId[] = ['map', 'vitals', 'combat', 'stats', 'navigation', 'conversation'];
    expect(railFor(open, NOTHING_KEPT, 26).stacked).toBe(false);
    expect(railFor(open, NOTHING_KEPT, 25).stacked).toBe(true);
  });

  it('stands a card kept at the least until its width rounds under it', () => {
    const kept = {
      spots: { vitals: { x: 38, y: 0 } },
      sizes: { vitals: { w: 11, h: 14 } },
      columns: 49
    };
    expect(railFor(['vitals'], kept, 47).stacked).toBe(false);
    expect(railFor(['vitals'], kept, 46).stacked).toBe(true);
  });

  it('stacks once as the rail narrows, whatever the rounding does', () => {
    const kept = {
      spots: { vitals: { x: 20, y: 0 } },
      sizes: { vitals: { w: 12, h: 14 } },
      columns: 49
    };
    const stacked = Array.from({ length: 49 }, (_, i) => railFor(['vitals'], kept, 49 - i).stacked);
    const turn = stacked.indexOf(true);
    expect(turn).toBeGreaterThan(0);
    expect(stacked.slice(turn).every(Boolean)).toBe(true);
  });

  it('lets a card given fewer cells than it stands at shrink to the least before stacking', () => {
    const kept = {
      spots: { vitals: { x: 20, y: 0 } },
      sizes: { vitals: { w: 8, h: 14 } },
      columns: 49
    };
    expect(railFor(['vitals'], kept, 34).stacked).toBe(false);
    expect(railFor(['vitals'], kept, 33).stacked).toBe(true);
  });

  it('is one column of whole-width cards on the narrowest rail', () => {
    const rail = railFor(ALL, NOTHING_KEPT, 17);
    expect(rail.stacked).toBe(true);
    expect(ALL.every((id) => preferredOn(id, rail).w === 17)).toBe(true);
  });
});

describe('the narrowest the rail draws a card it has made narrower', () => {
  /** A length from the stylesheet, every value it is given. */
  const tokens = readFileSync(resolve('src/renderer/src/styles/tokens.css'), 'utf8');
  const lengths = (name: string): number[] =>
    [...tokens.matchAll(new RegExp(`--${name}:\\s*(\\d+)px`, 'g'))].map((m) => Number(m[1]));

  it('draws a card medium at every gap, and one cell fewer does not', () => {
    const [cell] = lengths('grid-cell');
    const [medium] = lengths('card-size-medium');
    const gaps = lengths('gap');
    expect(gaps.length).toBeGreaterThan(0);
    for (const gap of gaps) expect(NARROWEST_CARD * cell! - gap).toBeGreaterThanOrEqual(medium!);
    expect((NARROWEST_CARD - 1) * cell! - Math.min(...gaps)).toBeLessThan(medium!);
  });
});

describe('the rail cards as the rail arranges them', () => {
  it('wants a card where it is preferred, when nothing was kept', () => {
    expect(onRail(['combat'], NOTHING_KEPT, 49).cards).toEqual([
      { id: 'combat', size: { w: 20, h: 13 }, wanted: { x: 29, y: 14 } }
    ]);
  });

  it('stands a card where it was put, in proportion on a narrower rail', () => {
    const kept = {
      spots: { combat: { x: 29, y: 30 } },
      sizes: { combat: { w: 20, h: 9 } },
      columns: 49
    };
    expect(onRail(['combat'], kept, 38).cards).toEqual([
      { id: 'combat', size: { w: 16, h: 9 }, spot: { x: 22, y: 30 }, wanted: { x: 22, y: 14 } }
    ]);
  });

  it('draws a placed card with no size at its preferred size on the rail it was kept on', () => {
    const kept = { spots: { vitals: { x: 20, y: 0 } }, sizes: {}, columns: 34 };
    expect(onRail(['vitals'], kept, 34).cards[0]!.size).toEqual({ w: 14, h: 14 });
  });

  it("stacks the cards in the rail's order, whatever was kept", () => {
    const kept = {
      spots: { map: { x: 0, y: 0 }, vitals: { x: 29, y: 0 } },
      sizes: {},
      columns: 49
    };
    const { width, cards } = onRail(['vitals', 'map'], kept, 20);
    expect(width).toEqual({ columns: 20, stacked: true });
    expect(cards).toEqual([
      { id: 'vitals', size: { w: 20, h: 14 }, wanted: { x: 0, y: 0 } },
      { id: 'map', size: { w: 20, h: 27 }, wanted: { x: 0, y: 1 } }
    ]);
  });
});
