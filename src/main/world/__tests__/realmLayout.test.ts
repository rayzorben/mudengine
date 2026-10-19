import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { roomId, type Direction, type WorldRoom } from '../../../shared/world';
import { planeSteps } from '../planeSteps';
import { layOutMap, RealmLayouts, UNJOINED_GAP } from '../realmLayout';
import { WorldGraph } from '../WorldGraph';
import { timedAgainstReference } from './referenceWork';

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
  const into = new Set(
    [...byId.values()].flatMap((room) => room.exits.map((exit) => roomId(exit.map, exit.room)))
  );
  return {
    byId: (id: string) => byId.get(id),
    beyond: (exit: { map: number; room: number }) => roomId(exit.map, exit.room),
    portalsFrom: () => [],
    hasWayIn: (id: string) => into.has(id),
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
        // 2 leads west into 1; 1 lists no way back, and 4 is the way into 2.
        [2, 'b', [['w', 1]]],
        [3, 'landing', []],
        [4, 'd', [['s', 2]]]
      ]),
      hasWayIn: (id: string) => id !== '1/4',
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

describe("a map's floors", () => {
  it('keeps a street on one floor when a drop from below lands at its end first', () => {
    // A street 1-2-3-4 and a cellar under its gate that drops one way onto its far end.
    const g = graphOf([
      [
        1,
        'gate',
        [
          ['e', 2],
          ['d', 5]
        ]
      ],
      [
        2,
        'street',
        [
          ['w', 1],
          ['e', 3]
        ]
      ],
      [
        3,
        'street',
        [
          ['w', 2],
          ['s', 4]
        ]
      ],
      [4, 'street', [['n', 3]]],
      [
        5,
        'cellar',
        [
          ['u', 1],
          ['d', 4]
        ]
      ]
    ]);
    const plane = layOutMap(g, 1, g.rooms);
    expect(['1/1', '1/2', '1/3', '1/4'].map((id) => plane.at.get(id)!.z)).toEqual([0, 0, 0, 0]);
    expect(plane.at.get('1/5')!.z).toBe(-1);
    // Counted against the street, the drop is the stair that disagrees.
    expect(plane.stairs.get('1/5')!.find((stair) => stair.direction === 'd')!.odd).toBe(true);
  });

  it('never sets a room nothing leads into beside the room it leads to', () => {
    const g = graphOf([
      [1, 'Town Gates', [['n', 2]]],
      [2, 'Silver Street', [['s', 1]]],
      [3, 'Town Gates', [['nw', 1]]]
    ]);
    const plane = layOutMap(g, 1, g.rooms);
    const gate = plane.at.get('1/1')!;
    const namesake = plane.at.get('1/3')!;
    expect(namesake.gx - gate.gx).toBeGreaterThanOrEqual(UNJOINED_GAP);
    expect(plane.island.get('1/3')).not.toBe(plane.island.get('1/1'));
  });
});

const world = path.resolve('resources/world/paradigm.jsonl.gz');

describe.runIf(fs.existsSync(world))("Paradigm's planes", () => {
  const graph = WorldGraph.load(world);
  it('place every room of every map, one to a cell', () => {
    const layouts = new RealmLayouts(graph);
    const maps = new Set([...graph.everyRoom()].map((r) => r.map));
    let rooms = 0;
    const { tookMs, referenceMs } = timedAgainstReference(() => {
      for (const map of maps) {
        const plane = layouts.of(map);
        expect(plane.cells.size).toBe(plane.at.size);
        expect(plane.at.size).toBe(layouts.roomsOf(map).length);
        rooms += plane.at.size;
      }
    });
    expect(rooms).toBe([...graph.everyRoom()].length);
    // Laid out on first ask, on the main thread. 2026-10-19: 48 to 57 reference jobs alone (HEAD
    // before the two-way floors measured the same), 85 to 116 with the world tests in parallel
    // beside it, so 160. A layout gone quadratic is tens of times that.
    expect(tookMs).toBeLessThan(160 * referenceMs);
  });

  const layouts = new RealmLayouts(graph);

  it("set the floor up the Homely Hearth's stairwell on the stairs' own cell", () => {
    const plane = layouts.of(1);
    const stairs = plane.at.get('1/313')!;
    const landing = plane.at.get('1/847')!;
    expect([landing.gx, landing.gy, landing.z]).toEqual([stairs.gx, stairs.gy, stairs.z + 1]);
    // Map 8's Spiral Stairway is a copy nothing leads into (the stair walked is 1/37), so it
    // stands off the tower hallway its way south reaches.
    expect(plane.at.has('8/555')).toBe(false);
    const copy = layouts.of(8).at.get('8/555')!;
    const hallway = layouts.of(8).at.get('8/554')!;
    expect(Math.abs(copy.gx - hallway.gx) + Math.abs(copy.gy - hallway.gy)).toBeGreaterThan(1);
  });

  it("take the Mithril Mine's cart ramp as one stair to the room at its foot", () => {
    const plane = layouts.of(6);
    const down = plane.stairs.get('6/1617')!.find((stair) => stair.direction === 'd')!;
    expect(down.floors).toBeGreaterThan(8);
    expect(plane.stairs.get(down.to)!.find((stair) => stair.direction === 'u')!.to).toBe('6/1617');
  });

  it("draw Town Square's way south as one step south on its own floor", () => {
    const plane = layouts.of(1);
    const square = plane.at.get('1/224')!;
    const sovereign = plane.at.get('1/225')!;
    expect([sovereign.gx, sovereign.gy, sovereign.z]).toEqual([square.gx, square.gy + 1, square.z]);
    // The doubled Town Gates nothing leads into stands off the streets.
    const gates = plane.at.get('1/1')!;
    const namesake = plane.at.get('1/1315')!;
    expect(Math.abs(namesake.gx - gates.gx)).toBeGreaterThan(1);
  });

  it('put both ends of every two-way compass exit on one floor', () => {
    let pairs = 0;
    const split: string[] = [];
    for (const room of graph.everyRoom()) {
      const plane = layouts.of(room.map);
      const here = roomId(room.map, room.room);
      for (const step of planeSteps(graph, room)) {
        if (step.destination.map !== room.map) continue;
        if (![...planeSteps(graph, step.destination)].some((back) => back.to === here)) continue;
        pairs += 1;
        if (plane.at.get(here)!.z !== plane.at.get(step.to)!.z) split.push(`${here} ${step.to}`);
      }
    }
    expect(pairs).toBeGreaterThan(100_000);
    expect(split).toEqual([]);
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
