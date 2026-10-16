import { describe, expect, it } from 'vitest';

import { worldOf } from './realmFile';
import { DEFAULT_MOVEMENT_CHOICES } from '../../../shared/walkChoices';
import type { WorldRoom } from '../../../shared/world';

/*
 * Todo 145: from inside the Black Wasteland, whose every way in and out is a
 * `go vortex` and whose rooms' names do not say it, a route to the Hazy Swamp
 * planned the token of Silvermere instead of the vortex two rooms away.
 */
describe('a place every way into crosses a kept-out word', () => {
  const keepOut = { words: ['vortex'] };
  const vortex = (to: string): Record<string, unknown> => ({ say: ['go vortex'], to });
  /** The wasteland (3/1–3/3), the town and swamp outside it, the Pier the token lands on 30 rooms from the swamp, an isle a vortex or a token reaches, and a cellar only a token reaches. */
  const world = () =>
    worldOf(
      [
        { m: 1, r: 1, n: 'Town Square', x: { e: { m: 1, r: 2 } }, cmd: [vortex('3/1')] },
        {
          m: 1,
          r: 2,
          n: 'Road',
          x: { w: { m: 1, r: 1 }, e: { m: 7, r: 1 } },
          cmd: [{ say: ['enter vortex'], to: '5/1' }]
        },
        {
          m: 7,
          r: 1,
          n: 'Hazy Swamp',
          x: { w: { m: 1, r: 2 }, s: { m: 1, r: 79 } },
          cmd: [vortex('3/3')]
        },
        { m: 3, r: 1, n: 'Black Wasteland', x: { e: { m: 3, r: 2 } }, cmd: [vortex('1/1')] },
        { m: 3, r: 2, n: 'Black Wasteland', x: { w: { m: 3, r: 1 }, e: { m: 3, r: 3 } } },
        { m: 3, r: 3, n: 'Black Wasteland', x: { w: { m: 3, r: 2 } }, cmd: [vortex('7/1')] },
        ...Array.from({ length: 30 }, (_, i) => ({
          m: 1,
          r: 50 + i,
          n: i === 0 ? 'Pier' : 'Shore Road',
          x: {
            ...(i > 0 ? { w: { m: 1, r: 49 + i } } : {}),
            e: i === 29 ? { m: 7, r: 1 } : { m: 1, r: 51 + i }
          }
        })),
        { m: 5, r: 1, n: 'Isle', x: {}, cmd: [vortex('1/2')] },
        { m: 6, r: 1, n: 'Cellar', x: {} }
      ],
      {
        v: 40,
        items: [
          { id: 8, n: 'token of Silvermere', type: 0, lands: '1/50', uses: 5 },
          { id: 9, n: 'isle token', type: 0, lands: '5/1', uses: 5 },
          { id: 10, n: 'potion of levitation', type: 0, lands: '6/1', uses: 1 }
        ]
      }
    );

  it('walks out by the vortex from inside, whoever reads the route', () => {
    const graph = world();
    const traveller = { keepOut, keys: [8], packKnown: true };
    for (const alternatives of [false, true]) {
      const route = graph.route('3/1', '7/1', traveller, { alternatives });
      expect(route.steps.map((step) => step.command)).toEqual(['e', 'e', 'go vortex']);
      expect(route.steps.some((step) => step.invoke !== undefined)).toBe(false);
      expect(route.keptOut).toBeUndefined();
    }
    // Without the token the walk was refused, not 33 steps from the Pier.
    expect(graph.route('3/1', '7/1', { ...traveller, keys: [] }).steps).toHaveLength(3);
  });

  it('still keeps a walk from outside out of it', () => {
    const graph = world();
    const refused = graph.route('1/1', '3/2', { keepOut, keys: [8], packKnown: true });
    expect(refused.blocked).toBe(true);
    expect(refused.blocks?.some((block) => block.kind === 'keptOut')).toBe(true);
    const read = graph.route('1/1', '3/2', { keepOut }, { alternatives: true });
    expect(read.steps[0]?.command).toBe('go vortex');
    expect(read.keptOut?.round.blocked).toBe(true);
  });

  it('refuses a walk only the word stops rather than spend an item past it', () => {
    const graph = world();
    const traveller = { keepOut, keys: [9], packKnown: true };
    // Unlisted, the vortex is the way and no charge is spent.
    expect(graph.route('1/1', '5/1', { keys: [9], packKnown: true }).steps).toHaveLength(2);
    const refused = graph.route('1/1', '5/1', traveller);
    expect(refused.blocked).toBe(true);
    expect(refused.blocks?.filter((block) => block.kind === 'keptOut')).toEqual([
      { kind: 'keptOut', at: '1/2', to: '5/1', name: 'Isle', word: 'vortex' }
    ]);
    const read = graph.route('1/1', '5/1', traveller, { alternatives: true });
    expect(read.steps.map((step) => step.command)).toEqual(['e', 'enter vortex']);
    expect(read.keptOut?.round.blocked).toBe(true);
  });

  it('still uses an item where nothing walks there at all', () => {
    const route = world().route('1/1', '6/1', { keepOut, keys: [10], packKnown: true });
    expect(route.blocked).toBe(false);
    expect(route.steps.map((step) => step.invoke?.name)).toEqual(['potion of levitation']);
  });

  it('lets the neighbourhood of a room inside it leave by the word', () => {
    const near = world().withinSteps('3/1', 3, { keepOut });
    expect(near.has('1/1')).toBe(true);
    expect(world().withinSteps('1/1', 3, { keepOut }).has('3/1')).toBe(false);
  });
});

