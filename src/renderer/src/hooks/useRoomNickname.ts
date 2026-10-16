/**
 * MegaMUD's name for the room a card shows (todo 144), asked of the room
 * search by the room's own `map/room`, which main answers from its index
 * (`findRooms`). Null while asking, for a room with no name, and when the
 * answer is for a room the card has since left.
 */
import { useEffect, useState } from 'react';

import type { FoundRoom } from '@shared/destinations';
import type { RoomNickname } from '@shared/roomNicknames';
import { roomId } from '@shared/world';

export function useRoomNickname(
  search: ((query: string) => Promise<FoundRoom[]>) | undefined,
  map: number | null,
  room: number | null
): RoomNickname | null {
  const [named, setNamed] = useState<{ id: string; nickname: RoomNickname | null } | null>(null);
  const id = map === null || room === null ? null : roomId(map, room);
  useEffect(() => {
    if (search === undefined || id === null) return;
    let live = true;
    search(id)
      .then((rooms) => {
        if (live) setNamed({ id, nickname: rooms[0]?.nickname ?? null });
      })
      .catch((error: unknown) => {
        // A failed ask is a room with no name shown, and the console hears why.
        console.warn(`room name for ${id}: ${String(error)}`);
      });
    return () => {
      live = false;
    };
  }, [search, id]);
  return named !== null && named.id === id ? named.nickname : null;
}
