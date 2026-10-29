import { describe, expect, it } from 'vitest';

import { Marks } from '../Marks';
import { MarkBook } from '../MarkBook';
import type { Block } from '../../../shared/blocks';
import { lineIdOf } from '../../../shared/stamps';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { MarkChange } from '../../../shared/types';
import type { WorldRoom } from '../../../shared/world';

/*
 * Todo 143: only the room the character stands in has live buttons. The world
 * is a stub: rooms by number, a Sewer Grate whose only way on is `go manhole`.
 */
const GRATE = { map: 1, number: 10, name: 'Sewer Grate', commands: ['go manhole'] };
const NEXT_GRATE = { map: 1, number: 11, name: 'Sewer Grate', commands: ['go manhole'] };
const ROAD = { map: 1, number: 20, name: 'North Road', commands: [] as string[] };
/** Namesakes that disagree: only the first has a lever. */
const DRAIN = { map: 1, number: 30, name: 'Drain', commands: ['pull lever'] };
const NEXT_DRAIN = { map: 1, number: 31, name: 'Drain', commands: [] as string[] };
type StubRoom = typeof GRATE;
const ROOMS = [GRATE, NEXT_GRATE, ROAD, DRAIN, NEXT_DRAIN];
const room = (stub: StubRoom): WorldRoom => stub as unknown as WorldRoom;

function harness() {
  const pushed: MarkChange[][] = [];
  const book = new MarkBook({ lines: 100, changed: (changes) => pushed.push(changes) });
  let peek = false;
  /** Rooms the next name line can be: both grates by name alone. */
  const tracker = {
    current: EMPTY_CHARACTER as CharacterState,
    get nextRoomIsPeek() {
      return peek;
    },
    roomsNameCanBe: (name: string) => ROOMS.filter((r) => r.name === name).map(room)
  };
  const world = {
    placeAmong: () => undefined,
    roomCommandsAmong: (rooms: readonly WorldRoom[]) => {
      const lists = rooms.map((r) => (r as unknown as StubRoom).commands.join('|'));
      return lists.length > 0 && lists.every((l) => l === lists[0])
        ? (rooms[0] as unknown as StubRoom).commands
        : undefined;
    },
    get: (map: number, number: number) => {
      const found = ROOMS.find((r) => r.map === map && r.number === number);
      return found ? room(found) : undefined;
    }
  };
  const marks = new Marks({ tracker, world, book }, { enrich: () => true });
  const nameLine = (name: string): string => {
    const id = marks.markFor({ type: 'room-name', text: name } as Block);
    if (id === undefined) throw new Error('no id');
    book.painted([id]);
    return id;
  };
  const standIn = (stub: StubRoom): void => {
    const state: CharacterState = {
      ...EMPTY_CHARACTER,
      room: { ...EMPTY_CHARACTER.room, name: stub.name, map: stub.map, number: stub.number }
    };
    tracker.current = state;
    marks.onCharacter(state);
  };
  /** The line's own `Obvious exits:`: until it is read, a placement is the room before. */
  const exits = (): void => {
    marks.markFor({ type: 'room-exits', text: 'Obvious exits: north' } as Block);
  };
  const buttons = (id: string): string[] =>
    (book.painted([id])[0]?.mark?.actions ?? []).map((action) => action.label);
  return {
    marks,
    book,
    pushed,
    nameLine,
    standIn,
    exits,
    buttons,
    peekNext: () => (peek = true)
  };
}

