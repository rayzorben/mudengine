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
    expect(plane.at.get('1/4')).toEqual({ gx: 1, gy: 1, z: 0 });
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
    expect(plane.at.get('1/7')).toEqual({ gx: 1, gy: -1, z: 0 });
    expect(plane.island.get('1/8')).not.toBe(plane.island.get('1/1'));
    // Pushed out east of 6, past the cell of air around the first island.
    expect(plane.at.get('1/8')).toEqual({ gx: 3, gy: -1, z: 0 });
    expect(plane.cells.size).toBe(5);
  });

  it("sets the floor above on the stairs' own cell, one floor up", () => {
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
      [
        5,
        'landing',
        [
          ['d', 2],
          ['e', 6]
        ]
      ],
      [6, 'hall', [['w', 5]]]
    ]);
    const plane = layOutMap(g, 1, g.rooms);
    expect(plane.at.get('1/5')).toEqual({ gx: 1, gy: 0, z: 1 });
    expect(plane.at.get('1/6')).toEqual({ gx: 2, gy: 0, z: 1 });
    expect(plane.island.get('1/5')).not.toBe(plane.island.get('1/2'));
    expect(plane.stairs.get('1/2')).toEqual([
      { direction: 'u', to: '1/5', name: 'landing', floor: 1, floors: 1 }
    ]);
    // The unjoined pair stands well apart from both.
    expect(plane.at.get('1/3')!.gx).toBeGreaterThanOrEqual(2 + UNJOINED_GAP);
  });

  it("pushes a floor east of its stairs when the stairs' cell is taken there", () => {
    // 3, on the floor above, already holds the cell over 2 when 2's stairs are reached.
    const g = graphOf([
      [
        1,
        'a',
        [
          ['u', 3],
          ['e', 2]
        ]
      ],
      [
        2,
        'stairs',
        [
          ['w', 1],
          ['u', 4]
        ]
      ],
      [
        3,
        'up a',
        [
          ['d', 1],
          ['e', 5]
        ]
      ],
      [4, 'up b', [['d', 2]]],
      [5, 'up c', [['w', 3]]]
    ]);
    const plane = layOutMap(g, 1, g.rooms);
    expect(plane.at.get('1/5')).toEqual({ gx: 1, gy: 0, z: 1 });
    const four = plane.at.get('1/4')!;
    expect(four.z).toBe(1);
    expect(four.gx).toBeGreaterThan(1);
  });

  it('follows a climb of one-room floors to where it ends, with its count', () => {
    const g = graphOf([
      [
        1,
        'top',
        [
          ['e', 2],
          ['d', 3]
        ]
      ],
      [2, 'beside', [['w', 1]]],
      [
        3,
        'ramp',
        [
          ['u', 1],
          ['d', 4]
        ]
      ],
      [
        4,
        'ramp',
        [
          ['u', 3],
          ['d', 5]
        ]
      ],
      [
        5,
        'bottom',
        [
          ['u', 4],
          ['e', 6]
        ]
      ],
      [6, 'tunnel', [['w', 5]]]
    ]);
    const plane = layOutMap(g, 1, g.rooms);
    expect(plane.stairs.get('1/1')).toEqual([
      { direction: 'd', to: '1/5', name: 'bottom', floor: -3, floors: 3 }
    ]);
    expect(plane.stairs.get('1/5')).toEqual([
      { direction: 'u', to: '1/1', name: 'top', floor: 0, floors: 3 }
    ]);
  });

  it('marks stairs that reach a floor the count does not expect', () => {
    // 3 is up from 1; 2, beside 1, has stairs down that land in 3 as well.
    const g = graphOf([
      [
        1,
        'a',
        [
          ['e', 2],
          ['u', 3]
        ]
      ],
      [
        2,
        'b',
        [
          ['w', 1],
          ['d', 3]
        ]
      ],
      [
        3,
        'c',
        [
          ['d', 1],
          ['u', 2],
          ['e', 4]
        ]
      ],
      [4, 'd', [['w', 3]]]
    ]);
    const plane = layOutMap(g, 1, g.rooms);
    expect(plane.stairs.get('1/1')![0]!.odd).toBeUndefined();
    expect(plane.stairs.get('1/2')).toEqual([
      { direction: 'd', to: '1/3', name: 'c', floor: 1, floors: 1, odd: true }
    ]);
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
    expect(plane.at.get('1/2')).toEqual({ gx: 1, gy: 0, z: 0 });
    expect(plane.island.get('1/2')).toBe(plane.island.get('1/1'));
    // East of 1, past 2.
    expect(plane.at.get('1/3')).toEqual({ gx: 3, gy: 0, z: 0 });
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
  const graph = WorldGraph.load(world);
  it('place every room of every map, one to a cell', () => {
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

  const layouts = new RealmLayouts(graph);

  it("set the floor up the Spiral Stairway on the stairs' own cell", () => {
    const plane = layouts.of(8);
    const stairs = plane.at.get('8/555')!;
    const landing = plane.at.get('8/557')!;
    expect([landing.gx, landing.gy, landing.z]).toEqual([stairs.gx, stairs.gy, stairs.z + 1]);
    // Its way south is one-way into the tower hallway, and is still its neighbour.
    const hallway = plane.at.get('8/554')!;
    expect([hallway.gx, hallway.gy, hallway.z]).toEqual([stairs.gx, stairs.gy + 1, stairs.z]);
  });

  it("take the Mithril Mine's cart ramp as one stair to the room at its foot", () => {
    const plane = layouts.of(6);
    const down = plane.stairs.get('6/1617')!.find((stair) => stair.direction === 'd')!;
    expect(down.floors).toBeGreaterThan(8);
    expect(plane.stairs.get(down.to)!.find((stair) => stair.direction === 'u')!.to).toBe('6/1617');
  });

  it("put up and down on the stairs' own cell for most stairs", () => {
    let stairs = 0;
    let aligned = 0;
    for (const map of new Set([...graph.everyRoom()].map((r) => r.map))) {
      const plane = layouts.of(map);
      for (const [from, list] of plane.stairs)
        for (const stair of list) {
          if (stair.floors !== 1 || stair.floor === null) continue;
          stairs += 1;
          const a = plane.at.get(from)!;
          const b = plane.at.get(stair.to)!;
          if (a.gx === b.gx && a.gy === b.gy) aligned += 1;
        }
    }
    expect(aligned / stairs).toBeGreaterThan(0.8);
  });
});
