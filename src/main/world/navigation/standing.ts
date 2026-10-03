/** Every monster standing in a room, by name: its lair rows and its residents. */
import type { RoomId, WorldRoom } from '../../../shared/world';

export interface StandingRealm {
  byId(id: RoomId): WorldRoom | undefined;
  lairOf(room: WorldRoom): ReadonlyArray<{ name: string }>;
  residentEntities(room: WorldRoom): ReadonlyArray<{ name: string }>;
}

export function standing(world: StandingRealm, room: RoomId): string[] {
  const known = world.byId(room);
  if (known === undefined) return [];
  return [
    ...world.lairOf(known).map((mob) => mob.name),
    ...world.residentEntities(known).map((mob) => mob.name)
  ];
}