describe('the buttons beside a room name', () => {
  it('are on the room stood in, and come off when the character walks on', () => {
    const h = harness();
    const grate = h.nameLine('Sewer Grate');
    h.standIn(GRATE);
    // The positive control: the room that has a command has its button.
    expect(h.buttons(grate)).toEqual(['go manhole']);
    const road = h.nameLine('North Road');
    expect(h.buttons(grate)).toEqual([]);
    h.standIn(ROAD);
    expect(h.buttons(road)).toEqual([]);
    // The buttons come off; the room it was printed for stays, for a click in the backscroll.
    expect(h.pushed).toContainEqual([
      { id: grate, mark: { label: 'Sewer Grate', room: { map: 1, room: 10 } } }
    ]);
  });

  it('come from the placed room once its exits are read', () => {
    const h = harness();
    // The name alone is two rooms that agree on the command; placed, it is one.
    const grate = h.nameLine('Sewer Grate');
    h.standIn(NEXT_GRATE);
    expect(h.buttons(grate)).toEqual(['go manhole']);
    // The one push is the room placed; the buttons were already right.
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]![0]!.mark?.room).toEqual({ map: 1, room: 11 });
  });

  it('come off a room left without a name line printed', () => {
    const h = harness();
    const grate = h.nameLine('Sewer Grate');
    h.standIn(GRATE);
    expect(h.buttons(grate)).toEqual(['go manhole']);
    h.standIn(ROAD);
    expect(h.buttons(grate)).toEqual([]);
  });

  it("are not the room before's while a namesake's exits are still to come", () => {
    const h = harness();
    const first = h.nameLine('Drain');
    h.standIn(DRAIN);
    expect(h.buttons(first)).toEqual(['pull lever']);
    const next = h.nameLine('Drain');
    // The name alone is two rooms that disagree, so the new line has no button yet.
    expect(h.buttons(next)).toEqual([]);
    h.standIn(DRAIN);
    expect(h.buttons(next)).toEqual([]);
    h.standIn(NEXT_DRAIN);
    expect(h.buttons(next)).toEqual([]);
  });

  it('come off a room looked at again and then left without a name line', () => {
    const h = harness();
    h.nameLine('Sewer Grate');
    h.standIn(GRATE);
    // A look in the room stood in: its line has the button.
    const look = h.nameLine('Sewer Grate');
    h.standIn(GRATE);
    expect(h.buttons(look)).toEqual(['go manhole']);
    h.standIn(ROAD);
    expect(h.buttons(look)).toEqual([]);
  });

  it('are never on a peeked room, and a peek leaves the room stood in live', () => {
    const h = harness();
    const grate = h.nameLine('Sewer Grate');
    h.standIn(GRATE);
    h.peekNext();
    const peeked = h.nameLine('Sewer Grate');
    expect(h.buttons(peeked)).toEqual([]);
    expect(h.buttons(grate)).toEqual(['go manhole']);
  });
});

describe('the room a name line was printed for', () => {
  const roomOf = (h: ReturnType<typeof harness>, id: string) =>
    h.book.pageOf({ text: lineIdOf(id), older: 0 }).marks[0]?.mark?.room;

  it('is on the line once the character is placed, and stays after walking on', () => {
    const h = harness();
    const first = h.nameLine('Sewer Grate');
    // Two rooms share the name: nothing is chosen before the exits are read.
    expect(roomOf(h, first)).toBeUndefined();
    h.standIn(NEXT_GRATE);
    expect(roomOf(h, first)).toEqual({ map: 1, room: 11 });
    h.nameLine('North Road');
    h.standIn(ROAD);
    expect(roomOf(h, first)).toEqual({ map: 1, room: 11 });
  });

  it('is on a plain room with no glyph or buttons', () => {
    const h = harness();
    const road = h.nameLine('North Road');
    h.standIn(ROAD);
    expect(roomOf(h, road)).toEqual({ map: 1, room: 20 });
  });

  it('is on a room looked at again where the character already stood', () => {
    const h = harness();
    h.nameLine('Drain');
    h.standIn(NEXT_DRAIN);
    const again = h.nameLine('Drain');
    h.standIn(NEXT_DRAIN);
    // Before its exits, the line could be the namesake next door.
    expect(roomOf(h, again)).toBeUndefined();
    h.exits();
    h.standIn(NEXT_DRAIN);
    expect(roomOf(h, again)).toEqual({ map: 1, room: 31 });
  });

  it("is never the room before's on a namesake whose exits leave it ambiguous", () => {
    const h = harness();
    const first = h.nameLine('Drain');
    h.standIn(DRAIN);
    // The positive control: the first line has its room.
    expect(roomOf(h, first)).toEqual({ map: 1, room: 30 });
    const next = h.nameLine('Drain');
    // A publish between the name and the exits still stands in the room before.
    h.standIn(DRAIN);
    h.exits();
    h.standIn({ ...DRAIN, number: null as unknown as number, map: null as unknown as number });
    expect(roomOf(h, next)).toBeUndefined();
  });

  it('is not given by the exits of a peeked room', () => {
    const h = harness();
    h.nameLine('Drain');
    h.standIn(DRAIN);
    const again = h.nameLine('Drain');
    h.peekNext();
    h.nameLine('North Road');
    h.exits();
    h.standIn(DRAIN);
    expect(roomOf(h, again)).toBeUndefined();
  });

  it('is never on a line printed while the character was not placed', () => {
    const h = harness();
    const lost = h.nameLine('Sewer Grate');
    const road = h.nameLine('North Road');
    h.standIn(ROAD);
    // The positive control: the placement reached the line printed for it.
    expect(roomOf(h, road)).toEqual({ map: 1, room: 20 });
    expect(roomOf(h, lost)).toBeUndefined();
  });

  it('is never on a peeked room', () => {
    const h = harness();
    h.nameLine('North Road');
    h.standIn(ROAD);
    h.peekNext();
    const peeked = h.nameLine('Sewer Grate');
    h.standIn(ROAD);
    expect(roomOf(h, peeked)).toBeUndefined();
  });
});
