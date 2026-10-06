import { describe, expect, it } from 'vitest';

import { DEFAULT_INTERNAL } from '../../../shared/internal';
import type { WorldRoom } from '../../../shared/world';
import { RarityBook, type RarityConstants, type RarityWorld } from '../itemRarity';
import { readSupply } from '../supply';
import type { BuiltSupply } from '../supplyIndex';

const constants: RarityConstants = {
  ...DEFAULT_INTERNAL.tuning.rarity,
  roomRegenSeconds: 121,
  greatermudRespawnOffsetSeconds: 30
};

const room = (number: number, more: Partial<WorldRoom> = {}): WorldRoom => ({
  map: 1,
  room: number,
  name: `room ${number}`,
  exits: [],
  ...more
});

function bookOf(
  rooms: WorldRoom[],
  supply: Partial<BuiltSupply>,
  limits: Record<number, number> = {}
): RarityBook {
  const world: RarityWorld = {
    supply: () => readSupply({ sh: [], rt: [], ro: [], runs: [], ...supply }),
    everyRoom: () => rooms,
    item: (id) => ({ name: `item ${id}`, ...(limits[id] ? { limit: limits[id] } : {}) }),
    mobById: (id) => ({ name: `monster ${id}` }),
    shop: (id) => ({ name: `shop ${id}` }),
    info: { family: null }
  };
  return new RarityBook(world, constants);
}

describe('RarityBook', () => {
  it('rates a restocking shelf by what it puts out an hour', () => {
    const book = bookOf([], { sh: [[1, 7, 30, 100, 10]] });
    // 30 every 10 minutes is one every 20 seconds.
    expect(book.of(7)).toMatchObject({ rarity: 'common', hours: 20 / 3600 });
  });

  it('splits a lair’s slots between the monsters it names', () => {
    const book = bookOf([room(2, { lair: '(Max 2): 1,3' })], {
      runs: [{ k: 'drop', m: 1, gi: [[7, 1]] }]
    });
    // Two slots over two monsters: one of each every lair clock.
    expect(book.of(7).hours).toBeCloseTo(constants.lairSeconds / 3600);
  });

  it('holds a monster with a clock of its own to one a clock', () => {
    const book = bookOf([room(2, { lair: '(Max 2): 1' })], {
      rt: [[1, 10]],
      runs: [{ k: 'drop', m: 1, gi: [[7, 1]] }]
    });
    expect(book.of(7).hours).toBeCloseTo(10);
  });

  it('brings a room’s own monster back at the next regen pass when it states no clock', () => {
    const book = bookOf([room(2, { npcId: 1 })], { runs: [{ k: 'drop', m: 1, gi: [[7, 1]] }] });
    expect(book.of(7).hours).toBeCloseTo(121 / 3600);
  });

  it('rates the adamantite katana by the queen’s summons: 17 hours at 10%', () => {
    const book = bookOf([room(2, { npcId: 1 })], {
      rt: [[1, 17]],
      runs: [
        { k: 'arrive', m: 1, sm: [[2, 1]] },
        { k: 'drop', m: 2, gi: [[822, 0.1]] }
      ]
    });
    const katana = book.of(822);
    expect(katana.hours).toBeCloseTo(170);
    expect(katana.rarity).toBe('veryRare');
    expect(katana.sources[0]?.from).toEqual({ kind: 'drop', monster: 'monster 2', percent: 10 });
  });

  it('takes one round’s chance as the floor of a summons cast in a fight', () => {
    const book = bookOf([room(2, { npcId: 1 })], {
      rt: [[1, 10]],
      runs: [
        { k: 'fight', m: 1, p: 0.2, sm: [[2, 1]] },
        { k: 'drop', m: 2, gi: [[7, 1]] }
      ]
    });
    expect(book.of(7).hours).toBeCloseTo(50);
  });

  it('rates a summons gated by a placed item as the item, and a chest out of a chest', () => {
    const book = bookOf([room(2, { placed: [30] })], {
      runs: [
        { k: 'say', at: ['1/3'], say: 'ring bell', u: [30], sm: [[2, 1]] },
        { k: 'drop', m: 2, gi: [[40, 1]] },
        { k: 'use', it: 40, gi: [[41, 0.5]] }
      ]
    });
    expect(book.of(40).hours).toBeCloseTo(constants.placedHours);
    expect(book.of(41).hours).toBeCloseTo(constants.placedHours * 2);
    expect(book.passes).toBeGreaterThan(1);
  });

  it('calls a quest reward rare with no hours, and a limited item never common', () => {
    const book = bookOf(
      [],
      {
        sh: [[1, 8, 30, 100, 10]],
        runs: [{ k: 'say', at: ['1/3'], say: 'pray', q: 1, gi: [[9, 1]] }]
      },
      { 8: 1 }
    );
    expect(book.of(9)).toMatchObject({ rarity: 'rare', hours: null });
    expect(book.of(8)).toMatchObject({ rarity: 'rare', limited: true });
    expect(book.of(10).rarity).toBe('unknown');
  });
});
