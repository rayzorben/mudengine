import { describe, expect, it } from 'vitest';

import { t } from '../../app/i18n';
import { nearestCounter, type CounterWorld } from '../supplyCounter';
import type { BuyingPlace } from '../../../shared/world';
import type { Traveller } from '../../world/WorldGraph';

const TRAVELLER: Traveller = { keys: [], packKnown: true };

function counter(room: number, shop: string, moves: number): BuyingPlace & { item: number } {
  return { map: 1, room, roomName: shop, shop, markup: 100, detour: moves, moves, item: 175 };
}

/** A realm with one row per name and the counters `stockingPlaces` ranks, nearest first. */
function world(over: {
  id?: number | null;
  shops?: string[];
  mobs?: string[];
  places?: Array<BuyingPlace & { item: number }>;
}): CounterWorld {
  return {
    itemIdNamed: () => (over.id === undefined ? 175 : over.id),
    sourcesOf: () => ({ shops: over.shops ?? [], mobs: over.mobs ?? [] }),
    stockingPlaces: () => over.places ?? []
  };
}

describe('the counter a row naming no shop is bought at', () => {
  it('is the nearest that sells it', () => {
    const realm = world({
      shops: ['General Store'],
      places: [counter(2147, 'General Store', 4), counter(301, 'General Store', 19)]
    });
    expect(nearestCounter(realm, 'torch', '1/1', () => TRAVELLER, new Set())).toEqual({
      kind: 'counter',
      room: '1/2147',
      name: 'General Store',
      moves: 4
    });
  });

  it('passes over a counter found without it', () => {
    const realm = world({
      shops: ['General Store'],
      places: [counter(2147, 'General Store', 4), counter(301, 'General Store', 19)]
    });
    expect(nearestCounter(realm, 'torch', '1/1', () => TRAVELLER, new Set(['1/2147']))).toMatchObject({
      room: '1/301'
    });
  });

  it('is found when no counter sells it and a monster drops it', () => {
    const realm = world({ mobs: ['kobold thief'] });
    expect(nearestCounter(realm, 'black star key', '1/1', () => TRAVELLER, new Set())).toEqual({
      kind: 'found'
    });
  });

  it('is nowhere when nothing sells or drops it', () => {
    expect(nearestCounter(world({}), 'golden idol', '1/1', () => TRAVELLER, new Set())).toEqual({
      kind: 'nowhere',
      why: t('session.supplies.soldNowhere', { item: 'golden idol' })
    });
  });

  it('is nowhere when the name is no one row, rather than a guess', () => {
    expect(nearestCounter(world({ id: null }), 'iron key', '1/1', () => TRAVELLER, new Set())).toEqual({
      kind: 'nowhere',
      why: t('session.supplies.noSingleRow', { item: 'iron key' })
    });
  });

  it('is refused while sold but no counter is left to reach, or the room is unknown', () => {
    const sold = world({ shops: ['General Store'], places: [counter(2147, 'General Store', 4)] });
    expect(nearestCounter(sold, 'torch', '1/1', () => TRAVELLER, new Set(['1/2147']))).toEqual({
      kind: 'refused',
      why: t('session.supplies.noOtherCounter', { item: 'torch' })
    });
    const unreached = world({ shops: ['General Store'] });
    expect(nearestCounter(unreached, 'torch', '1/1', () => TRAVELLER, new Set())).toEqual({
      kind: 'refused',
      why: t('session.supplies.noCounterReached', { item: 'torch' })
    });
    expect(nearestCounter(sold, 'torch', null, () => TRAVELLER, new Set())).toEqual({
      kind: 'refused',
      why: t('session.supplies.notPlaced')
    });
  });
});
