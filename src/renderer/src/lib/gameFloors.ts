/**
 * The game view's floors (todo 151), worked out from the window main sent:
 * which floors the stairs in it reach, for the floor strip, and where a
 * stair's peek window goes. Pure; `FloorStrip` and `drawPeek` draw them. The
 * view is A from `todo/151-floor-views.html`, chosen by the user on 2026-10-15.
 */
import type { GameMapWindow, GameStair } from '@shared/gameMap';
import type { RoomId } from '@shared/world';

/** One row of the floor strip: a floor, and the room pressing it shows. */
export interface FloorChoice {
  floor: number;
  /** The room the nearest stair to that floor reaches; null for the floor shown. */
  to: RoomId | null;
}

/**
 * The floor shown and every floor of the map a stair in the window reaches,
 * highest first, each by the stair nearest `near` (plane cells). An empty
 * list when no stair reaches another floor: the strip is not drawn then.
 */
export function floorsReached(win: GameMapWindow, near: { gx: number; gy: number }): FloorChoice[] {
  if (win.floor === null) return [];
  const best = new Map<number, { to: RoomId; d: number }>();
  for (const cell of win.cells)
    for (const stair of cell.stairs ?? []) {
      if (stair.floor === null || stair.floor === win.floor) continue;
      const d = Math.hypot(cell.gx - near.gx, cell.gy - near.gy);
      const held = best.get(stair.floor);
      if (held === undefined || d < held.d) best.set(stair.floor, { to: stair.to, d });
    }
  if (best.size === 0) return [];
  return [
    { floor: win.floor, to: null },
    ...[...best].map(([floor, { to }]) => ({ floor, to }))
  ].sort((a, b) => b.floor - a.floor);
}

/** The cells either side of the room a peek window shows: 7 by 5, the prototype's. */
export const PEEK_CELLS = { x: 3, y: 2 } as const;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a stair's peek window goes: up and to the right for a way up, down and
 * to the left for a way down, then the other corners, the first that stays on
 * the canvas and off the arena. Null when none does: the mark alone is drawn.
 */
export function placePeek(
  mark: { x: number; y: number },
  direction: GameStair['direction'],
  size: { w: number; h: number },
  gap: number,
  canvas: { width: number; height: number },
  arena: { x: number; y: number; r: number }
): Box | null {
  const corners: ReadonlyArray<readonly [number, number]> =
    direction === 'u'
      ? [
          [1, -1],
          [-1, -1],
          [1, 1],
          [-1, 1]
        ]
      : [
          [-1, 1],
          [1, 1],
          [-1, -1],
          [1, -1]
        ];
  const margin = 4;
  for (const [fx, fy] of corners) {
    const box = {
      x: fx > 0 ? mark.x + gap : mark.x - gap - size.w,
      y: fy < 0 ? mark.y - gap - size.h : mark.y + gap,
      w: size.w,
      h: size.h
    };
    const onCanvas =
      box.x > margin &&
      box.y > margin &&
      box.x + box.w < canvas.width - margin &&
      box.y + box.h < canvas.height - margin;
    if (onCanvas && !covers(box, arena)) return box;
  }
  return null;
}

/** Whether a box reaches into a circle. */
function covers(box: Box, disc: { x: number; y: number; r: number }): boolean {
  const nx = Math.max(box.x, Math.min(disc.x, box.x + box.w));
  const ny = Math.max(box.y, Math.min(disc.y, box.y + box.h));
  return Math.hypot(disc.x - nx, disc.y - ny) < disc.r;
}

/** Whether a point is in a box. */
export function inBox(box: Box, x: number, y: number): boolean {
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}
