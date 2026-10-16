import { describe, expect, it } from 'vitest';

import { Marks } from '../Marks';
import { MarkBook } from '../MarkBook';
import type { Block } from '../../../shared/blocks';
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
  const buttons = (id: string): string[] =>
    (book.painted([id])[0]?.mark?.actions ?? []).map((action) => action.label);
  return { marks, book, pushed, nameLine, standIn, buttons, peekNext: () => (peek = true) };
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
    expect(h.pushed.at(-1)).toEqual([{ id: grate, mark: null }]);
  });

  it('come from the placed room once its exits are read', () => {
    const h = harness();
    // The name alone is two rooms that agree on the command; placed, it is one.
    const grate = h.nameLine('Sewer Grate');
    h.standIn(NEXT_GRATE);
    expect(h.buttons(grate)).toEqual(['go manhole']);
    expect(h.pushed).toEqual([]);
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
