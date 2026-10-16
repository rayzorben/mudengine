import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { themePackFile } from '../../../shared/worlds';
import { GameMaps } from '../GameMaps';
import { NO_THEME_PACK, loadThemePack } from '../themePack';
import { WorldGraph } from '../WorldGraph';

const world = path.resolve('resources/world/paradigm.jsonl.gz');

describe.runIf(fs.existsSync(world))('the game view map window', () => {
  const graph = WorldGraph.load(world);
  const pack = loadThemePack(path.resolve('resources/world'), themePackFile('paradigm'));
  const maps = new GameMaps(graph, pack);

  it('centres on the asked room and holds only cells inside its square', () => {
    const window = maps.window({ kind: 'room', map: 1, room: 1, half: 12 }, () => null);
    expect(window.centre?.room).toBe('1/1');
    const { x0, y0, x1, y1 } = window.box;
    expect(x1 - x0).toBe(24);
    for (const cell of window.cells) {
      expect(cell.gx >= x0 && cell.gx <= x1 && cell.gy >= y0 && cell.gy <= y1).toBe(true);
      expect(window.areas[cell.area]).toBeDefined();
    }
    const gates = window.cells.find((cell) => cell.id === '1/1');
    expect(window.areas[gates!.area]!.name).toBe('Silvermere');
    expect(
      window.labels.some((label) => label.kind === 'area' && label.text === 'Silvermere')
    ).toBe(true);
  });

  it("gives each cell its exits' rooms, for the ways the grid cannot join", () => {
    const window = maps.window({ kind: 'room', map: 1, room: 1, half: 4 }, () => null);
    expect(window.cells.find((cell) => cell.id === '1/1')!.to.n).toBe('1/3');
  });

  it('names the map a compass exit onto another map number leads to', () => {
    const window = maps.window({ kind: 'room', map: 1, room: 141, half: 4 }, () => null);
    // Lofty Plateau's way south is Paradigm's 2/9; the plane is map 1's alone.
    expect(window.cells.find((cell) => cell.id === '1/141')!.otherMap).toEqual({ s: 2 });
    const gates = maps.window({ kind: 'room', map: 1, room: 1, half: 4 }, () => null);
    expect(gates.cells.find((cell) => cell.id === '1/1')!.otherMap).toBeUndefined();
  });

  it('marks a one-way exit at the room it leaves, and nothing at the room it enters', () => {
    const window = maps.window({ kind: 'room', map: 1, room: 1393, half: 3 }, () => null);
    const road = window.cells.find((cell) => cell.id === '1/1393')!;
    const behind = window.cells.find((cell) => cell.id === '1/1638')!;
    expect(behind.oneWay).toEqual(['e']);
    expect(behind.to.e).toBe('1/1393');
    expect(road.to.w).toBeUndefined();
    expect(road.oneWay).toBeUndefined();
  });

  it("holds one floor: the room's own, with its stairs to the next", () => {
    const window = maps.window({ kind: 'room', map: 8, room: 555, half: 3 }, () => null);
    const stairs = window.cells.find((cell) => cell.id === '8/555')!;
    expect(stairs.stairs).toEqual([
      expect.objectContaining({ direction: 'u', to: '8/557', floors: 1, floor: window.floor! + 1 })
    ]);
    expect(window.cells.some((cell) => cell.id === '8/557')).toBe(false);
    const above = maps.window({ kind: 'room', map: 8, room: 557, half: 3 }, () => null);
    expect(above.floor).toBe(window.floor! + 1);
    expect([above.centre!.gx, above.centre!.gy]).toEqual([window.centre!.gx, window.centre!.gy]);
  });

  it('looks around a point once the map is dragged, with no centre room', () => {
    const at = maps.window({ kind: 'room', map: 1, room: 1, half: 4 }, () => null).centre!;
    const window = maps.window(
      { kind: 'point', map: 1, floor: 0, gx: at.gx + 3, gy: at.gy, half: 4 },
      () => null
    );
    expect(window.centre).toBeNull();
    expect(window.box.x0).toBe(at.gx - 1);
  });

  it('takes the motif a name suggests where no pack claims the room', () => {
    const bare = new GameMaps(graph, NO_THEME_PACK);
    const window = bare.window({ kind: 'room', map: 1, room: 1, half: 6 }, () => null);
    expect(window.areas.every((area) => !area.named)).toBe(true);
    expect(window.labels.every((label) => label.kind !== 'area')).toBe(true);
  });

  it('answers a full window quickly once the map is laid out', () => {
    maps.window({ kind: 'room', map: 14, room: 1, half: 40 }, () => null);
    const started = performance.now();
    maps.window({ kind: 'room', map: 1, room: 1, half: 40 }, () => null);
    const took = performance.now() - started;
    expect(took).toBeLessThan(250);
  });
});
