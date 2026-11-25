import { describe, expect, it } from 'vitest';

import { droppersPerHour, pickRing, type RingAsk, type RingPlace } from '../dropRing';
import type { RoomId } from '../../../shared/world';

const ROWS = new Set([228]);
const noResident = (): number => 121;

describe('droppers an hour one room brings up', () => {
  it('is a lair’s slots over its clock, by the share of its rows that drop', () => {
    // Western Road, Fork: three slots every ten minutes, one row of seven.
    const fork = { lair: '(Max 3): 223,224,225,226,227,228,229,[9-5-11-3]' };
    expect(droppersPerHour(fork, ROWS, 600, noResident)).toBeCloseTo((3 / 7) * 6);
    // Rhudaur Town Centre: four slots every two minutes, every one a dark monk.
    const centre = { lair: '(Max 4): 258,[19-5-5-4]' };
    expect(droppersPerHour(centre, new Set([258]), 120, noResident)).toBeCloseTo(120);
  });

  it('is one draw in ten a clock where the dropper only wanders in', () => {
    const road = { wanderers: [223, 224, 225, 226, 227, 228, 229] };
    expect(droppersPerHour(road, ROWS, 300, noResident)).toBeCloseTo((0.1 / 7) * 12);
  });

  it('is the resident’s own clock, and unknown for a room that lists no dropper', () => {
    expect(droppersPerHour({ npcId: 228 }, ROWS, 300, () => 7200)).toBeCloseTo(0.5);
    expect(droppersPerHour({ npcId: 5, lair: '(Max 2): 5,6' }, ROWS, 300, noResident)).toBeNull();
  });
});

/*
 * A road of rooms `r0`..`r40` in a line, one move apart, and a far lair `far`
 * 200 moves from `r0` with nothing near it.
 */
const line = (from: RoomId, steps: number): Map<RoomId, number> => {
  const reach = new Map<RoomId, number>();
  if (!from.startsWith('r')) return reach.set(from, 0);
  const at = Number(from.slice(1));
  for (let room = 0; room <= 40; room += 1) {
    if (Math.abs(room - at) <= steps) reach.set(`r${room}` as RoomId, Math.abs(room - at));
  }
  return reach;
};
const ask = (rooms: number): RingAsk => ({
  rooms,
  radius: 20,
  wallCost: 100_000,
  stepSeconds: 1.25,
  within: line
});
const place = (id: string, moves: number, placed: boolean, rate: number | null): RingPlace => ({
  id: id as RoomId,
  cost: moves,
  moves,
  placed,
  rate
});
const road = (from: number): RingPlace[] =>
  Array.from({ length: 41 }, (_, room) => place(`r${room}`, Math.abs(room - from), false, 0.17));

describe('the rooms a hunt for a dropped item walks', () => {
  it('goes to the ring that brings a dropper up soonest, not the nearest', () => {
    // A poor lair where the character stands: one dropper in 100 hours.
    const here = place('r20', 0, true, 0.01);
    // 200 moves off, 250 seconds of walking, a lair of 120 an hour.
    const far = place('far', 200, true, 120);
    expect(pickRing([here, far], ask(8)).map((stop) => stop.id)).toEqual(['far']);
  });

  it('stays at the nearer ring where the farther one is no sooner', () => {
    const here = place('r20', 0, true, 100);
    const far = place('far', 200, true, 120);
    expect(pickRing([here, far], ask(8)).map((stop) => stop.id)).toEqual(['r20']);
  });

  /* A death that hands the item over states no rate: the walk alone decides. */
  it('never passes a room with no stated rate for a rated one farther off', () => {
    const death = place('r20', 3, true, null);
    const far = place('far', 200, true, 120);
    expect(pickRing([death, far], ask(8)).map((stop) => stop.id)).toEqual(['r20']);
    // And it is walked to past a poor rated lair that is nearer.
    const poor = place('r20', 0, true, 0.01);
    const sure = place('far', 200, true, null);
    expect(pickRing([poor, sure], ask(8)).map((stop) => stop.id)).toEqual(['far']);
  });

  it('leaves out a ring behind a wall while another is reached', () => {
    const here = place('r20', 0, true, 0.01);
    const walled = { ...place('far', 200, true, 120), cost: 100_200 };
    expect(pickRing([here, walled], ask(8))[0]!.id).toBe('r20');
    // Nothing else reached: the walk to the wall, as before.
    expect(pickRing([walled], ask(8)).map((stop) => stop.id)).toEqual(['far']);
  });

  it('spreads the wanderers’ rooms across the ring and walks them end to end', () => {
    const lair = place('r20', 0, true, 2.5);
    const stops = pickRing([lair, ...road(20).filter((each) => each.id !== 'r20')], ask(5)).map(
      (stop) => stop.id
    );
    // The lair first, then both ends of the ring and the rooms between.
    expect(stops[0]).toBe('r20');
    expect([...stops].sort()).toEqual(['r0', 'r10', 'r20', 'r30', 'r40'].sort());
    expect(stops).toEqual(['r20', 'r10', 'r0', 'r30', 'r40']);
  });

  it('keeps the lairs that bring up the most where the ring holds more than the cap', () => {
    const lairs = [place('r20', 0, true, 1), place('r21', 1, true, 9), place('r22', 2, true, 5)];
    expect(
      pickRing(lairs, ask(2))
        .map((stop) => stop.id)
        .sort()
    ).toEqual(['r21', 'r22']);
  });

  it('walks the wanderers’ rooms alone where no placement is reached', () => {
    const stops = pickRing(road(20), ask(3)).map((stop) => stop.id);
    expect(stops[0]).toBe('r20');
    expect(stops).toHaveLength(3);
  });
});
