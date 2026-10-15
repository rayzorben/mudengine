/**
 * Room descriptions seen in play (todo 140), kept per realm played.
 *
 * The world database has no descriptions (the `.mdb` `Rooms` table carries
 * none), and GreaterMUD's own data covers 38% of Paradigm's rooms; the rest
 * exist only as the server prints them. Kept so the next AI pass over the
 * world (`resources/world/<world>.theme.json`) can theme those rooms from
 * what they say. Read by that pass from `memory/descriptions-<played>.json`.
 */
import type { Room } from './character';
import { roomAddress, type RoomId } from './world';

export const DESCRIPTIONS_VERSION = 1;

export interface RoomDescription {
  room: RoomId;
  /** The room's name as printed with it. */
  name: string;
  /** As the server printed it, lines joined. */
  text: string;
  /** When it was last printed so, epoch ms. */
  at: number;
}

/** The port a session writes through; `DescriptionBook` is the store. */
export interface RealmDescriptions {
  /** A room as the character read it: kept when placed for certain and described. */
  saw(room: Room, at: number): void;
}

/**
 * What a room read tells the record, or null: a room the client placed for
 * certain, with a name and a description. A guessed, lost or ambiguous room
 * is not written down, since its text would be filed against the wrong room.
 */
export function describedRoom(room: Room): Omit<RoomDescription, 'at'> | null {
  const id = roomAddress(room);
  if (id === null || room.name === null || room.description === null) return null;
  if (
    room.ambiguous > 1 ||
    room.resolvedBy === 'dead-reckoning' ||
    room.resolvedBy === 'remembered'
  )
    return null;
  const text = room.description.trim();
  return text.length === 0 ? null : { room: id, name: room.name, text };
}
