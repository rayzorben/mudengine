import { describe, expect, it } from 'vitest';

import { worldOf } from './realmFile';
import { WorldGraph } from '../WorldGraph';
import { SYS_GO_WAYS, sysGoWaysOf, type SysGoWay } from '../../../shared/sysGo';

/*
 * A realm's `sys go` towns are ways from the room a walk starts in (the user,
 * 2026-11-27): in Silvermere bound for the Barren Hills, the walk says
 * `sys go lost` first.
 */
describe('a walk that takes sys go', () => {
  /** A town (1/1) and a road of 20 rooms east to the hills (2/1), and a town beside the hills (2/5). */
  const world = () =>
    worldOf([
      { m: 1, r: 1, n: 'Town Square', x: { e: { m: 1, r: 2 } } },
      ...Array.from({ length: 20 }, (_, i) => ({
        m: 1,
        r: 2 + i,
        n: 'Long Road',
        x: { w: { m: 1, r: 1 + i }, e: i === 19 ? { m: 2, r: 1 } : { m: 1, r: 3 + i } }
      })),
      { m: 2, r: 1, n: 'Barren Hills', x: { w: { m: 1, r: 21 }, e: { m: 2, r: 2 } } },
      { m: 2, r: 2, n: 'Barren Hills', x: { w: { m: 2, r: 1 }, e: { m: 2, r: 5 } } },
      { m: 2, r: 5, n: 'Lost City', x: { w: { m: 2, r: 2 } } },
      { m: 3, r: 1, n: 'Pit', x: {} }
    ]);
  const ways: readonly SysGoWay[] = [
    { command: 'sys go lost', map: 2, room: 5 },
    { command: 'sys go nowhere', map: 9, room: 9 }
  ];

  it('says the sys go first where it is shorter, and walks on from the town', () => {
    const route = world().route('1/1', '2/1', { sysGo: ways });
    expect(route.steps.map((step) => step.command)).toEqual(['sys go lost', 'w', 'w']);
    expect(route.steps[0]).toMatchObject({ direction: 'portal', to: '2/5' });
    expect(route.steps[0]?.invoke).toBeUndefined();
  });

  it('walks where walking is shorter, and never sys goes without the ways', () => {
    const graph = world();
    expect(graph.route('1/2', '1/1', { sysGo: ways }).steps.map((step) => step.command)).toEqual([
      'w'
    ]);
    expect(graph.route('1/1', '2/1', {}).steps).toHaveLength(21);
  });

  it('leaves a room nothing walks out of by sys go', () => {
    const graph = world();
    expect(graph.route('3/1', '2/1', {}).blocked).toBe(true);
    const out = graph.route('3/1', '2/1', { sysGo: ways });
    expect(out.blocked).toBe(false);
    expect(out.steps.map((step) => step.command)).toEqual(['sys go lost', 'w', 'w']);
  });

  it('ranks an errand by the same walk, sys go and all', () => {
    const graph = world();
    const wanted = new Set(['2/2', '3/1']);
    expect(graph.sweepTo('1/1', wanted, {}).get('2/2')?.moves).toBe(22);
    expect(graph.sweepTo('1/1', wanted, { sysGo: ways }).get('2/2')?.moves).toBe(2);
    expect(graph.sweepTo('3/1', wanted, { sysGo: ways }).get('2/2')?.moves).toBe(2);
  });

  it('has the four towns of stock MajorMUD in its shipped world, and none elsewhere', () => {
    const stock = WorldGraph.load('resources/world/majormud.jsonl.gz');
    expect(SYS_GO_WAYS.majormud.map((way) => stock.get(way.map, way.room)?.name)).toEqual([
      'Temple, Halls of the Dead',
      'Khazarad, Entry Arch',
      'Well Lit Alley, Dead End',
      'Rhudaur, Massive Doors'
    ]);
    // Silvermere's Temple Healer to the Barren Hills, by way of the Lost City.
    const route = stock.route('1/527', '16/644', { sysGo: sysGoWaysOf('majormud', true) });
    expect(route.blocked).toBe(false);
    expect(route.steps[0]?.command).toBe('sys go lost');
    expect(sysGoWaysOf('majormud', false)).toEqual([]);
    expect(sysGoWaysOf(null, true)).toEqual([]);
    expect(sysGoWaysOf('greatermud', true)).toEqual([]);
  });
});
