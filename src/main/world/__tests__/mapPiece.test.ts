import { describe, expect, it, vi } from 'vitest';

import { worldOf } from './realmFile';
import { decorate, pieceOf, type LairLevel } from '../localMap';
import { MapPlacements } from '../MapPlacements';
import { placeFlat } from '../flatPlacement';
import type { WorldGraph } from '../WorldGraph';
import { MapCellStore } from '../../../shared/mapCells';
import type { MapWindow } from '../../../shared/map';
import { asMapAsk, type MapAsk } from '../../../shared/mapPiece';

/** A `size` by `size` grid of rooms joined to each neighbour, 1/1 at its north-west corner. */
function gridOf(size: number) {
  const id = (x: number, y: number) => y * size + x + 1;
  const rooms = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const x_: Record<string, { m: number; r: number }> = {};
      if (x + 1 < size) x_['e'] = { m: 1, r: id(x + 1, y) };
      if (x > 0) x_['w'] = { m: 1, r: id(x - 1, y) };
      if (y + 1 < size) x_['s'] = { m: 1, r: id(x, y + 1) };
      if (y > 0) x_['n'] = { m: 1, r: id(x, y - 1) };
      // Every fifth room a lair, so the odds ride across held cells.
      const lair = id(x, y) % 5 === 0 ? { lair: '(Max 2): 781,' } : {};
      rooms.push({ m: 1, r: id(x, y), n: `Room ${x},${y}`, x: x_, ...lair });
    }
  }
  return { graph: worldOf(rooms), id: (x: number, y: number) => `1/${id(x, y)}` };
}

const square = (reach: number): MapWindow => ({
  minX: -reach,
  maxX: reach,
  minY: -reach,
  maxY: reach
});

const limits = () => ({ frames: 4, windows: 8 });

/** A lair rated by its room number, so two characters can disagree. */
const rated: LairLevel = (room) => (room.room % 10 === 0 ? 'deadly' : 'safe');

/** Main's answer to `ask` round `centre`, as the handler gives it. */
function answer(
  placements: MapPlacements,
  graph: WorldGraph,
  centre: string,
  ask: MapAsk,
  lairLevel: LairLevel = rated
) {
  const placed = placements.of(graph, centre, ask.held?.frame ?? null);
  if (placed === null) throw new Error(`no placement for ${centre}`);
  return pieceOf(graph, placed, ask, lairLevel);
}

describe('the placements the maps are drawn on', () => {
  it('keeps a placement while the centre moves inside it, and places again outside it', () => {
    const graph = worldOf([
      { m: 1, r: 1, n: 'West', x: { e: { m: 1, r: 2 } } },
      { m: 1, r: 2, n: 'East', x: { w: { m: 1, r: 1 } } },
      { m: 2, r: 1, n: 'Island', x: {} }
    ]);
    const place = vi.fn(placeFlat);
    const placements = new MapPlacements(place);
    const first = placements.of(graph, '1/1');
    const moved = placements.of(graph, '1/2');
    expect(place).toHaveBeenCalledTimes(1);
    expect(moved).toMatchObject({ frame: first?.frame, centre: '1/2', at: { gx: 1, gy: 0 } });

    // The positive control: a room no kept placement holds is placed afresh.
    const away = placements.of(graph, '2/1');
    expect(place).toHaveBeenCalledTimes(2);
    expect(away?.frame).not.toBe(first?.frame);
    expect(away?.at).toEqual({ gx: 0, gy: 0 });
  });

  it('places a world loaded afresh again', () => {
    const rooms = [{ m: 1, r: 1, n: 'Here', x: {} }];
    const place = vi.fn(placeFlat);
    const placements = new MapPlacements(place);
    const first = placements.of(worldOf(rooms), '1/1');
    const again = placements.of(worldOf(rooms), '1/1');
    expect(place).toHaveBeenCalledTimes(2);
    expect(again?.frame).not.toBe(first?.frame);
  });
});

