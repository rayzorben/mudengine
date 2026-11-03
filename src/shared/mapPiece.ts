/**
 * The Map card's ask and answer on the wire (`IpcApi.localMap`, todo
 * 20261102-1008-02).
 *
 * Main keeps a flat placement while the centre moves inside it, and numbers
 * it (`frame`). The answer states cells in that placement's own coordinates
 * with the centre's position (`at`), so a step inside one placement moves no
 * cell. The tab keeps the cells it was sent by placement (`MapCellStore`) and
 * says which rectangles of it it holds, and main sends only the cells outside
 * them. A lair's odds are the character's, not the realm's, so they ride
 * apart from the cells and are sent for the whole asked window every time.
 */
import { asMapWindow, type MapCell, type MapWindow } from './map';
import type { SurvivalLevel } from './survival';
import type { RoomId } from './world';

/** The rectangles of one placement a tab holds every cell of, in that placement's coordinates. */
export interface MapHeld {
  frame: number;
  windows: MapWindow[];
}

export interface MapAsk {
  /** The rectangle wanted, in cells from the asked room (`windowForView`). */
  window: MapWindow;
  /** What the tab already holds, or null for a whole answer. */
  held: MapHeld | null;
}

/** A cell position in a placement's coordinates. */
export interface MapAt {
  gx: number;
  gy: number;
}

export interface MapPiece {
  /** The placement the cells are stated in; `NO_FRAME` when there is none. */
  frame: number;
  centre: RoomId | null;
  /** Where the centre sits in the placement. */
  at: MapAt;
  /** The asked rectangle, moved into the placement's coordinates. */
  window: MapWindow;
  /** The placed cells inside `window` that no held rectangle covers, without `lairOdds`. */
  cells: MapCell[];
  /** Every lair inside `window` rated for this character, held or not. */
  odds: Partial<Record<RoomId, SurvivalLevel>>;
  /** As `LocalMap`, over the whole placement. */
  dropped: number;
  placed: number;
  /** The placement's extent, in its own coordinates. */
  extent: MapWindow;
}

/** No placement: the room is not in the realm, or there is no realm data. */
export const NO_FRAME = 0;

const ORIGIN: MapAt = Object.freeze({ gx: 0, gy: 0 });

export const NO_PIECE: MapPiece = Object.freeze({
  frame: NO_FRAME,
  centre: null,
  at: ORIGIN,
  window: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  cells: [],
  odds: {},
  dropped: 0,
  placed: 0,
  extent: { minX: 0, maxX: 0, minY: 0, maxY: 0 }
});

/** A window moved by `at`: from the centre's cells into the placement's, or back with `-1`. */
export function shiftWindow(window: MapWindow, at: MapAt, sign: 1 | -1 = 1): MapWindow {
  return {
    minX: window.minX + sign * at.gx,
    maxX: window.maxX + sign * at.gx,
    minY: window.minY + sign * at.gy,
    maxY: window.maxY + sign * at.gy
  };
}

/**
 * An ask off the wire, or null when its window is unreadable. A held part
 * that does not parse, or lists more than `maxHeld` rectangles, is dropped
 * and the answer is whole: it costs bytes, never a wrong picture.
 */
export function asMapAsk(value: unknown, maxHeld: number): MapAsk | null {
  if (typeof value !== 'object' || value === null) return null;
  const { window, held } = value as Record<string, unknown>;
  const asked = asMapWindow(window);
  if (asked === null) return null;
  return { window: asked, held: asHeld(held, maxHeld) };
}

function asHeld(value: unknown, maxHeld: number): MapHeld | null {
  if (typeof value !== 'object' || value === null) return null;
  const { frame, windows } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(frame) || (frame as number) <= NO_FRAME) return null;
  if (!Array.isArray(windows) || windows.length > maxHeld) return null;
  const parsed: MapWindow[] = [];
  for (const window of windows) {
    const read = asMapWindow(window);
    if (read === null) return null;
    parsed.push(read);
  }
  return { frame: frame as number, windows: parsed };
}
