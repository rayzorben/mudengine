import { describe, expect, it, vi } from 'vitest';

import { nearestRows, placeKindsIn, type NearestDeps } from '../nearestRows';
import type { SessionId } from '@shared/ipc';
import type { NearPlace, PlaceKind } from '@shared/places';

const HERO = 'hero' as SessionId;

describe('placeKindsIn', () => {
  it.each<[string, PlaceKind[]]>([
    ['bank', ['bank']],
    ['nearest trai', ['trainer']],
    ['ARMOR', ['armour']],
    ['inn', ['tavern']],
    ['bank of godfrey', []],
    ['ba', []]
  ])('reads %s as %j', (query, kinds) => {
    expect(placeKindsIn(query)).toEqual(kinds);
  });
});

describe('nearestRows', () => {
  it('asks main only for a kind the query names, and walks the row it gives', async () => {
    const place: NearPlace = {
      kind: 'bank',
      shop: 8,
      name: 'Bank of Godfrey',
      moves: 4,
      room: { map: 1, room: 12, name: 'Bank', exits: [] }
    };
    const nearestPlaces = vi.fn(async () => [place]);
    const routeTo = vi.fn(async () => ({ steps: [], cost: 0, blocked: false }));
    const openRouteOn = vi.fn<NearestDeps['openRouteOn']>();
    const deps: NearestDeps = {
      api: { nearestPlaces, routeTo, walkRoute: vi.fn() },
      session: HERO,
      openRouteOn
    };
    expect(await nearestRows('forest', deps)).toEqual([]);
    expect(nearestPlaces).not.toHaveBeenCalled();
    const rows = await nearestRows('bank', deps);
    expect(nearestPlaces).toHaveBeenCalledWith(HERO, 'bank');
    expect(rows.map((row) => row.id)).toEqual(['nearest:bank:8:1/12']);
    rows[0]!.run();
    await vi.waitFor(() => expect(openRouteOn).toHaveBeenCalledWith(place.room, null));
    expect(routeTo).toHaveBeenCalledWith(HERO, 1, 12);
  });
});
