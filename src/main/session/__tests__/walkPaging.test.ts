import { describe, expect, it, vi } from 'vitest';

import { WalkPaging, type PageRoute } from '../walkPaging';
import type { RoutePage } from '../../../shared/routeLegs';
import type { RouteStep } from '../../../shared/world';

/** A step from room `n` to room `n + 1`. */
const step = (n: number): RouteStep => ({
  from: `1/${n}`,
  to: `1/${n + 1}`,
  direction: 'e',
  command: 'e',
  name: `Room ${n + 1}`,
  requirement: null,
  dark: false
});

/** One page per step, so a walk of five steps is five pages. */
const pageEach: PageRoute = (route) =>
  route.steps.map((taken): RoutePage => ({
    rooms: [taken.from, taken.to],
    steps: [taken],
    jump: null,
    entry: null,
    sheet: null
  }));

const walkOf = (steps: number, done = 0) => ({
  remaining: Array.from({ length: steps }, (_, at) => step(at + 1)),
  progress: { done }
});

describe('the walk paged for the Map card', () => {
  it('sends the page being walked and the next, and a later one when asked', () => {
    const paging = new WalkPaging();
    const route = vi.fn(pageEach);
    const first = paging.first('a', walkOf(5, 3), route);
    expect(route).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ done: 3, count: 5 });
    expect(first.legs.map((page) => page.rooms[0])).toEqual(['1/1', '1/2']);

    // Turning to the fourth page asks for it, from the same paging.
    expect(paging.later('a', first.paging, 3)?.rooms[0]).toBe('1/4');
    expect(paging.later('a', first.paging, 5)).toBeNull();
    expect(paging.later('b', first.paging, 3)).toBeNull();
    expect(route).toHaveBeenCalledTimes(1);
  });

  it('answers nothing for a paging the walk was paged past', () => {
    const paging = new WalkPaging();
    const old = paging.first('a', walkOf(5), pageEach);
    const next = paging.first('a', walkOf(4, 1), pageEach);
    expect(paging.later('a', next.paging, 3)?.rooms[0]).toBe('1/4');
    expect(paging.later('a', old.paging, 3)).toBeNull();
    paging.forget('a');
    expect(paging.later('a', next.paging, 3)).toBeNull();
  });

  it('pages nothing with no walk or no realm data', () => {
    const paging = new WalkPaging();
    expect(paging.first('a', undefined, pageEach).count).toBe(0);
    expect(paging.first('a', walkOf(3), () => null).count).toBe(0);
  });
});
