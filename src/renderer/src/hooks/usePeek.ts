/**
 * The small square around the room a pointed-at stair reaches (todo 151), for
 * its peek window: asked of main on hover, on that room's own floor, and the
 * last few answers kept, so pointing back at a stair draws at once and the
 * map's own window is never replaced.
 */
import { useEffect, useRef, useState } from 'react';

import type { GameMapWindow } from '@shared/gameMap';
import type { IpcApi, SessionId } from '@shared/ipc';
import { errorMessage } from '@shared/values';
import { asRoomReference, type RoomId } from '@shared/world';
import { PEEK_CELLS } from '../lib/gameFloors';

/** Answers kept: a handful of stairs on screen, pointed at in turn. */
export const PEEKS_KEPT = 8;

export function usePeek(
  api: Pick<IpcApi, 'gameMap'>,
  session: SessionId,
  room: RoomId | null
): GameMapWindow | null {
  const kept = useRef(new Map<RoomId, GameMapWindow>());
  const [, setAnswered] = useState(0);

  useEffect(() => {
    kept.current.clear();
  }, [session]);

  useEffect(() => {
    if (room === null || kept.current.has(room)) return;
    const at = asRoomReference(room);
    if (at === null) return;
    let live = true;
    api
      .gameMap(session, {
        kind: 'room',
        map: at.map,
        room: at.room,
        half: Math.max(PEEK_CELLS.x, PEEK_CELLS.y)
      })
      .then((answer) => {
        if (!live) return;
        const held = kept.current;
        held.delete(room);
        held.set(room, answer);
        while (held.size > PEEKS_KEPT) held.delete(held.keys().next().value!);
        setAnswered((count) => count + 1);
      })
      .catch((error: unknown) => {
        // The mark is still drawn and pointing again asks again; the window stays empty meanwhile.
        console.error(
          `[game map] the peek window for ${room} (${session}): ${errorMessage(error)}`
        );
      });
    return () => {
      live = false;
    };
  }, [api, session, room]);

  return room === null ? null : (kept.current.get(room) ?? null);
}
