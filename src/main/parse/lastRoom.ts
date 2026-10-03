/**
 * The room a character is placed in while it is not in the realm.
 *
 * A closed socket, the account menu and a relaunch all leave the character
 * where it last stood, so its room's placement is kept as `remembered` and the
 * map goes on drawing it. Who and what were in the room are dropped, since they
 * may have left. The first room the server prints after login either matches it
 * and confirms it (`sameRoomAgain`, `room.ts`) or is resolved like any other
 * room. See `mudengine-wire` › `parts/room.md`, *The last room outlives the
 * socket*.
 */
import type { BelongingsSink, KeptRoom } from '../../shared/belongings';
import { emptyRoom, type Room } from '../../shared/character';
import { roomId } from '../../shared/world';
import type { WorldGraph } from '../world/WorldGraph';

/** The placed part of `room`, kept as remembered; nothing when it was never placed. */
export function rememberedRoom(room: Room): Room {
  if (room.map === null || room.number === null) return emptyRoom();
  return {
    ...emptyRoom(),
    name: room.name,
    description: room.description,
    exits: room.exits,
    map: room.map,
    number: room.number,
    resolvedBy: 'remembered',
    confidence: room.confidence,
    ambiguous: 1,
    arrival: room.arrival
  };
}

/**
 * The room a character's record kept, named from the realm. A room the realm
 * does not have is the record disagreeing with the data, and places nothing.
 */
export function recalledRoom(kept: KeptRoom | null, world?: Pick<WorldGraph, 'byId'>): Room {
  if (kept === null) return emptyRoom();
  const known = world?.byId(roomId(kept.map, kept.room));
  if (world !== undefined && known === undefined) return emptyRoom();
  return {
    ...emptyRoom(),
    name: known?.name ?? null,
    map: kept.map,
    number: kept.room,
    resolvedBy: 'remembered',
    confidence: kept.confidence,
    ambiguous: 1
  };
}

/**
 * How a carried room is placed once the server has spoken: a remembered room is
 * confirmed `by` what it printed (its name and exits, or its `Location:`).
 */
export function confirmedBy(
  method: Room['resolvedBy'],
  by: Room['resolvedBy']
): Room['resolvedBy'] {
  return method === 'remembered' ? by : method;
}

/** Whether leaving the realm from `room` leaves nothing to keep that is not kept already. */
export function nothingToRemember(room: Room): boolean {
  return room.name === null || room.resolvedBy === 'remembered';
}

/** Writes a newly placed room to the character's record; a remembered one is already there. */
export function keepPlacement(record: Pick<BelongingsSink, 'rememberRoom'>, room: Room): void {
  const { map, number, confidence } = room;
  if (map === null || number === null || room.resolvedBy === 'remembered') return;
  record.rememberRoom({ map, room: number, confidence });
}
