import { describe, expect, it } from 'vitest';

import { WorldGraph } from '../WorldGraph';
import { roomId } from '../../../shared/world';

/*
 * Todo 837: the Grand Stair door at 7/150 opens only from a lever at 7/152,
 * so routing treated it as a wall and never offered a way through it. Priced
 * as the walk there and back, the route is offered; `Levers.fetchLever`
 * already makes that walk when the server refuses the step.
 */
describe('a door whose lever is in another room', () => {
  const world = WorldGraph.load('resources/world/paradigm.jsonl.gz');
  const stair = roomId(7, 150);
  const beyond = roomId(7, 151);

  it('is priced as the walk to the lever and back', () => {
    const route = world.route(stair, beyond);
    expect(route.blocked).toBe(false);
    expect(route.walls ?? []).toEqual([]);
    expect(route.steps.map((step) => step.direction)).toEqual(['se']);
  });

  it('offers Black House to the Fungus Forest, which the wall kept apart', () => {
    const route = world.route(roomId(1, 1313), roomId(7, 157));
    expect(route.blocked).toBe(false);
    expect(route.walls ?? []).toEqual([]);
    expect(route.steps.some((step) => step.from === stair && step.to === beyond)).toBe(true);
  });

  it('stays a wall when the lever room is one to keep out of', () => {
    const route = world.route(stair, beyond, { avoid: new Set([roomId(7, 152)]) });
    expect((route.walls ?? []).length + (route.blocked ? 1 : 0)).toBeGreaterThan(0);
  });
});
