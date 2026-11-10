import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { WorldGraph } from '../WorldGraph';
import { resolveRoom, type ChainInput, type Resolution } from '../resolve';
import { roomId, type Direction, type RoomId, type WorldRoom } from '../../../shared/world';

const file = path.resolve('resources/world/paradigm.jsonl.gz');
const available = fs.existsSync(file);
const graph = available ? WorldGraph.load(file) : null;

const id = (room: WorldRoom): RoomId => roomId(room.map, room.room);
/** What the server prints for a room with its hidden exits shut. */
const printed = (room: WorldRoom): Direction[] =>
  room.exits
    .filter((exit) => exit.requirement?.kind !== 'text' && exit.requirement?.kind !== 'hidden')
    .map((exit) => exit.direction);
const carried = (located: Resolution, stayed = false): ChainInput => ({
  rooms: located.candidates.map(id),
  drawn: located.drawn ?? [],
  stayed
});

/*
 * Against the shipped realm, as `resolve.test.ts` is: how far a chain narrows
 * is a fact about how the realm repeats its names.
 */
describe.runIf(available)('a chain of unplaced rooms', () => {
  /*
   * Every 40th room, entered with no location, then three steps through plain
   * exits. The room really stood in is never ruled out, and the walk places
   * most of what the first block could not (the shares over every room are in
   * `mudengine-wire` › `parts/room.md`).
   */
  it('never rules out the room stood in, and places most starts in three moves', () => {
    const rooms = [...graph!.everyRoom()].filter((_, index) => index % 40 === 0);
    let atOnce = 0;
    let afterThree = 0;
    for (const start of rooms) {
      let truth = start;
      let before: RoomId | null = null;
      let located = resolveRoom(graph!, { name: truth.name, exits: printed(truth) });
      if (located.room) atOnce += 1;
      for (let step = 0; step < 3 && !located.room; step += 1) {
        const ways = truth.exits.filter(
          (exit) => exit.requirement === null && graph!.get(exit.map, exit.room)
        );
        const exit = ways.find((way) => roomId(way.map, way.room) !== before) ?? ways[0];
        if (!exit) break;
        before = id(truth);
        truth = graph!.get(exit.map, exit.room)!;
        located = resolveRoom(graph!, {
          name: truth.name,
          exits: printed(truth),
          moved: exit.direction,
          chain: carried(located)
        });
        expect(located.candidates.map(id), `${id(start)} step ${step}`).toContain(id(truth));
      }
      if (located.room) {
        expect(id(located.room)).toBe(id(truth));
        afterThree += 1;
      }
    }
    expect(atOnce / rooms.length).toBeLessThan(0.3);
    expect(afterThree / rooms.length).toBeGreaterThan(0.65);
  });

  // 1/550, 1/558 and 1/560 are among the Sewer Tunnels that print `s, e`.
  const tunnels = (): Resolution =>
    resolveRoom(graph!, { name: 'Sewer Tunnel', exits: ['s', 'e'] });

  it('keeps the set on a reprint and widens it one step on an arrival nothing sent', () => {
    const first = tunnels();
    expect(first.room).toBeNull();
    const again = resolveRoom(graph!, {
      name: 'Sewer Tunnel',
      exits: ['s', 'e'],
      chain: carried(first, true)
    });
    expect(again.method).toBe('chain');
    expect(again.candidates.map(id)).toEqual(first.candidates.map(id));

    const one = first.candidates[0]!;
    const next = graph!.get(one.exits[0]!.map, one.exits[0]!.room)!;
    const moved = resolveRoom(graph!, {
      name: next.name,
      exits: printed(next),
      chain: carried(first)
    });
    expect(moved.method).toBe('chain');
    expect(moved.candidates.map(id)).toContain(id(next));
  });

  it('starts again from the name when no room the set reaches fits the block', () => {
    const first = tunnels();
    const elsewhere = resolveRoom(graph!, {
      name: 'Bank of Godfrey',
      exits: ['n', 'e', 'w'],
      moved: 's',
      chain: carried(first)
    });
    expect(elsewhere.method).toBe('unique-name');
    expect(elsewhere.room && id(elsewhere.room)).toBe('1/297');
  });

  it('is not asked while a room is known to step from', () => {
    const first = tunnels();
    const stepped = resolveRoom(graph!, {
      name: 'Sewer Tunnel',
      exits: ['s', 'e'],
      previous: '1/549',
      chain: carried(first)
    });
    expect(stepped.method).not.toBe('chain');
  });

  /*
   * West out of the Asylum Ward 9/1182 is a cast exit: the block read is the
   * exit table's room 9/1183, which the character passes through, and the
   * spell then lands them in 9/1183 to 9/1206 with no move queued.
   */
  it('places nothing on a step through a cast exit and looks for the landing next', () => {
    const through = graph!.get(9, 1183)!;
    const first = resolveRoom(graph!, {
      name: through.name,
      exits: printed(through),
      moved: 'w',
      chain: { rooms: ['9/1182'], drawn: [], stayed: false }
    });
    expect(first.method).toBe('chain');
    expect(first.room).toBeNull();
    expect(first.candidates.map(id)).toEqual(['9/1183']);
    expect(first.drawn).toContain('9/1188');

    const landed = graph!.get(9, 1188)!;
    const second = resolveRoom(graph!, {
      name: landed.name,
      exits: printed(landed),
      chain: carried(first)
    });
    expect(second.candidates.map(id)).toContain('9/1188');
  });
});