/*
 * Todo 145: the route panel offers the fewest moves beside a plan more than a
 * fifth longer (`Route.direct`), the 20% counted in moves (the user,
 * 2026-10-15).
 */
describe('the most direct way', () => {
  /** From 1/1, `short` steps east through a scalding pool, or `long` steps south round it. */
  const fork = (short: number, long: number) => {
    const chain = (map: number, count: number, name: (i: number) => string) =>
      Array.from({ length: count - 1 }, (_, i) => ({
        m: map,
        r: i + 1,
        n: name(i),
        x: { e: i === count - 2 ? { m: 1, r: 2 } : { m: map, r: i + 2 } }
      }));
    return worldOf([
      { m: 1, r: 1, n: 'Fork', x: { e: { m: 2, r: 1 }, s: { m: 4, r: 1 } } },
      ...chain(2, short, (i) => (i === 0 ? 'Scalding Pool' : 'Hot Path')),
      ...chain(4, long, () => 'Long Way'),
      { m: 1, r: 2, n: 'Goal', x: {} }
    ]);
  };
  // A fifth of the bar: 50 steps' worth, so the plan goes round.
  const hazard = (room: WorldRoom): number | null => (room.name === 'Scalding Pool' ? 0.2 : null);
  // Another way priced as the plan, so it re-finds the plan and the direct way is the one offered.
  const prices = { ...DEFAULT_MOVEMENT_CHOICES, anotherWayPenalty: 1 };

  it('is offered past a fifth longer, with what it walks through', () => {
    const route = fork(100, 121).route('1/1', '1/2', { hazard, prices }, { alternatives: true });
    expect(route.steps).toHaveLength(121);
    expect(route.direct?.steps).toHaveLength(100);
    expect(route.direct?.steps[0]?.hazard).toBeGreaterThan(0);
  });

  it('is not offered at a fifth longer or less', () => {
    const route = fork(100, 120).route('1/1', '1/2', { hazard, prices }, { alternatives: true });
    // Positive control: the plan still goes round, and there is a shorter way.
    expect(route.steps).toHaveLength(120);
    expect(route.direct).toBeUndefined();
  });

  it('is not the plan again, nor an alternative already offered', () => {
    const plain = fork(100, 121).route('1/1', '1/2', {}, { alternatives: true });
    expect(plain.steps).toHaveLength(100);
    expect(plain.direct).toBeUndefined();
    const another = fork(100, 121).route('1/1', '1/2', { hazard }, { alternatives: true });
    expect(another.another?.steps).toHaveLength(100);
    expect(another.direct).toBeUndefined();
  });

  it('is not looked for on a walk nobody reads', () => {
    const walked = fork(100, 121).route('1/1', '1/2', { hazard, prices });
    expect(walked.steps).toHaveLength(121);
    expect(walked.direct).toBeUndefined();
  });

  it('walks a door the character cannot force as no way', () => {
    const graph = worldOf([
      {
        m: 1,
        r: 1,
        n: 'Fork',
        x: { e: { m: 1, r: 3, i: 'Door [1000 picklocks/strength]' }, s: { m: 4, r: 1 } }
      },
      { m: 1, r: 3, n: 'Vault', x: { e: { m: 1, r: 2 } } },
      ...Array.from({ length: 4 }, (_, i) => ({
        m: 4,
        r: i + 1,
        n: 'Long Way',
        x: { e: i === 3 ? { m: 1, r: 2 } : { m: 4, r: i + 2 } }
      })),
      { m: 1, r: 2, n: 'Goal', x: {} }
    ]);
    const route = graph.route('1/1', '1/2', { strength: 0, pickSkill: 0 }, { alternatives: true });
    // Positive control: the door is two moves and the plan's five go round it.
    expect(route.steps).toHaveLength(5);
    expect(route.direct).toBeUndefined();
  });
});
