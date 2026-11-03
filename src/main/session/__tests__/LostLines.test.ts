import { describe, expect, it } from 'vitest';

import { Marks } from '../Marks';
import { MarkBook } from '../MarkBook';
import type { Expectation } from '../../parse/expectations';
import type { Block } from '../../../shared/blocks';
import { EMPTY_CHARACTER, type CharacterState, type Room } from '../../../shared/character';
import { lineIdOf } from '../../../shared/stamps';
import type { Direction, WorldRoom } from '../../../shared/world';

/*
 * Todo 20261029-1347-01: a room name printed while lost takes its room once a
 * resync places the character. The sewer: two tunnels east to a junction
 * whose name is the realm's only one. The caves: two caves both lead north
 * to the cave mouth, so the mouth cannot say which one was walked out of.
 */
const exit = (direction: Direction, room: number) => ({
  direction,
  map: 1,
  room,
  requirement: null
});
const ROOMS: WorldRoom[] = [
  { map: 1, room: 100, name: 'Sewer Tunnel', exits: [exit('e', 101)] },
  { map: 1, room: 101, name: 'Sewer Tunnel', exits: [exit('w', 100), exit('e', 102)] },
  { map: 1, room: 102, name: 'Sewer Junction', exits: [exit('w', 101)] },
  { map: 1, room: 200, name: 'Sewer Tunnel', exits: [] },
  { map: 1, room: 300, name: 'Dark Cave', exits: [exit('n', 302)] },
  { map: 1, room: 301, name: 'Dark Cave', exits: [exit('n', 302)] },
  { map: 1, room: 302, name: 'Cave Mouth', exits: [] },
  { map: 1, room: 400, name: 'North Road', exits: [exit('e', 401)] },
  { map: 1, room: 401, name: 'Dark Alley', exits: [] }
] as unknown as WorldRoom[];

const step = (direction: Direction): Expectation => ({
  kind: 'move',
  direction,
  command: direction
});

function harness() {
  const book = new MarkBook({ lines: 100 });
  let claim: Expectation | null = null;
  let arrival = 0;
  const tracker = {
    current: EMPTY_CHARACTER as CharacterState,
    get nextRoom() {
      return claim;
    },
    roomsNameCanBe: (name: string) => ROOMS.filter((r) => r.name === name)
  };
  const world = {
    placeAmong: () => undefined,
    roomCommandsAmong: () => undefined,
    findByName: (name: string) => ROOMS.filter((r) => r.name === name),
    get: (map: number, number: number) => ROOMS.find((r) => r.map === map && r.room === number)
  };
  const marks = new Marks({ tracker, world, book }, { enrich: () => true });
  const publish = (room: Partial<Room>): void => {
    const state: CharacterState = {
      ...EMPTY_CHARACTER,
      room: { ...EMPTY_CHARACTER.room, arrival, ...room }
    };
    tracker.current = state;
    marks.onCharacter(state);
  };
  /**
   * A whole room block answering `asked`: its name line, its exits, and the
   * character as the tracker leaves it. A move counts an arrival.
   */
  const block = (
    asked: Expectation | null,
    name: string,
    placed: { room: number; by: Room['resolvedBy'] } | null
  ): string => {
    claim = asked;
    const id = marks.markFor({ type: 'room-name', text: name } as Block);
    if (id === undefined) throw new Error('no id');
    book.painted([id]);
    marks.markFor({ type: 'room-exits', text: 'Obvious exits: east' } as Block);
    if (asked?.kind === 'move') arrival += 1;
    claim = null;
    publish(
      placed === null ? { name } : { name, map: 1, number: placed.room, resolvedBy: placed.by }
    );
    return id;
  };
  /** A dark room walked into: no name line, placed by the step alone. */
  const dark = (room: number, name: string | null = null): void => {
    arrival += 1;
    publish({ name, map: 1, number: room, resolvedBy: 'dead-reckoning' });
  };
  const roomOf = (id: string) => book.pageOf({ text: lineIdOf(id), older: 0 }).marks[0]?.mark?.room;
  return { block, dark, roomOf };
}

