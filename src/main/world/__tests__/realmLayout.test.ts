import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { roomId, type Direction, type WorldRoom } from '../../../shared/world';
import { layOutMap, RealmLayouts, UNJOINED_GAP } from '../realmLayout';
import { WorldGraph } from '../WorldGraph';

function graphOf(rooms: Array<[number, string, Array<[Direction, number, number?]>]>) {
  const byId = new Map<string, WorldRoom>();
  for (const [number, name, exits] of rooms)
    byId.set(roomId(1, number), {
      map: 1,
      room: number,
      name,
      exits: exits.map(([direction, to, map]) => ({
        direction,
        map: map ?? 1,
        room: to,
        requirement: null
      }))
    } as WorldRoom);
  return {
    byId: (id: string) => byId.get(id),
    beyond: (exit: { map: number; room: number }) => roomId(exit.map, exit.room),
    portalsFrom: () => [],
    everyRoom: () => byId.values(),
    rooms: [...byId.values()]
  };
}

describe("a map's plane", () => {
  it('lays a square of rooms out as a square', () => {
    const g = graphOf([
      [
        1,
        'a',
        [
          ['e', 2],
          ['s', 3]
        ]
      ],
      [
        2,
        'b',
        [
          ['w', 1],
          ['s', 4]
        ]
      ],
      [
        3,
        'c',
        [
          ['n', 1],
          ['e', 4]
        ]
      ],
      [
        4,
        'd',
        [
          ['n', 2],
          ['w', 3]
        ]
      ]
    ]);
    const plane = layOutMap(g, 1, g.rooms);
    expect(plane.at.get('1/4')).toEqual({ gx: 1, gy: 1 });
    expect(new Set(plane.island.values()).size).toBe(1);
  });

  it('starts an island where two ways reach one cell, and drops nothing', () => {
    // 2's north and 6's east both want the cell at (1, -1); 7 is reached first.
    const g = graphOf([
      [
        1,
        'a',
        [
          ['e', 2],
          ['n', 6]
        ]
      ],
      [
        2,
        'b',
        [
          ['w', 1],
          ['n', 7]
        ]
      ],
      [
        6,
        'f',
        [
          ['s', 1],
          ['e', 8]
        ]
      ],
      [7, 'g', [['s', 2]]],
      [8, 'h', [['w', 6]]]
    ]);
    const plane = layOutMap(g, 1, g.rooms);
    expect(plane.at.get('1/7')).toEqual({ gx: 1, gy: -1 });
    expect(plane.island.get('1/8')).not.toBe(plane.island.get('1/1'));
    // Pushed out east of 6, past the cell of air around the first island.
    expect(plane.at.get('1/8')).toEqual({ gx: 3, gy: -1 });
    expect(plane.cells.size).toBe(5);
  });

  it('sets the floor above down beside its stairs, not in room order', () => {
    // 5 is the floor above 2; 3 and 4 are an unjoined pair numbered between.
    const g = graphOf([
      [1, 'a', [['e', 2]]],
      [
        2,
        'stairs',
        [
          ['w', 1],
          ['u', 5]
        ]
      ],
      [3, 'c', [['e', 4]]],
      [4, 'd', [['w', 3]]],
      [5, 'landing', [['d', 2]]]
    ]);
    const plane = layOutMap(g, 1, g.rooms);
    // North-east of the stairs, two cells out.
    expect(plane.at.get('1/5')).toEqual({ gx: 3, gy: -2 });
    expect(plane.island.get('1/5')).not.toBe(plane.island.get('1/2'));
    // The unjoined pair stands well apart from both.
    expect(plane.at.get('1/3')!.gx).toBeGreaterThanOrEqual(3 + UNJOINED_GAP);
  });

  it("joins a room's teleport and an exit only one end lists", () => {
    const g = {
      ...graphOf([
        [1, 'a', []],
        // 2 leads west into 1; 1 lists no way back.
        [2, 'b', [['w', 1]]],
        [3, 'landing', []]
      ]),
      portalsFrom: (id: string) =>
        id === '1/1'
          ? [
              {
                direction: 'portal' as const,
                map: 1,
                room: 3,
                requirement: { kind: 'text' as const, raw: 'go path' }
              }
            ]
          : []
    };
    const plane = layOutMap(g, 1, g.rooms);
    expect(plane.at.get('1/2')).toEqual({ gx: 1, gy: 0 });
    expect(plane.island.get('1/2')).toBe(plane.island.get('1/1'));
    // East of 1, past 2.
    expect(plane.at.get('1/3')).toEqual({ gx: 3, gy: 0 });
  });

  it('follows no exit onto another map', () => {
    const g = graphOf([
      [
        1,
        'a',
        [
          ['e', 2],
          ['w', 9, 2]
        ]
      ],
      [2, 'b', [['w', 1]]]
    ]);
    const plane = layOutMap(g, 1, g.rooms);
    expect([...plane.at.keys()].sort()).toEqual(['1/1', '1/2']);
  });
});

const world = path.resolve('resources/world/paradigm.jsonl.gz');

describe.runIf(fs.existsSync(world))("Paradigm's planes", () => {
  it('place every room of every map, one to a cell', () => {
    const graph = WorldGraph.load(world);
    const layouts = new RealmLayouts(graph);
    const maps = new Set([...graph.everyRoom()].map((r) => r.map));
    const started = performance.now();
    let rooms = 0;
    for (const map of maps) {
      const plane = layouts.of(map);
      expect(plane.cells.size).toBe(plane.at.size);
      expect(plane.at.size).toBe(layouts.roomsOf(map).length);
      rooms += plane.at.size;
    }
    expect(rooms).toBe([...graph.everyRoom()].length);
    // Laid out on first ask, on the main thread: it must stay well under a second.
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
