import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { Errands, type ErrandsParts, type ErrandsSession } from '../Errands';
import { WorldGraph } from '../../world/WorldGraph';
import { DEFAULT_CONFIG } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { roomId } from '../../../shared/world';

/*
 * A loop asks whether the character stands on its lap's leg each time it
 * plans the next one. Each ask was a route search on the socket thread: 9.9 s
 * of the 33.7 s the hosted client stalled in 48 minutes (2026-11-17, todo
 * 20261117-2040-01). The leg is searched once and kept while what decides a
 * way holds.
 */
function corridor(): WorldGraph {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-leg-'));
  const file = path.join(dir, 'rooms.jsonl.gz');
  const header = JSON.stringify({ v: 43, source: 'test', rooms: 5, generatedAt: 'x' });
  const rooms = [
    { m: 1, r: 1, n: 'Stop One', x: { e: { m: 1, r: 2 } } },
    { m: 1, r: 2, n: 'Trail', x: { w: { m: 1, r: 1 }, e: { m: 1, r: 3 }, s: { m: 1, r: 5 } } },
    { m: 1, r: 3, n: 'Trail', x: { w: { m: 1, r: 2 }, e: { m: 1, r: 4 } } },
    { m: 1, r: 4, n: 'Stop Two', x: { w: { m: 1, r: 3 } } },
    { m: 1, r: 5, n: 'Side Room', x: { n: { m: 1, r: 2 } } }
  ];
  fs.writeFileSync(
    file,
    zlib.gzipSync([header, ...rooms.map((r) => JSON.stringify(r))].join('\n'))
  );
  const graph = WorldGraph.load(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return graph;
}

const standing = (room: number, level = 10): CharacterState => ({
  ...EMPTY_CHARACTER,
  room: { ...EMPTY_CHARACTER.room, map: 1, number: room },
  vitals: { ...EMPTY_CHARACTER.vitals, hp: 100, hpMax: 100 },
  progress: { ...EMPTY_CHARACTER.progress, level }
});

function book(): {
  errands: Errands;
  tracker: { current: CharacterState; pendingMoves: number };
  searches: () => number;
} {
  const world = corridor();
  const route = vi.spyOn(world, 'route');
  const tracker = { current: standing(2), pendingMoves: 0 };
  const errands = new Errands(
    {
      world,
      tracker,
      fightRecord: {},
      combatOn: () => true,
      lore: new Proxy({}, { get: () => () => null })
    } as unknown as ErrandsParts,
    {
      config: () => DEFAULT_CONFIG.automation,
      family: () => 'greatermud',
      notice: () => undefined,
      odds: () => ({ mob: () => ({ kind: 'unread' }), lair: () => ({ kind: 'unread' }) }),
      rates: () => new Map(),
      watched: () => ({}),
      backstabWeapon: () => null,
      roomCoded: () => null
    } as unknown as ErrandsSession
  );
  return { errands, tracker, searches: () => route.mock.calls.length };
}

const ONE = roomId(1, 1);
const TWO = roomId(1, 4);

describe('standing on a lap leg', () => {
  it('answers from the leg it searched once, wherever the character stands', () => {
    const { errands, tracker, searches } = book();
    expect(errands.standsOnLeg(ONE, TWO)).toBe(true);
    // Positive control: the first ask did search.
    const first = searches();
    expect(first).toBeGreaterThan(0);
    tracker.current = standing(3);
    expect(errands.standsOnLeg(ONE, TWO)).toBe(true);
    tracker.current = standing(5);
    expect(errands.standsOnLeg(ONE, TWO)).toBe(false);
    // The leg's start is not a room it steps into.
    tracker.current = standing(1);
    expect(errands.standsOnLeg(ONE, TWO)).toBe(false);
    expect(searches()).toBe(first);
  });

  it('searches again for another leg, and when what decides a way moves', () => {
    const { errands, tracker, searches } = book();
    errands.standsOnLeg(ONE, TWO);
    const first = searches();
    errands.standsOnLeg(TWO, ONE);
    const second = searches();
    expect(second).toBeGreaterThan(first);
    // A level gained can open a way: the same leg is searched again.
    tracker.current = standing(2, 11);
    expect(errands.standsOnLeg(ONE, TWO)).toBe(true);
    expect(searches()).toBeGreaterThan(second);
  });

  it('is false while the character cannot be placed', () => {
    const { errands, tracker, searches } = book();
    tracker.current = { ...standing(2), room: EMPTY_CHARACTER.room };
    expect(errands.standsOnLeg(ONE, TWO)).toBe(false);
    expect(searches()).toBe(0);
    // Positive control: placed, the same ask searches.
    tracker.current = standing(2);
    expect(errands.standsOnLeg(ONE, TWO)).toBe(true);
    expect(searches()).toBeGreaterThan(0);
  });

  it('keeps a leg with no way as one that steps into no room', () => {
    const { errands, searches } = book();
    const nowhere = roomId(9, 9);
    expect(errands.standsOnLeg(ONE, nowhere)).toBe(false);
    const first = searches();
    expect(first).toBeGreaterThan(0);
    expect(errands.standsOnLeg(ONE, nowhere)).toBe(false);
    expect(searches()).toBe(first);
  });
});
