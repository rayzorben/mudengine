/**
 * What a room search field answers (`Invoke.searchRooms`): the palette, the
 * route panel, the Map card's fields and the loop builder all ask this. In
 * order, each room once:
 *
 * 1. a `map/room` is that room alone, or nothing: a reference that misses is
 *    a room the realm does not have, and a name search for `1/99999` would
 *    fail a second time and blame the wrong thing;
 * 2. the rooms this realm has been walked to, newest first (`DestinationBook`);
 *    with nothing typed, the latest few and nothing else (user, 2026-10-10);
 * 3. the room a MegaMUD code names (`vxdf`), with the rest still listed after
 *    it, since codes such as `TOMB` and `POOL` are words people search by;
 * 4. the rooms MegaMUD's goto list names so (`RoomNicknames`);
 * 5. the realm's own substring match on room names.
 *
 * Every row carries MegaMUD's name for its room where there is one.
 */
import type { FoundRoom, VisitedDestination } from '../../shared/destinations';
import type { RoomNickname } from '../../shared/roomNicknames';
import { asRoomReference, roomId, type WorldRoom } from '../../shared/world';
import type { NamedRoom, RoomNicknames } from './RoomNicknames';

export interface RoomSearchParts {
  world: {
    get(map: number, room: number): WorldRoom | undefined;
    searchByName(query: string): WorldRoom[];
  };
  nicknames: Pick<RoomNicknames, 'byCode' | 'search' | 'nameOf'>;
  /** The destinations matching `query`, newest first, at most `limit`. */
  recent(query: string, limit: number): readonly VisitedDestination[];
  /** How many destinations a blank query lists. */
  recentShown: number;
  /** How many rooms MegaMUD's names may add. */
  nicknameRows: number;
}

export function findRooms(query: string, parts: RoomSearchParts): FoundRoom[] {
  const { world, nicknames } = parts;
  const found = (
    room: WorldRoom,
    visitedAt: number | null,
    nickname: RoomNickname | null = null
  ): FoundRoom => ({
    ...room,
    visitedAt,
    nickname: nickname ?? nicknames.nameOf(roomId(room.map, room.room))
  });

  const reference = asRoomReference(query);
  if (reference !== null) {
    const room = world.get(reference.map, reference.room);
    return room === undefined ? [] : [found(room, null)];
  }

  const blank = query.trim().length === 0;
  /*
   * A recorded destination is resolved against the realm rather than drawn
   * from the record: `world.database` is a per-character setting, and a row
   * whose id the realm no longer has would plan a route to nowhere. It stays
   * in the file, because the realm may be swapped back.
   */
  const recent = parts
    .recent(query, blank ? parts.recentShown : Number.POSITIVE_INFINITY)
    .flatMap((entry) => {
      const at = asRoomReference(entry.id);
      const room = at === null ? undefined : world.get(at.map, at.room);
      return room === undefined ? [] : [found(room, entry.at)];
    });
  if (blank) return recent;

  const coded = nicknames.byCode(query);
  const named = (each: NamedRoom): FoundRoom => found(each.room, null, each.nickname);
  const rows = [
    ...recent,
    ...(coded === null ? [] : [named(coded)]),
    ...nicknames.search(query, parts.nicknameRows).map(named),
    ...world.searchByName(query).map((room) => found(room, null))
  ];
  const seen = new Set<string>();
  return rows.filter((row) => {
    const id = roomId(row.map, row.room);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
