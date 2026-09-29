import { describe, expect, it } from 'vitest';

import { legsOf, pageWalking, pagesOf } from '../routeLegs';
import type { LocalMap, MapCell } from '../map';
import type { Route, RouteStep } from '../world';

const step = (from: string, to: string, over: Partial<RouteStep> = {}): RouteStep => ({
  from,
  to,
  direction: 'e',
  command: 'e',
  name: to,
  requirement: null,
  dark: false,
  ...over
});

const route = (steps: RouteStep[], blocked = false): Route => ({
  steps,
  cost: steps.length,
  blocked
});

describe('cutting a route into legs', () => {
  it('keeps a flat walk on one map as one leg', () => {
    const legs = legsOf(route([step('12/694', '12/695'), step('12/695', '12/696')]), '12/694');
    expect(legs).toHaveLength(1);
    expect(legs[0]?.rooms).toEqual(['12/694', '12/695', '12/696']);
    expect(legs[0]?.jump).toBeNull();
  });

  it('ends a leg at a way down, a typed exit, a portal and another map', () => {
    const down = step('12/695', '12/900', { direction: 'd', command: 'd' });
    const manhole = step('12/900', '12/901', { command: 'go manhole' });
    const portal = step('12/902', '12/950', { direction: 'portal', command: 'touch orb' });
    const across = step('12/950', '3/10', { direction: 'n', command: 'n' });
    const legs = legsOf(
      route([
        step('12/694', '12/695'),
        down,
        manhole,
        step('12/901', '12/902'),
        portal,
        across,
        step('3/10', '3/11')
      ]),
      '12/694'
    );
    expect(legs.map((leg) => leg.rooms)).toEqual([
      ['12/694', '12/695'],
      ['12/900'],
      ['12/901', '12/902'],
      ['12/950'],
      ['3/10', '3/11']
    ]);
    expect(legs.map((leg) => leg.jump)).toEqual([down, manhole, portal, across, null]);
    expect(legs.map((leg) => leg.entry)).toEqual([null, down, manhole, portal, across]);
  });

  it('answers one leg of the room for a route already there, and none for a refusal', () => {
    expect(legsOf(route([]), '12/694')).toEqual([
      { rooms: ['12/694'], steps: [], jump: null, entry: null }
    ]);
    expect(legsOf(route([], true), '12/694')).toEqual([]);
  });
});

/* A map that places its centre and the two rooms east of it, in a row. */
const row = (centre: string): LocalMap => {
  const first = Number(centre.split('/')[1]);
  const cells: MapCell[] = [0, 1, 2].map((offset) => ({
    id: `1/${first + offset}`,
    name: `1/${first + offset}`,
    gx: offset,
    gy: 0,
    exits: ['e', 'w'],
    vertical: null,
    shop: false,
    lair: false
  }));
  return { centre, cells, dropped: 0 };
};

/* Every stretch on a page of its own, as the paging was before packing. */
const ALONE = { stretches: 1, steps: 0 };
const PACKED = { stretches: 6, steps: 6 };

describe('paging a leg the map cannot draw whole', () => {
  const east = [1, 2, 3, 4, 5, 6].map((room) => step(`1/${room}`, `1/${room + 1}`));

  it('starts the next page on the last room the line reached', () => {
    const pages = pagesOf(route(east), '1/1', row, ALONE);
    expect(pages.map((page) => page.rooms)).toEqual([
      ['1/1', '1/2', '1/3'],
      ['1/3', '1/4', '1/5'],
      ['1/5', '1/6', '1/7']
    ]);
    expect(pages.map((page) => page.steps.length)).toEqual([2, 2, 2]);
    expect(pages.every((page) => page.jump === null)).toBe(true);
  });

  it('keeps the jump on the page that ends the leg, and the entry on the one that starts it', () => {
    const up = step('1/3', '2/1', { direction: 'u', command: 'u' });
    const pages = pagesOf(route([...east.slice(0, 2), up]), '1/1', row, ALONE);
    expect(pages[0]?.jump).toBe(up);
    expect(pages[1]?.entry).toBe(up);
  });

  it('keeps a step no map can draw on a page of its own rather than looping', () => {
    const pages = pagesOf(
      route(east.slice(0, 2)),
      '1/1',
      () => ({ centre: null, cells: [], dropped: 0 }),
      ALONE
    );
    expect(pages.map((page) => page.rooms)).toEqual([
      ['1/1', '1/2'],
      ['1/2', '1/3']
    ]);
  });
});

