import { describe, expect, it } from 'vitest';

import { t } from '../../app/i18n';
import { planSellRun, sellChoices, type SellPlanParts } from '../sellRunPlan';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { soldForCopper } from '../../../shared/coins';
import { wireItem, type ItemEntity } from '../../../shared/entities';
import type { SellPick } from '../../../shared/sellRun';
import type { BuyingPlace, RoomId, Route, WorldItem } from '../../../shared/world';

/** A corridor `1/0`..`1/9`: the character at `1/0`, the armoury at `1/3`, the smithy at `1/6`. */
const AT = (room: RoomId): number => Number(room.split('/')[1]);
const place = (item: number, room: number, shop: string): BuyingPlace & { item: number } => ({
  item,
  map: 1,
  room,
  roomName: shop,
  shop,
  markup: 0,
  detour: room,
  moves: room
});

/** The realm's rows: a robe the armoury takes, a sword the smithy takes, a rock nobody takes. */
const ROWS: Record<number, WorldItem> = {
  1: { id: 1, name: 'silk robe', price: 1500, currency: 'copper', encumbrance: 40 },
  2: { id: 2, name: 'iron sword', price: 600, currency: 'copper', encumbrance: 30 },
  3: { id: 3, name: 'rock', price: 10, currency: 'copper', encumbrance: 5 },
  4: { id: 4, name: 'old map', encumbrance: 1 }
};
const thing = (id: number, observed: Parameters<typeof wireItem>[1] = {}): ItemEntity => ({
  ...wireItem(ROWS[id]!.name, observed),
  id,
  encumbrance: ROWS[id]!.encumbrance
});

interface Standing {
  pack: ItemEntity[];
  floor: ItemEntity[];
  load: number | null;
  wanted?: number;
}

function parts({ pack, floor, load, wanted }: Standing): SellPlanParts {
  const state: CharacterState = {
    ...structuredClone(EMPTY_CHARACTER),
    room: { ...EMPTY_CHARACTER.room, map: 1, number: 0, items: floor },
    inventory: {
      ...EMPTY_CHARACTER.inventory,
      items: pack,
      encumbrance: load,
      encumbranceMax: load === null ? null : 200
    },
    progress: { ...EMPTY_CHARACTER.progress, charm: 50 }
  };
  return {
    state: () => state,
    kept: {
      wantedBy: (item) => (wanted !== undefined && item.id === wanted ? 'the map quest' : null)
    },
    world: () => ({
      item: (id) => ROWS[id],
      stockingPlaces: (items) =>
        [place(1, 3, 'Armoury'), place(2, 6, 'Smithy')].filter((each) => items.includes(each.item)),
      byId: (room) => ({ name: `Room ${room}` }) as never,
      sweepTo: (from, rooms) =>
        new Map(
          [...rooms].map((room) => [
            room,
            { cost: Math.abs(AT(room) - AT(from)), moves: Math.abs(AT(room) - AT(from)) }
          ])
        )
    }),
    errands: {
      routeBetween: (from, to) =>
        ({
          steps: Array.from({ length: Math.abs(AT(to) - AT(from)) }),
          cost: 1,
          blocked: false
        }) as unknown as Route,
      travellerNow: () => ({})
    }
  };
}

const ROBE: SellPick = { name: 'silk robe', from: 'pack', count: 1 };
const SWORDS: SellPick = { name: 'iron sword', from: 'floor', count: 2 };
const shape = (plan: Awaited<ReturnType<typeof planSellRun>>): string[] =>
  plan.stops.map(
    (stop) =>
      `${stop.round} ${stop.kind} ${stop.room} ${stop.items.map((item) => `${item.count} ${item.name}`).join(',')}`
  );

