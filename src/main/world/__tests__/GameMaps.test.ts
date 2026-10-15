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

  it('looks around a point once the map is dragged, with no centre room', () => {
    const at = maps.window({ kind: 'room', map: 1, room: 1, half: 4 }, () => null).centre!;
    const window = maps.window(
      { kind: 'point', map: 1, gx: at.gx + 3, gy: at.gy, half: 4 },
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
