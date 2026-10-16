/**
 * A stair's peek window (todo 151): the room it reaches, ringed, with its
 * neighbours on that floor, beside the mark and joined to it by a leader.
 * Drawn while the pointer is on the mark or the window; where it goes is
 * `placePeek` (`lib/gameFloors.ts`). The rooms are the small square `usePeek`
 * asked of main, drawn by the map's own `drawWorld` at the window's scale.
 */
import { cellKey, type GameMapWindow } from '@shared/gameMap';
import { PEEK_CELLS, type Box } from '../../lib/gameFloors';
import { t } from '../../lib/i18n';
import type { StairSpot } from './drawStairs';
import { stairGlyph } from './drawStairs';
import { CELL_PX, drawWorld, hexA, type GamePalette, type Scene, type View } from './drawWorld';

/** The window's size on screen, in px: 7 by 5 cells, the prototype's, below a title row. */
export const PEEK_SIZE = { w: 186, h: 152 } as const;
const TITLE_H = 18;

/** What the window's title says. */
export function peekTitle(spot: StairSpot): string {
  const { stair } = spot;
  const glyph = stairGlyph(stair);
  return stair.floor === null
    ? t('game.map.peekTitleOtherMap', { glyph, roomName: stair.name })
    : t('game.map.peekTitle', { glyph, roomName: stair.name, floor: stair.floor });
}

/** The line under the title, for a climb or an odd stair; null for an ordinary one. */
export function peekNote(spot: StairSpot, shownFloor: number | null): string | null {
  const { stair } = spot;
  if (stair.odd && stair.floor !== null && shownFloor !== null) {
    const expected = shownFloor + (stair.direction === 'u' ? stair.floors : -stair.floors);
    return t('game.map.stairOdd', { expected, floor: stair.floor });
  }
  return stair.floors > 1 ? t('game.map.stairClimb', { count: stair.floors }) : null;
}

export function drawPeek(
  ctx: CanvasRenderingContext2D,
  pal: GamePalette,
  spot: StairSpot,
  box: Box,
  win: GameMapWindow | null,
  shownFloor: number | null
): void {
  const colour = spot.stair.odd ? pal.warn : pal.stair;
  // The leader, from the mark to the window's nearest point.
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(spot.x, spot.y);
  ctx.lineTo(
    Math.max(box.x, Math.min(spot.x, box.x + box.w)),
    Math.max(box.y, Math.min(spot.y, box.y + box.h))
  );
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.w, box.h, 10);
  ctx.fillStyle = hexA(pal.ink, 0.94);
  ctx.fill();
  ctx.strokeStyle = colour;
  ctx.stroke();
  ctx.clip();
  const centre = win?.centre ?? null;
  if (win !== null && centre !== null) {
    const body = { x: box.x, y: box.y + TITLE_H, w: box.w, h: box.h - TITLE_H };
    const cell = body.w / (PEEK_CELLS.x * 2 + 1);
    const view: View = {
      width: body.w,
      height: body.h,
      cam: { x: centre.gx, y: centre.gy, z: cell / CELL_PX }
    };
    const scene: Scene = {
      win,
      at: new Map(win.cells.map((one) => [cellKey(one.gx, one.gy), one])),
      byId: new Map(win.cells.map((one) => [one.id, one])),
      here: null,
      candidates: [],
      trail: [],
      stops: new Set(),
      finds: new Set(),
      found: [],
      players: [],
      hover: null,
      now: 0
    };
    ctx.translate(body.x, body.y);
    // Below 1, so the window carries no labels: the title names the room.
    drawWorld(ctx, view, scene, pal, null, 0.95);
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(body.w / 2, body.h / 2, cell * 0.5, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  ctx.font = `600 10px ${pal.font}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = colour;
  ctx.fillText(fit(ctx, peekTitle(spot), box.w - 14), box.x + 7, box.y + TITLE_H / 2 + 1);
  const note = peekNote(spot, shownFloor);
  if (note !== null) {
    ctx.fillStyle = pal.muted;
    ctx.fillText(fit(ctx, note, box.w - 14), box.x + 7, box.y + box.h - 9);
  }
}

/** The text cut to a width, with an ellipsis. */
function fit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
  return `${cut}…`;
}