describe('planning a sell run', () => {
  it('picks up what fits first, then walks the shops in order', async () => {
    const standing = { pack: [thing(1)], floor: [thing(2, { count: 2 })], load: 40 };
    const plan = await planSellRun(parts(standing), [ROBE, SWORDS]);
    expect(plan.refusal).toBeUndefined();
    expect(shape(plan)).toEqual([
      '1 floor 1/0 2 iron sword',
      '1 shop 1/3 1 silk robe',
      '1 shop 1/6 2 iron sword'
    ]);
    expect(plan.stops[0]!.leg.steps).toBe(0);
    expect(plan.moves).toBe(6);
    expect(plan.rounds).toBe(1);
    expect(plan.copper).toBe(
      soldForCopper(1500, 'copper', 50) + 2 * soldForCopper(600, 'copper', 50)
    );
  });

  it('comes back for what the weight leaves, a round at a time, until all is sold', async () => {
    // 180 of 200: no sword fits until the robe is sold, and then one at a time.
    const standing = { pack: [thing(1)], floor: [thing(2, { count: 2 })], load: 180 };
    const plan = await planSellRun(parts(standing), [ROBE, SWORDS]);
    expect(shape(plan)).toEqual([
      '1 shop 1/3 1 silk robe',
      '2 floor 1/0 1 iron sword',
      '2 shop 1/6 1 iron sword',
      '3 floor 1/0 1 iron sword',
      '3 shop 1/6 1 iron sword'
    ]);
    expect(plan.rounds).toBe(3);
    expect(plan.moves).toBe(3 + 3 + 6 + 6 + 6);
    expect(plan.left).toEqual([]);
  });

  it('takes an unread weight as fitting, and leaves what never fits', async () => {
    const unread = { pack: [], floor: [thing(2, { count: 2 })], load: null };
    expect(shape(await planSellRun(parts(unread), [SWORDS]))).toEqual([
      '1 floor 1/0 2 iron sword',
      '1 shop 1/6 2 iron sword'
    ]);
    // Full, with nothing carried to sell: nothing makes the room.
    const full = { pack: [], floor: [thing(2, { count: 2 })], load: 199 };
    const plan = await planSellRun(parts(full), [SWORDS]);
    expect(plan.stops).toEqual([]);
    expect(plan.left).toEqual([{ name: 'iron sword', why: 'too-heavy' }]);
    expect(plan.refusal).toBe(t('cards.sell.nothingSells'));
  });

  it('leaves out what cannot go, each with why', async () => {
    const standing = {
      pack: [thing(1), thing(3), thing(4), wireItem('odd trinket')],
      floor: [],
      load: 50,
      wanted: 1
    };
    const picks: SellPick[] = [
      ROBE,
      { name: 'rock', from: 'pack', count: 1 },
      { name: 'old map', from: 'pack', count: 1 },
      { name: 'odd trinket', from: 'pack', count: 1 },
      { name: 'gone', from: 'pack', count: 1 },
      { name: 'gone', from: 'floor', count: 1 }
    ];
    const plan = await planSellRun(parts(standing), picks);
    expect(plan.stops).toEqual([]);
    expect(plan.left).toEqual([
      { name: 'silk robe', why: 'quest' },
      { name: 'old map', why: 'unpriced' },
      { name: 'odd trinket', why: 'unknown-row' },
      { name: 'gone', why: 'not-carried' },
      { name: 'gone', why: 'not-here' },
      { name: 'rock', why: 'no-counter' }
    ]);
  });

  it('never picks up what no shop buys, and plans the rest without it', async () => {
    const standing = {
      pack: [thing(1)],
      floor: [thing(3, { count: 4 }), thing(2)],
      load: 40
    };
    const picks: SellPick[] = [
      ROBE,
      { name: 'rock', from: 'floor', count: 4 },
      { name: 'iron sword', from: 'floor', count: 1 }
    ];
    const plan = await planSellRun(parts(standing), picks);
    expect(shape(plan)).toEqual([
      '1 floor 1/0 1 iron sword',
      '1 shop 1/3 1 silk robe',
      '1 shop 1/6 1 iron sword'
    ]);
    expect(plan.left).toEqual([{ name: 'rock', why: 'no-counter' }]);
  });
});

describe('the Sell face`s rows', () => {
  it('counts the unworn copies, prices each and names the nearest shop', () => {
    const standing = {
      pack: [thing(1), thing(1), thing(1, { equipped: true }), thing(3)],
      floor: [thing(2, { count: 3 }), { ...thing(3), gettable: false }],
      load: 0
    };
    expect(sellChoices(parts(standing))).toEqual([
      {
        name: 'silk robe',
        from: 'pack',
        count: 2,
        copper: soldForCopper(1500, 'copper', 50),
        shop: 'Armoury',
        moves: 3,
        kept: null
      },
      {
        name: 'rock',
        from: 'pack',
        count: 1,
        copper: soldForCopper(10, 'copper', 50),
        shop: null,
        moves: null,
        kept: 'no-counter'
      },
      {
        name: 'iron sword',
        from: 'floor',
        count: 3,
        copper: soldForCopper(600, 'copper', 50),
        shop: 'Smithy',
        moves: 6,
        kept: null
      },
      {
        name: 'rock',
        from: 'floor',
        count: 1,
        copper: null,
        shop: null,
        moves: null,
        kept: 'fixed'
      }
    ]);
  });
});
