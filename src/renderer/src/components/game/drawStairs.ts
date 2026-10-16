/**
 * Stairs on the game view's map (todo 151): a mark on the right edge of the
 * room's tile, ▲ at the top for up and ▼ at the bottom for down, with the
 * count of a climb of one-room floors (▼8). A stair onto a floor the count
 * does not expect wears the warning colour and names the room it reaches.
 * Returns where each mark is, with its pointer area: the half of the tile on
 * the mark's side, since the mark alone was hard to land on in the prototype.
 */
import type { GameCell, GameStair } from '@shared/gameMap';
import type { Box } from '../../lib/gameFloors';
import { onScreen, tileSize, toScreen, type GamePalette, type Scene, type View } from './drawWorld';

export interface StairSpot {
  cell: GameCell;
  stair: GameStair;
  /** The mark's centre on screen. */
  x: number;
  y: number;
  /** Where the pointer finds it. */
  area: Box;
}

/** What a stair's mark says: its arrow, and the count of a climb. */
export function stairGlyph(stair: GameStair): string {
  return `${stair.direction === 'u' ? '▲' : '▼'}${stair.floors > 1 ? stair.floors : ''}`;
}

export function drawStairs(
  ctx: CanvasRenderingContext2D,
  view: View,
  scene: Scene,
  pal: GamePalette,
  hovered: StairSpot | null
): StairSpot[] {
  const spots: StairSpot[] = [];
  const s = tileSize(view.cam);
  const size = Math.max(9, Math.min(12, s * 0.48));
  ctx.textBaseline = 'middle';
  for (const cell of scene.win.cells) {
    if (cell.stairs === undefined) continue;
    const p = toScreen(view, cell.gx, cell.gy);
    if (!onScreen(view, p)) continue;
    for (const stair of cell.stairs) {
      const up = stair.direction === 'u';
      const x = p.x + s / 2;
      const y = p.y + (up ? -s / 2 : s / 2);
      const colour = stair.odd ? pal.warn : pal.stair;
      const lit =
        hovered !== null &&
        hovered.cell.id === cell.id &&
        hovered.stair.direction === stair.direction;
      const text = stairGlyph(stair);
      ctx.font = `700 ${size}px ${pal.font}`;
      ctx.textAlign = 'center';
      const w = ctx.measureText(text).width + 6;
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - size * 0.62, w, size * 1.24, 4);
      ctx.fillStyle = lit ? colour : pal.ink;
      ctx.fill();
      ctx.fillStyle = lit ? pal.ink : colour;
      ctx.fillText(text, x, y + 1);
      if (stair.odd) {
        ctx.font = `600 ${size - 1}px ${pal.font}`;
        ctx.textAlign = 'left';
        ctx.lineWidth = 3;
        ctx.strokeStyle = pal.ground;
        ctx.strokeText(stair.name, x + w / 2 + 4, y);
        ctx.fillStyle = colour;
        ctx.fillText(stair.name, x + w / 2 + 4, y);
      }
      const half = cell.stairs.length > 1;
      spots.push({
        cell,
        stair,
        x,
        y,
        area: {
          x: p.x,
          y: half && !up ? p.y : p.y - s / 2 - size * 0.62,
          w: s / 2 + w / 2,
          h: (half ? s / 2 : s) + size * 0.62
        }
      });
    }
  }
  return spots;
}