describe('a room name printed while lost', () => {
  it('takes its room once a resync places the character, read back along the steps', () => {
    const h = harness();
    const first = h.block(step('e'), 'Sewer Tunnel', null);
    const second = h.block(step('e'), 'Sewer Tunnel', null);
    expect(h.roomOf(first)).toBeUndefined();
    const junction = h.block(step('e'), 'Sewer Junction', { room: 102, by: 'unique-name' });
    // The positive control: the resync placed its own line.
    expect(h.roomOf(junction)).toEqual({ map: 1, room: 102 });
    expect(h.roomOf(second)).toEqual({ map: 1, room: 101 });
    expect(h.roomOf(first)).toEqual({ map: 1, room: 100 });
  });

  it('takes the room it was looked at again in', () => {
    const h = harness();
    const walked = h.block(step('e'), 'Sewer Tunnel', null);
    const look = h.block({ kind: 'reread', command: 'l' }, 'Sewer Tunnel', null);
    h.block(step('e'), 'Sewer Junction', { room: 102, by: 'unique-name' });
    expect(h.roomOf(look)).toEqual({ map: 1, room: 101 });
    expect(h.roomOf(walked)).toEqual({ map: 1, room: 101 });
  });

  it('stays without a room when two rooms of its name lead on that way', () => {
    const h = harness();
    const cave = h.block(step('n'), 'Dark Cave', null);
    const mouth = h.block(step('n'), 'Cave Mouth', { room: 302, by: 'unique-name' });
    expect(h.roomOf(mouth)).toEqual({ map: 1, room: 302 });
    expect(h.roomOf(cave)).toBeUndefined();
  });

  it('stops at a line whose way on is unknown', () => {
    const h = harness();
    const before = h.block(step('e'), 'Sewer Tunnel', null);
    const after = h.block(step('e'), 'Sewer Tunnel', null);
    // A room nothing asked for: a move nobody announced, so no way back is known.
    const junction = h.block(null, 'Sewer Junction', { room: 102, by: 'unique-name' });
    expect(h.roomOf(junction)).toEqual({ map: 1, room: 102 });
    expect(h.roomOf(after)).toBeUndefined();
    expect(h.roomOf(before)).toBeUndefined();
  });

  it('is read back no further than a dark room between two lines', () => {
    const h = harness();
    const before = h.block(step('e'), 'Sewer Tunnel', null);
    h.dark(401);
    const tunnel = h.block(step('e'), 'Sewer Tunnel', { room: 101, by: 'exit-signature' });
    expect(h.roomOf(tunnel)).toEqual({ map: 1, room: 101 });
    expect(h.roomOf(before)).toBeUndefined();
  });
});

describe('a room name placed on a guess', () => {
  it('takes the right room when a resync proves the guess wrong', () => {
    const h = harness();
    h.block(step('e'), 'North Road', { room: 400, by: 'movement' });
    h.dark(401);
    // Guessed from the dark room, wrongly: the realm has another tunnel.
    const guessed = h.block(step('e'), 'Sewer Tunnel', { room: 200, by: 'movement' });
    expect(h.roomOf(guessed)).toEqual({ map: 1, room: 200 });
    h.block(step('e'), 'Sewer Junction', { room: 102, by: 'unique-name' });
    expect(h.roomOf(guessed)).toEqual({ map: 1, room: 101 });
  });

  it('loses its room when the resync cannot tell the right one', () => {
    const h = harness();
    h.block(step('e'), 'North Road', { room: 400, by: 'movement' });
    h.dark(401);
    const guessed = h.block(step('n'), 'Dark Cave', { room: 300, by: 'movement' });
    expect(h.roomOf(guessed)).toEqual({ map: 1, room: 300 });
    h.block(step('n'), 'Cave Mouth', { room: 302, by: 'unique-name' });
    expect(h.roomOf(guessed)).toBeUndefined();
  });

  it('keeps its room when the resync agrees with the guess', () => {
    const h = harness();
    h.block(step('e'), 'North Road', { room: 400, by: 'movement' });
    h.dark(401);
    const guessed = h.block(step('e'), 'Sewer Tunnel', { room: 101, by: 'movement' });
    const junction = h.block(step('e'), 'Sewer Junction', { room: 102, by: 'unique-name' });
    expect(h.roomOf(junction)).toEqual({ map: 1, room: 102 });
    expect(h.roomOf(guessed)).toEqual({ map: 1, room: 101 });
  });

  it('loses its room past where the trace stops, though the line after it held its guess', () => {
    const h = harness();
    h.block(step('e'), 'North Road', { room: 400, by: 'movement' });
    h.dark(401);
    const cave = h.block(step('n'), 'Dark Cave', { room: 300, by: 'movement' });
    const mouth = h.block(step('n'), 'Cave Mouth', { room: 302, by: 'movement' });
    expect(h.roomOf(cave)).toEqual({ map: 1, room: 300 });
    // Coordinates agree with the guessed mouth, but two caves lead north into it.
    h.block({ kind: 'reread', command: 'rm' }, 'Cave Mouth', { room: 302, by: 'coordinates' });
    expect(h.roomOf(mouth)).toEqual({ map: 1, room: 302 });
    expect(h.roomOf(cave)).toBeUndefined();
  });

  it('is not proved by a dark room that shares its name', () => {
    const h = harness();
    h.block(step('e'), 'North Road', { room: 400, by: 'movement' });
    h.dark(401);
    const guessed = h.block(step('e'), 'Sewer Tunnel', { room: 200, by: 'movement' });
    // The next room is dark and guessed to have the same name: still a guess.
    h.dark(101, 'Sewer Tunnel');
    expect(h.roomOf(guessed)).toEqual({ map: 1, room: 200 });
    h.block(step('e'), 'Sewer Junction', { room: 102, by: 'unique-name' });
    // The positive control: the resync reached the line, and the dark room broke the way back.
    expect(h.roomOf(guessed)).toBeUndefined();
  });

  it('is left alone while the character is placed on its own evidence', () => {
    const h = harness();
    const road = h.block(step('e'), 'North Road', { room: 400, by: 'movement' });
    const tunnel = h.block(step('e'), 'Sewer Tunnel', { room: 200, by: 'movement' });
    h.block(step('e'), 'Sewer Junction', { room: 102, by: 'unique-name' });
    // No dark room, so no guess: a later placement does not read back over them.
    expect(h.roomOf(tunnel)).toEqual({ map: 1, room: 200 });
    expect(h.roomOf(road)).toEqual({ map: 1, room: 400 });
  });
});
