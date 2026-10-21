import { describe, expect, it } from 'vitest';

import { buildLapIndex, LapIndexCache } from '../lapIndex';
import { leg } from '../navigation/plan';
import { planRealmOf } from '../navigation/realm';
import type { WorldGraph } from '../WorldGraph';
import { worldOf } from './realmFile';

/** A corridor of `count` rooms on map 1, joined both ways. */
function corridor(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    m: 1,
    r: i + 1,
    n: `Room ${i + 1}`,
    x: {
      ...(i > 0 ? { w: { m: 1, r: i } } : {}),
      ...(i + 1 < count ? { e: { m: 1, r: i + 2 } } : {})
    }
  }));
}

/** A leg with every fight won, the shape the session's lap leg answers in. */
const legOf = (graph: WorldGraph) => (from: string, to: string) => {
  const route = leg(
    planRealmOf(graph),
    { fight: () => ({ kind: 'win', survives: null }), affords: () => null },
    from,
    to,
    {}
  );
  return route.blocked ? null : route;
};

const byId = (stop: { at: { map: number; room: number } | null }) =>
  stop.at === null ? null : `${stop.at.map}/${stop.at.room}`;

describe('the loops whose lap walks through a room', () => {
  it('finds a room between two stops', async () => {
    const graph = worldOf(corridor(5));
    const index = await buildLapIndex(
      [{ name: 'along', stops: [{ room: 'Room 1 1/1' }, { room: 'Room 5 1/5' }] }],
      byId,
      legOf(graph),
      () => false
    );
    expect(index?.through('1/3')).toEqual(['along']);
    expect(index?.through('1/1')).toEqual(['along']);
  });

  it('leaves out a loop with a stop the realm cannot settle, and names it', async () => {
    const graph = worldOf(corridor(3));
    const index = await buildLapIndex(
      [{ name: 'lost', stops: [{ room: 'Nowhere' }, { room: 'Room 3 1/3' }] }],
      byId,
      legOf(graph),
      () => false
    );
    expect(index?.through('1/2')).toEqual([]);
    expect(index?.unresolved).toEqual(['lost']);
  });

  it('stops when cancelled', async () => {
    const graph = worldOf(corridor(3));
    const index = await buildLapIndex(
      [{ name: 'along', stops: [{ room: 'Room 1 1/1' }, { room: 'Room 3 1/3' }] }],
      byId,
      legOf(graph),
      () => true
    );
    expect(index).toBeNull();
  });
});

describe('one session keeps its lap index', () => {
  const graph = worldOf(corridor(5));
  const loops = [{ name: 'along', stops: [{ room: 'Room 1 1/1' }, { room: 'Room 5 1/5' }] }];
  const counting = () => {
    let legs = 0;
    const planned = legOf(graph);
    return {
      legs: () => legs,
      leg: (from: string, to: string) => {
        legs += 1;
        return planned(from, to);
      }
    };
  };

  it('plans once while the realm, the loops and the traveller hold', async () => {
    const cache = new LapIndexCache();
    const legs = counting();
    const ask = { graph, loops, traveller: { level: 5 }, resolve: byId, leg: legs.leg };
    const first = await cache.index(ask);
    const again = await cache.index({ ...ask, loops: [...loops] });
    expect(first).toBe(again);
    expect(legs.legs()).toBe(2);
    expect(first?.through('1/3')).toEqual(['along']);
  });

  it('plans again when the traveller or the loops move', async () => {
    const cache = new LapIndexCache();
    const legs = counting();
    const ask = { graph, loops, traveller: { level: 5 }, resolve: byId, leg: legs.leg };
    await cache.index(ask);
    await cache.index({ ...ask, traveller: { level: 6 } });
    expect(legs.legs()).toBe(4);
    await cache.index({
      ...ask,
      traveller: { level: 6 },
      loops: [...loops, { name: 'b', stops: [] }]
    });
    expect(legs.legs()).toBe(6);
  });

  it('answers a stale ask from the build that replaced it', async () => {
    const cache = new LapIndexCache();
    const ask = { graph, loops, traveller: { level: 5 }, resolve: byId, leg: legOf(graph) };
    const waiting = cache.index(ask);
    const newer = cache.index({ ...ask, traveller: { level: 6 } });
    const [first, second] = await Promise.all([waiting, newer]);
    expect(first).not.toBeNull();
    expect(first).toBe(second);
  });

  it('answers nothing once disposed', async () => {
    const cache = new LapIndexCache();
    const ask = { graph, loops, traveller: { level: 5 }, resolve: byId, leg: legOf(graph) };
    const waiting = cache.index(ask);
    cache.dispose();
    expect(await waiting).toBeNull();
    expect(await cache.index(ask)).toBeNull();
  });
});
