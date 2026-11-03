/**
 * The cells a tab was sent of each placement, kept by room, so the next ask
 * names what is held and main answers only the rest (todo
 * 20261102-1008-02). One store serves every character of the tab: a
 * placement belongs to a realm's world, so two characters in one region
 * share its cells, and a world loaded afresh is placed under new frames and
 * never meets the old cells.
 *
 * `take` turns an answer into the `LocalMap` a whole fetch of the same
 * window would have been: the window's cells, moved so the centre is the
 * origin, with this character's lair odds. The cells are in a fixed order
 * (row, then column), whichever answers brought them.
 */
import { EMPTY_MAP, inWindow, type LocalMap, type MapCell, type MapWindow } from './map';
import { NO_FRAME, shiftWindow, type MapAsk, type MapPiece } from './mapPiece';
import type { RoomId } from './world';

export interface MapCellLimits {
  /** Placements kept, least recently used dropped first. */
  frames: number;
  /** Rectangles named as held per placement, oldest dropped first. */
  windows: number;
}

interface Frame {
  readonly cells: Map<RoomId, MapCell>;
  /** Rectangles every cell of which is in `cells`. */
  windows: MapWindow[];
}

const contains = (outer: MapWindow, inner: MapWindow): boolean =>
  inner.minX >= outer.minX &&
  inner.maxX <= outer.maxX &&
  inner.minY >= outer.minY &&
  inner.maxY <= outer.maxY;

export class MapCellStore {
  private readonly frames = new Map<number, Frame>();

  /** The limits are read at each answer, so an edited figure applies to the next. */
  constructor(private readonly limits: () => MapCellLimits) {}

  /**
   * The ask for `window` round `centre`: what is held of the latest placement
   * that holds the centre's cell, which is the one main keeps for it.
   */
  ask(centre: RoomId, window: MapWindow): MapAsk {
    const frames = [...this.frames.entries()].reverse();
    const found = frames.find(([, frame]) => frame.cells.has(centre));
    if (found === undefined) return { window, held: null };
    const [number, frame] = found;
    return { window, held: { frame: number, windows: frame.windows.map((w) => ({ ...w })) } };
  }

  /**
   * Keeps an answer's cells and hands back the window as a whole fetch draws
   * it. Null when the answer left out cells `asked` named as held and the
   * store has since dropped that placement: the caller asks again whole.
   */
  take(piece: MapPiece, asked: MapAsk): LocalMap | null {
    if (piece.frame === NO_FRAME || piece.centre === null) return EMPTY_MAP;
    if (asked.held?.frame === piece.frame && !this.frames.has(piece.frame)) return null;
    const frame = this.touch(piece.frame);
    for (const cell of piece.cells) frame.cells.set(cell.id, cell);
    frame.windows = [
      ...frame.windows.filter((held) => !contains(piece.window, held)),
      piece.window
    ].slice(-Math.max(1, this.limits().windows));

    const { gx, gy } = piece.at;
    const cells: MapCell[] = [];
    for (const cell of frame.cells.values()) {
      if (!inWindow(piece.window, cell.gx, cell.gy)) continue;
      // Kept cells carry no odds (`MapPiece.cells`); this character's come with each answer.
      const odds = piece.odds[cell.id];
      cells.push({
        ...cell,
        gx: cell.gx - gx,
        gy: cell.gy - gy,
        ...(odds === undefined ? {} : { lairOdds: odds })
      });
    }
    cells.sort((a, b) => a.gy - b.gy || a.gx - b.gx);
    return {
      centre: piece.centre,
      cells,
      dropped: piece.dropped,
      placed: piece.placed,
      extent: shiftWindow(piece.extent, piece.at, -1)
    };
  }

  /** The placement's entry, made the most recently used, the oldest past the limit dropped. */
  private touch(number: number): Frame {
    const frame = this.frames.get(number) ?? { cells: new Map(), windows: [] };
    this.frames.delete(number);
    this.frames.set(number, frame);
    const kept = Math.max(1, this.limits().frames);
    while (this.frames.size > kept) {
      const oldest = this.frames.keys().next().value;
      if (oldest === undefined) break;
      this.frames.delete(oldest);
    }
    return frame;
  }
}
