import { describe, expect, it } from 'vitest';
import { roomsNameCanBe } from '../nameLine';
import { isPortalClaim, type Expectation } from '../expectations';
import { worldOf } from '../../world/__tests__/realmFile';
import { roomId, type Direction } from '../../../shared/world';

/*
 * Paradigm 7/1358 and the bridge past its crack, as the shipped realm has
 * them: three rooms are called Magma River, Obsidian Bridge and only 7/1364
 * takes `go crack` back (todo 128).
 */
const rooms = [
  {
    m: 7,
    r: 1358,
    n: 'Volcanic Chamber',
    x: { s: { m: 7, r: 1357 }, ne: { m: 7, r: 1364, i: 'Text: go crack, enter crack' } }
  },
  {
    m: 7,
    r: 1364,
    n: 'Magma River, Obsidian Bridge',
    x: { ne: { m: 7, r: 1365 }, sw: { m: 7, r: 1358, i: 'Text: go crack, enter crack' } }
  },
  {
    m: 7,
    r: 1365,
    n: 'Magma River, Obsidian Bridge',
    x: { n: { m: 7, r: 1366 }, sw: { m: 7, r: 1364 } }
  },
  {
    m: 7,
    r: 1366,
    n: 'Magma River, Obsidian Bridge',
    x: { s: { m: 7, r: 1365 }, ne: { m: 7, r: 1367 } }
  }
];
const world = worldOf(rooms, { v: 11 });

const BRIDGE = 'Magma River, Obsidian Bridge';

/** The buttons the name line gets, standing in `room` with `queued` waiting, head first. */
function buttons(
  room: number | null,
  queued: Expectation | null | readonly Expectation[],
  promised: { map: number; number: number } | null = null
): string[] | undefined {
  const pending: readonly Expectation[] =
    queued === null ? [] : Array.isArray(queued) ? queued : [queued as Expectation];
  const rooms = roomsNameCanBe(world, BRIDGE, room === null ? null : roomId(7, room), {
    head: () => pending[0] ?? null,
    promised,
    portalOwed: pending.some(isPortalClaim)
  });
  return world.roomCommandsAmong(rooms);
}

const step = (direction: Direction): Expectation => ({
  kind: 'move',
  direction,
  command: direction
});

describe('the rooms a room name line can be', () => {
  it('is the room the step leads to', () => {
    expect(buttons(1358, { kind: 'move', direction: 'ne', command: 'go crack' })).toEqual([
      'go crack'
    ]);
    expect(buttons(1366, step('s'))).toBeUndefined();
  });

  // A reprint of the room stood in can answer the step's head; only the exits tell them apart.
  it('keeps the room stood in while a step leads to a namesake', () => {
    expect(buttons(1365, step('sw'))).toBeUndefined();
    const portal: Expectation = { kind: 'move', direction: null, command: 'go portal' };
    expect(buttons(1365, portal, { map: 7, number: 1364 })).toBeUndefined();
  });

  it('is the namesake next door when nothing announced the move', () => {
    expect(buttons(1358, null)).toEqual(['go crack']);
  });

  it('is the portal’s promised room', () => {
    const portal: Expectation = { kind: 'move', direction: null, command: 'go portal' };
    expect(buttons(null, portal, { map: 7, number: 1364 })).toEqual(['go crack']);
  });

  // Todo 763: a block answering the step ahead of an owed portal is not its landing.
  it('keeps the promise for the portal’s own block', () => {
    const portal: Expectation = { kind: 'move', direction: null, command: 'go portal' };
    expect(buttons(1366, [step('s'), portal], { map: 7, number: 1364 })).toBeUndefined();
  });

  /*
   * The positive controls are above: from 7/1358, or by a step, the same name
   * gets its button. Standing on the bridge, a re-read or an unasked reprint
   * could be the room stood in or the namesake beside it until the exits say.
   */
  it('refuses while the room stood in and a namesake next door disagree', () => {
    expect(buttons(1364, { kind: 'reread', command: 'l' })).toBeUndefined();
    expect(buttons(1365, null)).toBeUndefined();
    expect(buttons(null, null)).toBeUndefined();
  });

  it('reads a peek by its name alone', () => {
    expect(buttons(1358, { kind: 'peek', command: 'l ne' })).toBeUndefined();
  });
});