describe('a map asked for again after a step', () => {
  it('is sent only the new strip, and draws what a whole fetch draws', () => {
    const { graph, id } = gridOf(15);
    const placements = new MapPlacements();
    const tab = new MapCellStore(limits);
    const window = square(3);

    const firstAsk = tab.ask(id(7, 7), window);
    expect(firstAsk.held).toBeNull();
    const first = answer(placements, graph, id(7, 7), firstAsk);
    expect(first.cells).toHaveLength(49);
    tab.take(first, firstAsk);

    // One room east: the window moves one column.
    const nextAsk = tab.ask(id(8, 7), window);
    expect(nextAsk.held?.frame).toBe(first.frame);
    const next = answer(placements, graph, id(8, 7), nextAsk);
    expect(next.frame).toBe(first.frame);
    expect(next.cells).toHaveLength(7);
    expect(new Set(next.cells.map((cell) => cell.gx))).toEqual(new Set([4]));
    const drawn = tab.take(next, nextAsk);

    // A whole fetch of the same window, by a tab that holds nothing.
    const fresh = new MapCellStore(limits);
    const wholeAsk: MapAsk = { window, held: null };
    const whole = fresh.take(answer(placements, graph, id(8, 7), wholeAsk), wholeAsk);
    expect(drawn).toEqual(whole);
    expect(drawn?.cells).toHaveLength(49);
    expect(drawn?.cells.find((cell) => cell.id === id(8, 7))).toMatchObject({ gx: 0, gy: 0 });
  });

  it('draws the same cells as the decorated window of the placement', () => {
    const { graph, id } = gridOf(9);
    const placements = new MapPlacements();
    const tab = new MapCellStore(limits);
    const ask: MapAsk = { window: square(2), held: null };
    const drawn = tab.take(answer(placements, graph, id(4, 4), ask), ask);
    const placement = placeFlat(graph, id(4, 4));
    if (placement === null) throw new Error('not placed');
    const decorated = decorate(graph, placement, square(2), rated);
    const byId = (cells: ReadonlyArray<{ id: string }>) =>
      [...cells].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(drawn?.cells ?? [])).toEqual(byId(decorated.cells));
  });

  it('gives a held lair this character’s odds, sent again with each answer', () => {
    const { graph, id } = gridOf(9);
    const placements = new MapPlacements();
    const tab = new MapCellStore(limits);
    const window = square(2);
    const ask = tab.ask(id(4, 4), window);
    tab.take(answer(placements, graph, id(4, 4), ask), ask);
    // Another character of the realm, who rates every lair deadly, steps in place.
    const again = tab.ask(id(4, 4), window);
    const piece = answer(placements, graph, id(4, 4), again, () => 'deadly');
    expect(piece.cells).toHaveLength(0);
    const drawn = tab.take(piece, again);
    const lairs = drawn?.cells.filter((cell) => cell.lair) ?? [];
    expect(lairs.length).toBeGreaterThan(0);
    expect(lairs.every((cell) => cell.lairOdds === 'deadly')).toBe(true);
  });

  it('asks again whole when the placement it named was dropped meanwhile', () => {
    const { graph, id } = gridOf(5);
    const placements = new MapPlacements();
    const tab = new MapCellStore(() => ({ frames: 1, windows: 8 }));
    const window = square(1);
    const ask = tab.ask(id(2, 2), window);
    tab.take(answer(placements, graph, id(2, 2), ask), ask);
    const held = tab.ask(id(2, 2), window);
    expect(held.held).not.toBeNull();
    // Another realm's answer pushes the placement out before this one lands.
    const other = gridOf(3);
    const otherAsk: MapAsk = { window, held: null };
    tab.take(answer(placements, other.graph, other.id(1, 1), otherAsk), otherAsk);
    expect(tab.take(answer(placements, graph, id(2, 2), held), held)).toBeNull();
  });

  it('refuses an answer to a held ask when the placement was dropped and begun again', () => {
    const { graph, id } = gridOf(5);
    const placements = new MapPlacements();
    const tab = new MapCellStore(() => ({ frames: 1, windows: 8 }));
    const window = square(1);
    const ask = tab.ask(id(2, 2), window);
    tab.take(answer(placements, graph, id(2, 2), ask), ask);
    const held = tab.ask(id(2, 2), window);
    const other = gridOf(3);
    const otherAsk: MapAsk = { window, held: null };
    tab.take(answer(placements, other.graph, other.id(1, 1), otherAsk), otherAsk);
    // Another character's whole answer begins the same placement again, with fewer cells.
    const narrow: MapAsk = { window: square(0), held: null };
    expect(tab.take(answer(placements, graph, id(2, 2), narrow), narrow)?.cells).toHaveLength(1);
    expect(tab.take(answer(placements, graph, id(2, 2), held), held)).toBeNull();
  });

  it('reads an ask off the wire, dropping a held part it cannot use', () => {
    const window = square(1);
    expect(asMapAsk({ window, held: null }, 8)).toEqual({ window, held: null });
    expect(asMapAsk({ window, held: { frame: 3, windows: [window] } }, 8)?.held?.frame).toBe(3);
    expect(asMapAsk({ window, held: { frame: 3, windows: [window, window] } }, 1)?.held).toBeNull();
    expect(asMapAsk({ window, held: { frame: 0, windows: [] } }, 8)?.held).toBeNull();
    expect(asMapAsk({ window: { minX: 1, maxX: 0, minY: 0, maxY: 0 }, held: null }, 8)).toBeNull();
  });
});
