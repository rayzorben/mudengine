/**
 * The items seen lying on a room's floor, kept per realm played so an item's
 * lookup can say where it has been seen and when. See `mudengine-world` ›
 * `parts/lore.md` › *What lies on a floor is kept per realm*.
 */
import type { Room } from './character';
import { certainRoom } from './descriptions';
import { bareName } from './items';
import type { RoomId } from './world';

export const FLOOR_VERSION = 1;

/** One item seen in one room. */
export interface FloorSeen {
  room: RoomId;
  /** The room's name as printed, so a row reads without the database. */
  roomName: string;
  /** As the server spelled it, the count taken off. */
  name: string;
  /** When it was first seen there, epoch ms. */
  first: number;
  /** When it was last seen there, epoch ms. */
  at: number;
}

/** The port a session writes through; `FloorBook` is the store. */
export interface RealmFloor {
  /** A room as the character read it: its floor kept when placed for certain. */
  saw(room: Room, at: number): void;
  readonly all: readonly FloorSeen[];
}

/** One row per item per room, whatever the spelling's article or slot note. */
export function floorKey(row: Pick<FloorSeen, 'room' | 'name'>): string {
  return `${row.room}|${bareName(row.name)}`;
}

/**
 * What a room read puts on the record, or nothing: the open floor of a room
 * placed for certain. A search's finds are not here; `FindBook` keeps them.
 */
export function floorOf(room: Room): Omit<FloorSeen, 'first' | 'at'>[] {
  const certain = certainRoom(room);
  if (certain === null) return [];
  return room.items
    .filter((item) => bareName(item.name).length > 0)
    .map((item) => ({ room: certain.room, roomName: certain.name, name: item.name }));
}
