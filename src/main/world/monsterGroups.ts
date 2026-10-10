/**
 * The rooms some monster group may move into, and the monsters a group may
 * put in a room as a player walks in, read off `Monsters.Summoned By`.
 *
 * The server lets a monster follow, chase or patrol only into a room whose
 * `MobGroup` is the monster's own `Group` (`Mob.CanMoveThroughExit`,
 * Mob.cs:1215). The database export has no `MobGroup` column; it lists each
 * monster's group rooms as `Group: 15/1056` and `[4]Group(lair): 15/1055`. A
 * room no monster lists is one no grouped monster can follow a player into:
 * Fortress of the Crimson Flame, Main Gate (15/1054) between the fortress's
 * hallways. See `mudengine-world` › *A room no monster group reaches* and
 * `parts/routing.md` › *A room's wanderers are priced as a run*.
 */
import type { RealmSource } from './RealmSource';
import { roomId, type RoomId } from '../../shared/world';
import { number, text } from './values';

/** One `Group:` entry of a monster's `Summoned By`: its row, the room, and whether it is a lair's. */
interface GroupListing {
  row: number | null;
  room: RoomId;
  lair: boolean;
}

function* groupListings(source: RealmSource): Generator<GroupListing> {
  for (const row of source.table('Monsters')?.rows ?? []) {
    for (const match of text(row['Summoned By']).matchAll(
      /Group(\(lair\))?:\s*(\d+)\s*\/\s*(\d+)/g
    )) {
      yield {
        row: number(row['Number']),
        room: roomId(Number(match[2]), Number(match[3])),
        lair: match[1] !== undefined
      };
    }
  }
}

/**
 * Every `map/room` some monster's group reaches, or null when no monster lists
 * a group at all: a source without the column says nothing about any room.
 */
export function groupedRooms(source: RealmSource): ReadonlySet<RoomId> | null {
  const rooms = new Set<RoomId>();
  for (const { room } of groupListings(source)) rooms.add(room);
  return rooms.size === 0 ? null : rooms;
}

/**
 * The monster rows each room's group may put in it at random (format 61): a
 * plain `Group:` entry, never a lair's. `Room.Regen` (Room.cs:520-535) draws
 * one of the group's rows in the room's index range, one chance a player per
 * regen pass, in a room with no regen slots, which is a room with no lair.
 * Rows sorted, each once.
 */
export function groupWanderers(source: RealmSource): ReadonlyMap<RoomId, number[]> {
  const rooms = new Map<RoomId, Set<number>>();
  for (const { row, room, lair } of groupListings(source)) {
    if (lair || row === null) continue;
    const rows = rooms.get(room) ?? new Set<number>();
    rows.add(row);
    rooms.set(room, rows);
  }
  return new Map([...rooms].map(([room, rows]) => [room, [...rows].sort((a, b) => a - b)]));
}
