/**
 * Room descriptions seen in play (todo 140), kept per realm played.
 *
 * The world database has no descriptions (the `.mdb` `Rooms` table carries
 * none), and GreaterMUD's own data covers 38% of Paradigm's rooms; the rest
 * exist only as the server prints them. Kept so the next AI pass over the
 * world (`resources/world/<world>.theme.json`) can theme those rooms from
 * what they say. Read by that pass from `memory/descriptions-<played>.json`,
 * and in play by the room art (todo 20261020-2015-01).
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

/** A room the client placed for certain, with its name. */
export interface CertainRoom {
  room: RoomId;
  map: number;
  number: number;
  name: string;
}

/**
 * The room the character stands in when the client is sure which it is, or
 * null: a guessed, lost or ambiguous room is nobody's, since anything read
 * there would be filed against the wrong room.
 */
export function certainRoom(room: Room): CertainRoom | null {
  const id = roomAddress(room);
  if (id === null || room.map === null || room.number === null || room.name === null) return null;
  if (
    room.ambiguous > 1 ||
    room.resolvedBy === 'dead-reckoning' ||
    room.resolvedBy === 'remembered'
  )
    return null;
  return { room: id, map: room.map, number: room.number, name: room.name };
}

/**
 * What a room read tells the record, or null: a certain room with a name and
 * a description.
 */
export function describedRoom(room: Room): Omit<RoomDescription, 'at'> | null {
  const certain = certainRoom(room);
  if (certain === null || room.description === null) return null;
  const text = room.description.trim();
  return text.length === 0 ? null : { room: certain.room, name: certain.name, text };
}
