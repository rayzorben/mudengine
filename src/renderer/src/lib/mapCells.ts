/**
 * The window's one cell store (`MapCellStore`), shared by every map of every
 * character it shows, and the loader that asks through it: each ask names
 * what the store holds, and each answer is folded in and handed back whole,
 * so a map draws what a whole fetch would have drawn (todo
 * 20261102-1008-02).
 */
import { EMPTY_MAP, type MapLoader } from '@shared/map';
import { MapCellStore } from '@shared/mapCells';
import type { MapAsk, MapPiece } from '@shared/mapPiece';
import { roomId } from '@shared/world';
import { tuning } from './tuning';

const cells = new MapCellStore(() => ({
  frames: tuning().mapFramesKept,
  windows: tuning().mapHeldWindows
}));

/** How a character's realm is asked for a piece of the map (`IpcApi.localMap`). */
export type MapFetch = (map: number, room: number, ask: MapAsk) => Promise<MapPiece>;

/**
 * A `MapLoader` that asks only for the cells the store lacks, and once more
 * for the whole window when the placement it named was dropped meanwhile.
 */
export function keptCellsLoader(fetch: MapFetch): MapLoader {
  return async (map, room, area) => {
    const ask = cells.ask(roomId(map, room), area);
    const kept = cells.take(await fetch(map, room, ask), ask);
    if (kept !== null) return kept;
    const whole: MapAsk = { window: area, held: null };
    return cells.take(await fetch(map, room, whole), whole) ?? EMPTY_MAP;
  };
}
