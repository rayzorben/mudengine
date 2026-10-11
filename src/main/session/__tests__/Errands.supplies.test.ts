import { describe, expect, it, vi } from 'vitest';

import { Errands, type ErrandsParts, type ErrandsSession } from '../Errands';
import { DEFAULT_CONFIG, type SupplyItem } from '../../../shared/config';
import { EMPTY_CHARACTER } from '../../../shared/character';

/* The counter a supply row is bought at (todo 49): a row's own room wins over the nearest. */

function errands(world: Record<string, unknown>): Errands {
  return new Errands(
    {
      world,
      tracker: { current: EMPTY_CHARACTER, pendingMoves: 0 },
      fightRecord: {},
      lore: {}
    } as unknown as ErrandsParts,
    {
      config: () => DEFAULT_CONFIG.automation,
      family: () => 'greatermud',
      notice: () => {}
    } as unknown as ErrandsSession
  );
}

const ROW: SupplyItem = { name: 'torch', min: 3, max: 5, shop: '', at: null };

describe('the counter a supply row is bought at', () => {
  it('is the room the row names, never the nearest', () => {
    const itemIdNamed = vi.fn(() => 175);
    const book = errands({
      get: () => ({ name: 'General Store', shop: 4 }),
      shop: () => ({ name: 'General Store' }),
      itemIdNamed,
      sourcesOf: () => ({ shops: ['General Store'], mobs: [] }),
      stockingPlaces: () => []
    });
    const row = { ...ROW, at: { map: 1, room: 2147 } };
    expect(book.shopRoom(row, new Set())).toEqual({
      kind: 'counter',
      room: '1/2147',
      name: 'General Store',
      moves: null
    });
    // The positive control: the same realm answers a row naming nothing from its items.
    expect(book.shopRoom(ROW, new Set())).toEqual({
      kind: 'refused',
      why: expect.any(String)
    });
    expect(itemIdNamed).toHaveBeenCalledTimes(1);
  });
});
