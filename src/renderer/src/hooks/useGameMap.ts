/**
 * The square of one floor the game view's map is drawing (todo 140, floors
 * todo 151), asked of main around the character's room, again around wherever
 * a dragged map looks once it nears the square's edge, and around the room a
 * stair or the floor strip shows. While the map is detached the character's
 * moves ask nothing; brought back (◎, Esc, a move), it asks for the room's
 * square if the room is not in the one shown. A lost character keeps the last
 * square, so its candidates can still be drawn. An answer that arrives after
 * a newer ask is dropped.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  cellKey,
  EMPTY_GAME_MAP,
  type GameCell,
  type GameMapAsk,
  type GameMapWindow
} from '@shared/gameMap';
import type { IpcApi, SessionId } from '@shared/ipc';
import { errorMessage } from '@shared/values';
import { asRoomReference, roomId, type RoomId } from '@shared/world';
import { tuning } from '../lib/tuning';

/** How near the square's edge, in cells, a view may come before a new square is asked for. */
export const EDGE_CELLS = 12;

export interface GameMap {
  win: GameMapWindow;
  at: ReadonlyMap<string, GameCell>;
  byId: ReadonlyMap<RoomId, GameCell>;
  /** A dragged map looks here; asks for the square around it when it nears the edge. */
  lookAt(gx: number, gy: number): void;
  /** A detached map shows this room's floor around it. */
  show(room: RoomId): void;
  /** The floor the character's room was last seen on; null until a window holds it. */
  homeFloor: number | null;
}

const nearEdge = (win: GameMapWindow, gx: number, gy: number): boolean =>
  gx - win.box.x0 < EDGE_CELLS ||
  win.box.x1 - gx < EDGE_CELLS ||
  gy - win.box.y0 < EDGE_CELLS ||
  win.box.y1 - gy < EDGE_CELLS;

export function useGameMap(
  api: Pick<IpcApi, 'gameMap'>,
  session: SessionId,
  map: number | null,
  room: number | null,
  detached: boolean
): GameMap {
  const [win, setWin] = useState<GameMapWindow>(EMPTY_GAME_MAP);
  const asked = useRef(0);
  const winRef = useRef(win);
  winRef.current = win;

  const ask = useCallback(
    (question: GameMapAsk) => {
      asked.current += 1;
      const mine = asked.current;
      api
        .gameMap(session, question)
        .then((answer) => {
          if (mine === asked.current) setWin(answer);
        })
        .catch((error: unknown) => {
          // The map stays as it was; the next room asks again.
          console.error(
            `[game map] the ${question.kind} window (${session}): ${errorMessage(error)}`
          );
        });
    },
    [api, session]
  );

  useEffect(() => {
    if (map === null || room === null || detached) return;
    const shown = winRef.current;
    const cell =
      shown.map === map ? shown.cells.find((one) => one.id === roomId(map, room)) : undefined;
    if (cell && !nearEdge(shown, cell.gx, cell.gy)) return;
    ask({ kind: 'room', map, room, half: tuning().gameMapHalf });
  }, [map, room, detached, ask]);

  useEffect(() => {
    setWin(EMPTY_GAME_MAP);
  }, [session]);

  const lookAt = useCallback(
    (gx: number, gy: number) => {
      const shown = winRef.current;
      if (shown.map === null || !nearEdge(shown, gx, gy)) return;
      if (shown.floor === null) return;
      ask({
        kind: 'point',
        map: shown.map,
        floor: shown.floor,
        gx: Math.round(gx),
        gy: Math.round(gy),
        half: tuning().gameMapHalf
      });
    },
    [ask]
  );

  const show = useCallback(
    (id: RoomId) => {
      const at = asRoomReference(id);
      if (at !== null) ask({ kind: 'room', ...at, half: tuning().gameMapHalf });
    },
    [ask]
  );

  const at = useMemo(
    () => new Map(win.cells.map((cell) => [cellKey(cell.gx, cell.gy), cell])),
    [win]
  );
  const byId = useMemo(() => new Map(win.cells.map((cell) => [cell.id, cell])), [win]);
  // Kept across a window of another floor, so the strip can mark the character's own.
  const [homeFloor, setHomeFloor] = useState<number | null>(null);
  const here = map === null || room === null ? null : roomId(map, room);
  const seenHere = here !== null && byId.has(here);
  useEffect(() => {
    if (seenHere) setHomeFloor(win.floor);
  }, [seenHere, win.floor]);
  return { win, at, byId, lookAt, show, homeFloor };
}
