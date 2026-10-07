import { describe, expect, it } from 'vitest';

import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import { planGearTrip, type GearPlanParts } from '../gearTripPlan';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { chargedInCopper } from '../../../shared/coins';
import type { BuyingPlace, CashPlace, PlanFight, RoomId, Route } from '../../../shared/world';

/** A corridor `1/0`..`1/9`: the character at `1/0`, the armoury at `1/3`, a smithy at `1/6`, a bank at `1/2`. */
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
const VAULT: CashPlace = {
  shop: 8,
  name: 'Bank of Godfrey',
  map: 1,
  room: 2,
  roomName: 'Bank Lobby',
  copper: 50_000,
  detour: 2,
  moves: 2
};
const FIGHT: PlanFight = {
  monsters: ['orc'],
  roomName: 'Hall',
  item: null,
  odds: { kind: 'unread' }
};

function parts(purse: number | null): GearPlanParts {
  const state: CharacterState = {
    ...structuredClone(EMPTY_CHARACTER),
    room: { ...EMPTY_CHARACTER.room, map: 1, number: 0 },
    inventory: { ...EMPTY_CHARACTER.inventory, wealth: purse },
    progress: { ...EMPTY_CHARACTER.progress, charm: 50 }
  };
  return {
    state: () => state,
    world: () => ({
      stockingPlaces: (items) =>
        [place(1, 3, 'Armoury'), place(2, 3, 'Armoury'), place(3, 6, 'Smithy')].filter((each) =>
          items.includes(each.item)
        ),
      cashPlaces: () => [VAULT],
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
      priceAt: (name) => (name === 'leather cap' ? 1000 : name === 'iron helm' ? null : 500),
      routeBetween: (from, to) =>
        ({
          steps: Array.from({ length: Math.abs(AT(to) - AT(from)) }),
          cost: 1,
          blocked: false,
          fights: to === '1/6' ? [FIGHT] : []
        }) as unknown as Route,
      travellerNow: () => ({})
    }
  };
}

const PICKS = [
  { item: 3, name: 'chain leggings', replaces: null },
  { item: 1, name: 'leather cap', replaces: null },
  { item: 2, name: 'copper ring', replaces: null }
];

describe('planning a gear trip', () => {
  it('buys everything one counter sells in one stop, nearest first, each leg with its fights', async () => {
    const plan = await planGearTrip(parts(1_000_000), PICKS);
    expect(plan.refusal).toBeUndefined();
    expect(plan.stops.map((stop) => stop.room)).toEqual(['1/3', '1/6']);
    const [armoury, smithy] = plan.stops;
    expect(armoury?.kind === 'shop' && armoury.items.map((item) => item.name).sort()).toEqual([
      'copper ring',
      'leather cap'
    ]);
    expect(smithy?.leg.fights).toEqual([FIGHT]);
    expect(plan.moves).toBe(6);
    expect(plan.owed).toBe(chargedInCopper(1000, 50) + 2 * chargedInCopper(500, 50));
  });

  it('goes to a vault first where the purse is short, drawing the shortfall and the buffer', async () => {
    const plan = await planGearTrip(parts(100), PICKS);
    const bank = plan.stops[0];
    expect(bank?.kind).toBe('bank');
    expect(bank?.kind === 'bank' && bank.withdraw).toBe(2000 - 100 + tuning().supplies.cashBuffer);
  });

  it('walks to no vault while the purse is unread', async () => {
    const plan = await planGearTrip(parts(null), PICKS);
    expect(plan.stops.every((stop) => stop.kind === 'shop')).toBe(true);
  });

  it('leaves out what no shop sells, and counts what has no price', async () => {
    const plan = await planGearTrip(parts(1_000_000), [
      ...PICKS,
      { item: 9, name: 'dragon helm', replaces: null }
    ]);
    expect(plan.left).toEqual([{ name: 'dragon helm', why: 'not-sold' }]);
  });

  it('refuses a trip with nothing picked', async () => {
    const plan = await planGearTrip(parts(1_000_000), []);
    expect(plan.refusal).toBe(t('cards.gear.trip.nothingPicked'));
  });
});
