/**
 * The square of the plane the game view's map is drawing (todo 140), asked of
 * main around the character's room, and again around wherever a dragged map
 * looks once it nears the square's edge. A lost character keeps the last
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
import { roomId, type RoomId } from '@shared/world';
import { tuning } from '../lib/tuning';

/** How near the square's edge, in cells, a view may come before a new square is asked for. */
export const EDGE_CELLS = 12;

export interface GameMap {
  win: GameMapWindow;
  at: ReadonlyMap<string, GameCell>;
  byId: ReadonlyMap<RoomId, GameCell>;
  /** A dragged map looks here; asks for the square around it when it nears the edge. */
  lookAt(gx: number, gy: number): void;
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
  room: number | null
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
        .catch(() => {
          // The map stays as it was; the next room asks again.
        });
    },
    [api, session]
  );

  useEffect(() => {
    if (map === null || room === null) return;
    const shown = winRef.current;
    const cell =
      shown.map === map ? shown.cells.find((one) => one.id === roomId(map, room)) : undefined;
    if (cell && !nearEdge(shown, cell.gx, cell.gy)) return;
    ask({ kind: 'room', map, room, half: tuning().gameMapHalf });
  }, [map, room, ask]);

  useEffect(() => {
    setWin(EMPTY_GAME_MAP);
  }, [session]);

  const lookAt = useCallback(
    (gx: number, gy: number) => {
      const shown = winRef.current;
      if (shown.map === null || !nearEdge(shown, gx, gy)) return;
      ask({
        kind: 'point',
        map: shown.map,
        gx: Math.round(gx),
        gy: Math.round(gy),
        half: tuning().gameMapHalf
      });
    },
    [ask]
  );

  const at = useMemo(
    () => new Map(win.cells.map((cell) => [cellKey(cell.gx, cell.gy), cell])),
    [win]
  );
  const byId = useMemo(() => new Map(win.cells.map((cell) => [cell.id, cell])), [win]);
  return { win, at, byId, lookAt };
}