describe('gathering short stretches onto one page', () => {
  const down = (from: string, to: string): RouteStep =>
    step(from, to, { direction: 'd', command: 'd' });

  it('stacks a way down taken over and over as floors of one page', () => {
    const steps = [down('1/1', '1/10'), down('1/10', '1/20'), down('1/20', '1/30')];
    const pages = pagesOf(route(steps), '1/1', row, PACKED);
    expect(pages).toHaveLength(1);
    const sheet = pages[0]?.sheet;
    expect(sheet?.floors.map((floor) => floor.level)).toEqual([0, -1, -2, -3]);
    expect(sheet?.stretches.map((stretch) => stretch.join?.kind ?? null)).toEqual([
      null,
      'down',
      'down',
      'down'
    ]);
    expect(pages[0]?.steps).toEqual(steps);
    expect(pages[0]?.rooms).toEqual(['1/1', '1/10', '1/20', '1/30']);
  });

  it('puts a stretch back on a floor the page already drew', () => {
    const up = step('1/2', '1/50', { direction: 'u', command: 'u' });
    const pages = pagesOf(route([step('1/1', '1/2'), up, down('1/50', '1/3')]), '1/1', row, PACKED);
    const sheet = pages[0]?.sheet;
    expect(sheet?.floors.map((floor) => floor.level)).toEqual([0, 1]);
    expect(sheet?.stretches.map((stretch) => stretch.floor)).toEqual([0, 1, 0]);
  });

  it('gives a long stretch a page to itself and draws a page of one stretch live', () => {
    const manhole = step('1/3', '1/40', { command: 'go manhole' });
    const pages = pagesOf(
      route([step('1/1', '1/2'), step('1/2', '1/3'), manhole, step('1/40', '1/41')]),
      '1/1',
      row,
      { stretches: 6, steps: 1 }
    );
    expect(pages.map((page) => page.rooms)).toEqual([
      ['1/1', '1/2', '1/3'],
      ['1/40', '1/41']
    ]);
    expect(pages.map((page) => page.sheet)).toEqual([null, null]);
  });

  it('names the room a cut carries on from once', () => {
    const east = [1, 2, 3, 4].map((room) => step(`1/${room}`, `1/${room + 1}`));
    const pages = pagesOf(route(east), '1/1', row, PACKED);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.rooms).toEqual(['1/1', '1/2', '1/3', '1/4', '1/5']);
    expect(pages[0]?.sheet?.stretches.map((stretch) => stretch.join?.kind ?? null)).toEqual([
      null,
      'onward'
    ]);
  });

  it('crops each floor to its stretches and drops the ways off it', () => {
    const wide = (centre: string): LocalMap => {
      const cells = row(centre).cells.map((cell) => ({ ...cell, away: [] }));
      return { centre, cells: [...cells, { ...cells[0]!, id: '1/99', gx: 9 }], dropped: 0 };
    };
    const pages = pagesOf(route([down('1/1', '1/10')]), '1/1', wide, PACKED);
    const cells = pages[0]?.sheet?.floors[0]?.map.cells ?? [];
    expect(cells.map((cell) => cell.id)).toEqual(['1/1', '1/2']);
    expect(cells.some((cell) => cell.away !== undefined)).toBe(false);
  });
});

describe('finding the page a walk is on', () => {
  const down = step('12/695', '12/900', { direction: 'd', command: 'd' });
  const legs = legsOf(
    route([step('12/694', '12/695'), down, step('12/900', '12/901'), step('12/901', '12/902')]),
    '12/694'
  );

  it('counts the jump off a page as the last step on it', () => {
    expect([0, 1, 2, 3, 4].map((walked) => pageWalking(legs, walked))).toEqual([0, 0, 1, 1, 1]);
  });

  it('answers null for a count outside the pages', () => {
    expect(pageWalking(legs, 5)).toBeNull();
    expect(pageWalking(legs, -1)).toBeNull();
    expect(pageWalking([], 0)).toBeNull();
  });
});
