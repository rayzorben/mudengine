/**
 * The rooms a run of name lines printed while lost were printed for, read
 * back from the room a resync placed the character in: each line's room is
 * the one of its name with the exit the character stepped through leading to
 * the room after it. Known exits followed backwards, never a route search.
 * Stops at the first line no single room answers. `mudengine-world` ›
 * *There is one navigation engine*.
 */
import {
  roomId,
  type Direction,
  type RoomId,
  type RoomReference,
  type WorldRoom
} from '../../../shared/world';
import type { WorldGraph } from '../WorldGraph';

/** How the character went from a line's room to the next line's: a step, a look in place, or unknown. */
export type Onward = Direction | 'stayed' | null;

/** A name line behind the resynced one, and how the character left its room for the next. */
export interface LineBehind {
  name: string;
  onward: Onward;
}

/**
 * The rooms of `behind`, newest first, from `from`, the room of the line
 * after the newest. Shorter than `behind` where a line's way on is unknown,
 * or its name has no room or several rooms that lead on that way.
 */
export function retrace(
  world: Pick<WorldGraph, 'findByName'>,
  from: WorldRoom,
  behind: readonly LineBehind[]
): WorldRoom[] {
  const rooms: WorldRoom[] = [];
  let next = from;
  for (const { name, onward } of behind) {
    if (onward === null) break;
    const there = next;
    const could = world
      .findByName(name)
      .filter((room) =>
        onward === 'stayed' ? idOf(room) === idOf(there) : leads(room, onward, there)
      );
    const only = could.length === 1 ? could[0] : undefined;
    if (only === undefined) break;
    rooms.push(only);
    next = only;
  }
  return rooms;
}

const leads = (room: WorldRoom, direction: Direction, to: WorldRoom): boolean =>
  room.exits.some((exit) => exit.direction === direction && idOf(exit) === idOf(to));

const idOf = (place: RoomReference): RoomId => roomId(place.map, place.room);
