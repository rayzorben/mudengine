/**
 * The rooms some monster group may move into, read off `Monsters.Summoned By`.
 *
 * The server lets a monster follow, chase or patrol only into a room whose
 * `MobGroup` is the monster's own `Group` (`Mob.CanMoveThroughExit`,
 * Mob.cs:1215). The database export has no `MobGroup` column; it lists each
 * monster's group rooms as `Group: 15/1056` and `[4]Group(lair): 15/1055`. A
 * room no monster lists is one no grouped monster can follow a player into:
 * Fortress of the Crimson Flame, Main Gate (15/1054) between the fortress's
 * hallways. See `mudengine-world` › *A room no monster group reaches*.
 */
import type { RealmSource } from './RealmSource';
import { roomId, type RoomId } from '../../shared/world';
import { text } from './values';

/**
 * Every `map/room` some monster's group reaches, or null when no monster lists
 * a group at all: a source without the column says nothing about any room.
 */
export function groupedRooms(source: RealmSource): ReadonlySet<RoomId> | null {
  const rooms = new Set<RoomId>();
  for (const row of source.table('Monsters')?.rows ?? []) {
    for (const match of text(row['Summoned By']).matchAll(
      /Group(?:\(lair\))?:\s*(\d+)\s*\/\s*(\d+)/g
    )) {
      rooms.add(roomId(Number(match[1]), Number(match[2])));
    }
  }
  return rooms.size === 0 ? null : rooms;
}
