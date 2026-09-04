import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { WorldGraph } from '../WorldGraph';
import { localMap } from '../localMap';
import { layoutMap } from '../../../shared/map';

function makeWorld(rooms: Array<Record<string, unknown>>): WorldGraph {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-map-'));
  const file = path.join(dir, 'rooms.jsonl.gz');
  const header = JSON.stringify({ v: 1, source: 'test', rooms: rooms.length, generatedAt: 'x' });
  fs.writeFileSync(
    file,
    zlib.gzipSync([header, ...rooms.map((r) => JSON.stringify(r))].join('\n') + '\n')
  );
  const graph = WorldGraph.load(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return graph;
}

/** Where the map put a room, or undefined if it did not place it. */
const at = (map: ReturnType<typeof localMap>, id: string) =>
  map.cells.find((cell) => cell.id === id);

describe('laying out a local map', () => {
  it('puts the character at the origin', () => {
    const graph = makeWorld([{ m: 1, r: 1, n: 'Here', x: {} }]);
    const map = localMap(graph, '1/1');
    expect(map.centre).toBe('1/1');
    expect(at(map, '1/1')).toMatchObject({ gx: 0, gy: 0 });
  });

  it('walks each direction the way a compass does', () => {
    const graph = makeWorld([
      {
        m: 1,
        r: 1,
        n: 'Middle',
        x: {
          n: { m: 1, r: 2 },
          s: { m: 1, r: 3 },
          e: { m: 1, r: 4 },
          w: { m: 1, r: 5 },
          ne: { m: 1, r: 6 },
          sw: { m: 1, r: 7 }
        }
      },
      { m: 1, r: 2, n: 'North', x: {} },
      { m: 1, r: 3, n: 'South', x: {} },
      { m: 1, r: 4, n: 'East', x: {} },
      { m: 1, r: 5, n: 'West', x: {} },
      { m: 1, r: 6, n: 'Northeast', x: {} },
      { m: 1, r: 7, n: 'Southwest', x: {} }
    ]);
    const map = localMap(graph, '1/1');
    // North is *up* the screen, which is why gy decreases.
    expect(at(map, '1/2')).toMatchObject({ gx: 0, gy: -1 });
    expect(at(map, '1/3')).toMatchObject({ gx: 0, gy: 1 });
    expect(at(map, '1/4')).toMatchObject({ gx: 1, gy: 0 });
    expect(at(map, '1/5')).toMatchObject({ gx: -1, gy: 0 });
    expect(at(map, '1/6')).toMatchObject({ gx: 1, gy: -1 });
    expect(at(map, '1/7')).toMatchObject({ gx: -1, gy: 1 });
  });

  it('does not place what is up or down, and marks the room instead', () => {
    // A map that put a staircase on the plane would draw two different rooms in
    // one square and call it a floor plan.
    const graph = makeWorld([
      { m: 1, r: 1, n: 'Stairwell', x: { u: { m: 1, r: 2 }, d: { m: 1, r: 3 } } },
      { m: 1, r: 2, n: 'Above', x: {} },
      { m: 1, r: 3, n: 'Below', x: {} }
    ]);
    const map = localMap(graph, '1/1');
    expect(map.cells).toHaveLength(1);
    // And says which way, not merely that it goes somewhere: a room with only
    // a way down drawn with an arrow pointing up is a map stating the opposite
    // of the truth.
    expect(at(map, '1/1')?.vertical).toBe('both');
  });

  it('tells a way down from a way up', () => {
    const graph = makeWorld([
      { m: 1, r: 1, n: 'Cellar Steps', x: { d: { m: 1, r: 2 } } },
      { m: 1, r: 2, n: 'Cellar', x: {} }
    ]);
    expect(at(localMap(graph, '1/1'), '1/1')?.vertical).toBe('down');
  });

  it('leaves a room with no stairs unmarked', () => {
    const graph = makeWorld([
      { m: 1, r: 1, n: 'Street', x: { n: { m: 1, r: 2 } } },
      { m: 1, r: 2, n: 'Street', x: {} }
    ]);
    expect(at(localMap(graph, '1/1'), '1/1')?.vertical).toBeNull();
  });

  it('gives a contested square to the nearer room, and says one was dropped', () => {
    /*
     * A MUD is not Euclidean. Here east-then-north and north-then-east lead to
     * different rooms, which cannot both be northeast of the centre. The nearer
     * claim is arbitrary but *stable*, and the count is reported rather than the
     * conflict being drawn as though it were not there.
     */
    const graph = makeWorld([
      { m: 1, r: 1, n: 'Centre', x: { e: { m: 1, r: 2 }, n: { m: 1, r: 3 } } },
      { m: 1, r: 2, n: 'East', x: { n: { m: 1, r: 4 } } },
      { m: 1, r: 3, n: 'North', x: { e: { m: 1, r: 5 } } },
      { m: 1, r: 4, n: 'Corner A', x: {} },
      { m: 1, r: 5, n: 'Corner B', x: {} }
    ]);
    const map = localMap(graph, '1/1');
    const corners = [at(map, '1/4'), at(map, '1/5')].filter(Boolean);
    expect(corners).toHaveLength(1);
    expect(map.dropped).toBe(1);
  });

  it('stops at the radius', () => {
    const corridor = Array.from({ length: 12 }, (_, i) => ({
      m: 1,
      r: i + 1,
      n: `Room ${i + 1}`,
      x: i + 1 < 12 ? { e: { m: 1, r: i + 2 } } : {}
    }));
    const map = localMap(makeWorld(corridor), '1/1', 3);
    expect(map.cells).toHaveLength(4); // the centre plus three steps
    expect(at(map, '1/5')).toBeUndefined();
  });

  it('returns nothing for a room the realm does not have', () => {
    expect(localMap(makeWorld([{ m: 1, r: 1, n: 'Here', x: {} }]), '9/9')).toMatchObject({
      centre: null,
      cells: []
    });
  });

  it('carries what the card needs to draw a room', () => {
    const graph = makeWorld([
      // `s` and `lair` are the field names `build-world.mjs` actually writes.
      { m: 1, r: 1, n: 'Shop', x: { e: { m: 1, r: 2 } }, s: 4 },
      { m: 1, r: 2, n: 'Den', x: {}, lair: '(Max 2): 781,' }
    ]);
    const map = localMap(graph, '1/1');
    expect(at(map, '1/1')).toMatchObject({ shop: true, name: 'Shop' });
    expect(at(map, '1/2')).toMatchObject({ lair: true });
  });
});

describe('against the shipped realm data', () => {
  const REALM = path.resolve('resources/world/rooms.jsonl.gz');
  const realm = fs.existsSync(REALM) ? WorldGraph.load(REALM) : null;

  it.runIf(realm !== null && realm.size > 0)('draws only the agreed vocabulary', () => {
    // The layout and the drawing are separate, and this is the one place they
    // meet real data: a stray character here means a glyph or a link was drawn
    // that nothing defines.
    const drawing = layoutMap(localMap(realm!, '1/2147', 4));
    expect(drawing.nodes.filter((node) => node.here)).toHaveLength(1);
    // Every room the layout placed is findable in the picture.
    expect(drawing.nodes).toHaveLength(localMap(realm!, '1/2147', 4).cells.length);
    // And every link joins two rooms it is actually showing.
    const points = new Set(drawing.nodes.map((node) => `${node.x},${node.y}`));
    for (const link of drawing.links) {
      expect(points.has(`${link.x1},${link.y1}`)).toBe(true);
      expect(points.has(`${link.x2},${link.y2}`)).toBe(true);
    }
  });

  it.runIf(realm !== null && realm.size > 0)('maps the streets around Newhaven', () => {
    // The Adventurer's Guild, where a fresh character starts. A synthetic graph
    // proves the algorithm; this proves it survives real exits.
    const map = localMap(realm!, '1/2147', 4);
    expect(map.centre).toBe('1/2147');
    expect(map.cells.length).toBeGreaterThan(3);
    expect(at(map, '1/2147')).toMatchObject({ gx: 0, gy: 0 });
    // Every placed room occupies its own square.
    const squares = new Set(map.cells.map((cell) => `${cell.gx},${cell.gy}`));
    expect(squares.size).toBe(map.cells.length);
  });

  it.runIf(realm !== null && realm.size > 0)(
    'says what stands in the way, and what would get you through',
    () => {
      /*
       * The whole chain in one assertion: the realm database named the item at
       * build time, the graph kept the index, and the map turned `Key: 1124`
       * into something a player can act on. A key number is not actionable;
       * "jail key, dropped by Sheriff Lionheart" is.
       */
      const map = localMap(realm!, '1/42', 1);
      const cell = map.cells.find((entry) => entry.id === '1/42');
      const door = cell?.blocked?.['s'];

      expect(door?.kind).toBe('key');
      expect(door?.detail).toContain('jail key');
      // Where to get one...
      expect(door?.detail).toContain('Sheriff Lionheart');
      // ...and the way through without it.
      expect(door?.detail).toMatch(/pick\/bash \d+/);
      // The realm's own words survive for anything not modelled.
      expect(door?.raw).toContain('Key:');
      /*
       * And the chip form of the same fact, which is what a route step has
       * room for: the key by name, the way through, and *not* the paragraph
       * about who drops it.
       */
      expect(door?.label).toContain('jail key');
      expect(door?.label).not.toContain('Sheriff Lionheart');
    }
  );

  it.runIf(realm !== null && realm.size > 0)('reads a door with no key as a door', () => {
    const map = localMap(realm!, '1/297', 1);
    const vault = map.cells.find((entry) => entry.id === '1/297')?.blocked?.['w'];
    expect(vault?.kind).toBe('door');
    expect(vault?.detail).toMatch(/pick\/bash \d+/);
  });

  it.runIf(realm !== null && realm.size > 0)(
    'reads an exit that needs a phrase rather than a direction',
    () => {
      // `Text:` exits are commands, not obstacles — the way through is to say
      // the words, and the map should show them rather than a bare wall.
      const map = localMap(realm!, '1/1', 3);
      const spoken = map.cells
        .flatMap((cell) => Object.values(cell.blocked ?? {}))
        .find((block) => block.kind === 'text');
      if (spoken) expect(spoken.detail).toMatch(/^Say: /);
    }
  );
});
