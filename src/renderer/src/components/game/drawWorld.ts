/**
 * The game view's map, drawn on a canvas (todo 140): a plain grid in the eight
 * compass directions, each area in its own colours, with the route, the loop's
 * stops, finds, found ways, other players, and the current room brightest.
 *
 * Drawn only when something changed or an animation runs (`WorldCanvas`); this
 * module holds no clock. Colours are the area's (theme pack) and the HUD's
 * tokens, read back from CSS (`readGamePalette`).
 */
import { STEP } from '@shared/map';
import {
  cellKey,
  type GameCell,
  type GameMapWindow,
  type MapArea,
  type MapLabel
} from '@shared/gameMap';
import type { Direction, RoomId } from '@shared/world';
import {
  DROP_PATH,
  LAIR_PATH,
  PLACE_PATHS,
  PLAYER_PATH,
  placeTone,
  type PlaceTone
} from '../../lib/gameIcons';

/** The HUD's colours, read from the `--game-*` tokens. */
export interface GamePalette {
  ground: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  hp: string;
  kai: string;
  mana: string;
  heal: string;
  poison: string;
  door: string;
  player: string;
  ink: string;
  shade: string;
  places: Record<PlaceTone, string>;
  font: string;
}

export function readGamePalette(from: Element): GamePalette {
  const style = getComputedStyle(from);
  const token = (name: string): string => style.getPropertyValue(`--game-${name}`).trim();
  return {
    ground: token('ground'),
    text: token('text'),
    muted: token('muted'),
    faint: token('faint'),
    accent: token('accent'),
    hp: token('hp'),
    kai: token('kai'),
    mana: token('mana'),
    heal: token('heal'),
    poison: token('poison'),
    door: token('door'),
    player: token('player'),
    ink: token('ink'),
    shade: token('shade'),
    places: {
      bank: token('bank'),
      temple: token('temple'),
      tavern: token('tavern'),
      trainer: token('trainer'),
      shop: token('shop')
    },
    font: style.getPropertyValue('--font-ui-family').trim() || 'sans-serif'
  };
}

export const PATHS = {
  lair: new Path2D(LAIR_PATH),
  player: new Path2D(PLAYER_PATH),
  drop: new Path2D(DROP_PATH),
  places: Object.fromEntries(
    Object.entries(PLACE_PATHS).map(([key, path]) => [key, new Path2D(path)])
  ) as Record<keyof typeof PLACE_PATHS, Path2D>
};

/** Where the map looks and how close, in plane cells. */
export interface Camera {
  x: number;
  y: number;
  z: number;
}

export const ZOOM = { min: 0.4, max: 2 } as const;

/** One plane cell on screen, in px, at zoom 1: the prototype's spacing. */
export const CELL_PX = 92;

export interface Scene {
  win: GameMapWindow;
  at: ReadonlyMap<string, GameCell>;
  byId: ReadonlyMap<RoomId, GameCell>;
  here: RoomId | null;
  /** A lost room's candidates, drawn as dimmer bright tiles. */
  candidates: readonly RoomId[];
  /** The route still to walk, the current room first. */
  trail: readonly RoomId[];
  stops: ReadonlySet<RoomId>;
  finds: ReadonlySet<RoomId>;
  /** Ways found by walking that the world database lacks. */
  found: ReadonlyArray<readonly [RoomId, RoomId]>;
  /** Other players where they were last seen, with when. */
  players: ReadonlyArray<{ name: string; room: RoomId; at: number }>;
  hover: RoomId | null;
  now: number;
}

export interface View {
  width: number;
  height: number;
  cam: Camera;
}

export function cellPx(cam: Camera): number {
  return CELL_PX * cam.z;
}

export function tileSize(cam: Camera): number {
  return 22 * Math.max(0.7, Math.min(1.4, cam.z));
}

export function toScreen(view: View, gx: number, gy: number): { x: number; y: number } {
  const k = cellPx(view.cam);
  return { x: view.width / 2 + (gx - view.cam.x) * k, y: view.height / 2 + (gy - view.cam.y) * k };
}

const onScreen = (view: View, p: { x: number; y: number }, margin = 60): boolean =>
  p.x > -margin && p.x < view.width + margin && p.y > -margin && p.y < view.height + margin;

/** Rooms further from where the character stands fade, so the near ones read first. */
function fadeOf(scene: Scene, cell: GameCell): number {
  const here = scene.here === null ? null : scene.byId.get(scene.here);
  if (!here) return 0.8;
  const d = Math.max(Math.abs(cell.gx - here.gx), Math.abs(cell.gy - here.gy));
  return Math.max(0.38, Math.min(1, 1.3 - d / 8));
}

export function hexA(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function area(scene: Scene, cell: GameCell): MapArea {
  return scene.win.areas[cell.area]!;
}

/** The corridors: joined neighbours, stubs to rooms the grid cannot place next door, and doors. */
function drawLinks(
  ctx: CanvasRenderingContext2D,
  view: View,
  scene: Scene,
  pal: GamePalette,
  alpha: number
): void {
  const k = cellPx(view.cam);
  ctx.lineCap = 'round';
  for (const cell of scene.win.cells) {
    const a = toScreen(view, cell.gx, cell.gy);
    if (!onScreen(view, a, k * 2)) continue;
    for (const [direction, to] of Object.entries(cell.to) as Array<[Direction, RoomId]>) {
      const step = STEP[direction];
      if (!step) continue;
      const neighbour = scene.at.get(cellKey(cell.gx + step.dx, cell.gy + step.dy));
      const joined = neighbour?.id === to;
      // Each pair once: from the end with the smaller id, or the only end.
      if (
        joined &&
        neighbour &&
        neighbour.id < cell.id &&
        neighbour.to[oppositeOf(direction)] === cell.id
      )
        continue;
      const mine = scene.here === cell.id || (joined && scene.here === neighbour!.id);
      const door = cell.blocked?.[direction] !== undefined;
      ctx.globalAlpha = alpha * (mine ? 1 : fadeOf(scene, cell));
      ctx.strokeStyle = door
        ? pal.door
        : mine
          ? hexA(pal.text, 0.75)
          : area(scene, cell).palette.path;
      ctx.lineWidth = (mine ? 3 : 2.5) * Math.min(1.2, view.cam.z);
      ctx.setLineDash(door ? [5, 5] : joined ? [] : [2, 5]);
      const end = joined
        ? toScreen(view, neighbour!.gx, neighbour!.gy)
        : { x: a.x + step.dx * k * 0.42, y: a.y + step.dy * k * 0.42 };
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

const OPPOSITES: Record<Direction, Direction> = {
  n: 's',
  s: 'n',
  e: 'w',
  w: 'e',
  ne: 'sw',
  sw: 'ne',
  nw: 'se',
  se: 'nw',
  u: 'd',
  d: 'u'
};
const oppositeOf = (direction: Direction): Direction => OPPOSITES[direction];

/** A line through rooms on the plane, joining only those that are placed. */
function strokeThrough(
  ctx: CanvasRenderingContext2D,
  view: View,
  scene: Scene,
  rooms: readonly RoomId[]
): void {
  ctx.beginPath();
  let drawing = false;
  for (const id of rooms) {
    const cell = scene.byId.get(id);
    if (!cell) {
      drawing = false;
      continue;
    }
    const p = toScreen(view, cell.gx, cell.gy);
    if (drawing) ctx.lineTo(p.x, p.y);
    else ctx.moveTo(p.x, p.y);
    drawing = true;
  }
  ctx.stroke();
}

function drawTrail(
  ctx: CanvasRenderingContext2D,
  view: View,
  scene: Scene,
  pal: GamePalette
): void {
  ctx.lineCap = 'round';
  for (const [from, to] of scene.found) {
    ctx.strokeStyle = hexA(pal.heal, 0.7);
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 5]);
    strokeThrough(ctx, view, scene, [from, to]);
  }
  if (scene.trail.length > 1) {
    ctx.strokeStyle = pal.accent;
    ctx.lineWidth = 4;
    ctx.setLineDash([2, 9]);
    strokeThrough(ctx, view, scene, scene.trail);
  }
  ctx.setLineDash([]);
}

function lairBadge(ctx: CanvasRenderingContext2D, pal: GamePalette, x: number, y: number): void {
  ctx.fillStyle = hexA(pal.hp, 0.18);
  ctx.beginPath();
  ctx.arc(x, y, 7.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = pal.hp;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  icon(ctx, PATHS.lair, x, y, 10, pal.hp);
}

export function icon(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  x: number,
  y: number,
  size: number,
  colour: string
): void {
  ctx.save();
  const k = size / 24;
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(k, k);
  ctx.fillStyle = colour;
  ctx.fill(path, 'evenodd');
  ctx.restore();
}

/** The small drawing a tile carries, by its area's motif. */
function motif(
  ctx: CanvasRenderingContext2D,
  m: MapArea['motif'],
  x: number,
  y: number,
  s: number
): void {
  const dot = (dx: number, dy: number, r: number) => {
    ctx.beginPath();
    ctx.arc(x + dx * s, y + dy * s, r * s, 0, Math.PI * 2);
    ctx.fill();
  };
  const bar = (dx: number, dy: number, w: number, h: number) =>
    ctx.fillRect(x + dx * s, y + dy * s, w * s, h * s);
  switch (m) {
    case 'forest':
    case 'jungle':
    case 'garden':
      dot(-0.14, 0.06, 0.14);
      dot(0.14, -0.06, 0.12);
      return;
    case 'field':
    case 'farm':
      bar(-0.25, -0.1, 0.5, 0.06);
      bar(-0.25, 0.1, 0.5, 0.06);
      return;
    case 'grave':
      bar(-0.04, -0.22, 0.08, 0.44);
      bar(-0.14, -0.08, 0.28, 0.07);
      return;
    case 'cave':
    case 'mine':
      ctx.beginPath();
      ctx.arc(x, y + 0.12 * s, 0.2 * s, Math.PI, 0);
      ctx.fill();
      return;
    case 'sewer':
    case 'water':
    case 'swamp':
      bar(-0.22, -0.06, 0.18, 0.06);
      bar(0.04, -0.06, 0.18, 0.06);
      bar(-0.1, 0.1, 0.18, 0.06);
      return;
    case 'castle':
    case 'tower':
    case 'dungeon':
      bar(-0.2, -0.02, 0.4, 0.22);
      bar(-0.2, -0.14, 0.08, 0.12);
      bar(-0.04, -0.14, 0.08, 0.12);
      bar(0.12, -0.14, 0.08, 0.12);
      return;
    case 'temple':
      bar(-0.03, -0.2, 0.06, 0.4);
      bar(-0.13, -0.08, 0.26, 0.06);
      return;
    case 'hills':
    case 'mountain':
      ctx.beginPath();
      ctx.moveTo(x - 0.24 * s, y + 0.14 * s);
      ctx.lineTo(x - 0.04 * s, y - 0.16 * s);
      ctx.lineTo(x + 0.08 * s, y);
      ctx.lineTo(x + 0.14 * s, y - 0.08 * s);
      ctx.lineTo(x + 0.26 * s, y + 0.14 * s);
      ctx.fill();
      return;
    case 'desert':
    case 'beach':
      dot(-0.12, 0.04, 0.04);
      dot(0.1, -0.08, 0.04);
      dot(0.06, 0.12, 0.04);
      return;
    case 'snow':
      dot(0, 0, 0.05);
      bar(-0.18, -0.02, 0.36, 0.04);
      bar(-0.02, -0.18, 0.04, 0.36);
      return;
    case 'fire':
      ctx.beginPath();
      ctx.moveTo(x, y - 0.2 * s);
      ctx.quadraticCurveTo(x + 0.18 * s, y + 0.02 * s, x, y + 0.18 * s);
      ctx.quadraticCurveTo(x - 0.18 * s, y + 0.02 * s, x, y - 0.2 * s);
      ctx.fill();
      return;
    case 'astral':
      dot(0, 0, 0.06);
      dot(-0.16, -0.12, 0.03);
      dot(0.15, 0.13, 0.03);
      return;
    case 'ruins':
      bar(-0.2, 0.04, 0.12, 0.14);
      bar(0.02, -0.06, 0.08, 0.24);
      return;
    case 'bridge':
    case 'road':
      bar(-0.25, -0.03, 0.5, 0.06);
      return;
    case 'ship':
      ctx.beginPath();
      ctx.moveTo(x - 0.22 * s, y + 0.02 * s);
      ctx.lineTo(x + 0.22 * s, y + 0.02 * s);
      ctx.lineTo(x + 0.14 * s, y + 0.16 * s);
      ctx.lineTo(x - 0.14 * s, y + 0.16 * s);
      ctx.fill();
      return;
    case 'town':
    case 'building':
      return;
    default: {
      const never: never = m;
      return never;
    }
  }
}

function drawTile(
  ctx: CanvasRenderingContext2D,
  view: View,
  scene: Scene,
  pal: GamePalette,
  cell: GameCell,
  alpha: number
): void {
  const p = toScreen(view, cell.gx, cell.gy);
  if (!onScreen(view, p)) return;
  const own = area(scene, cell);
  const hover = scene.hover === cell.id;
  ctx.globalAlpha = alpha * fadeOf(scene, cell);
  if (cell.icon) {
    const s = tileSize(view.cam) * 1.3;
    const colour = pal.places[placeTone(cell.icon)];
    ctx.save();
    ctx.shadowColor = colour;
    ctx.shadowBlur = 14;
    roundRect(ctx, p.x - s / 2, p.y - s / 2, s, s, s * 0.3);
    ctx.fillStyle = hexA(colour, 0.2);
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = hover ? 2.2 : 1.5;
    ctx.strokeStyle = hover ? pal.text : colour;
    ctx.stroke();
    icon(ctx, PATHS.places[cell.icon], p.x, p.y, s * 0.62, colour);
    if (cell.lair) lairBadge(ctx, pal, p.x + s / 2, p.y - s / 2);
  } else {
    const s = tileSize(view.cam);
    roundRect(ctx, p.x - s / 2, p.y - s / 2, s, s, s * 0.28);
    ctx.fillStyle = own.palette.ground;
    ctx.fill();
    ctx.lineWidth = hover ? 2 : 1.2;
    ctx.strokeStyle = hover ? pal.text : own.palette.edge;
    ctx.stroke();
    ctx.fillStyle = own.palette.edge;
    motif(ctx, own.motif, p.x, p.y, s);
    if (cell.lair) lairBadge(ctx, pal, p.x + s / 2, p.y - s / 2);
    if (cell.vertical !== null) {
      ctx.fillStyle = hexA(pal.text, 0.7);
      ctx.font = `600 10px ${pal.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        cell.vertical === 'both' ? '⇅' : cell.vertical === 'up' ? '↑' : '↓',
        p.x,
        p.y + 1
      );
    }
  }
  const s = tileSize(view.cam);
  if (scene.stops.has(cell.id)) {
    ctx.strokeStyle = pal.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, s * 0.85, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (scene.finds.has(cell.id)) {
    ctx.fillStyle = pal.heal;
    ctx.beginPath();
    ctx.arc(p.x - s / 2, p.y + s / 2, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  if (cell.safe) {
    ctx.strokeStyle = hexA(pal.heal, 0.6);
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    roundRect(ctx, p.x - s / 2 - 3, p.y - s / 2 - 3, s + 6, s + 6, s * 0.34);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;
}

/** Where each player was last seen, under the room, fading with age. */
function drawPlayers(
  ctx: CanvasRenderingContext2D,
  view: View,
  scene: Scene,
  pal: GamePalette
): void {
  const byRoom = new Map<RoomId, Scene['players'][number][]>();
  for (const one of scene.players) {
    if (one.room === scene.here) continue;
    const list = byRoom.get(one.room);
    if (list) list.push(one);
    else byRoom.set(one.room, [one]);
  }
  const s = tileSize(view.cam);
  for (const [room, list] of byRoom) {
    const cell = scene.byId.get(room);
    if (!cell) continue;
    const p = toScreen(view, cell.gx, cell.gy);
    if (!onScreen(view, p)) continue;
    list.forEach((one, index) => {
      const minutes = (scene.now - one.at) / 60_000;
      ctx.globalAlpha = Math.max(0.45, Math.min(1, 1 - minutes / 20));
      const x = p.x - s / 2 - 2;
      const y = p.y + s / 2 + 2 + index * 18;
      ctx.fillStyle = hexA(pal.player, 0.15);
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = pal.player;
      ctx.lineWidth = 1.3;
      ctx.stroke();
      icon(ctx, PATHS.player, x, y, 11, pal.player);
      const label = minutes >= 1 ? `${one.name} · ${Math.round(minutes)}m` : one.name;
      ctx.font = `600 11px ${pal.font}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4;
      ctx.strokeStyle = pal.ground;
      ctx.strokeText(label, x - 12, y);
      ctx.fillStyle = pal.player;
      ctx.fillText(label, x - 12, y);
    });
  }
  ctx.globalAlpha = 1;
}

/** Labels that fit: area names faint and spaced, stretches, landmarks, then single rooms near by. */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  view: View,
  scene: Scene,
  pal: GamePalette,
  keepClear: { x: number; y: number; r: number } | null
): void {
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
  const free = (b: { x: number; y: number; w: number; h: number }) =>
    !placed.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y) &&
    (keepClear === null ||
      Math.hypot(b.x + b.w / 2 - keepClear.x, b.y + b.h / 2 - keepClear.y) > keepClear.r + 60);
  ctx.textBaseline = 'middle';
  const draw = (
    text: string,
    gx: number,
    gy: number,
    font: string,
    colour: string,
    alpha: number,
    beside: boolean,
    dy = 0
  ) => {
    const p = toScreen(view, gx, gy);
    if (!onScreen(view, p, 200)) return;
    ctx.font = font;
    const w = ctx.measureText(text).width;
    const x = beside ? p.x + tileSize(view.cam) / 2 + 8 : p.x - w / 2;
    const y = p.y + dy;
    const box = { x: x - 4, y: y - 9, w: w + 8, h: 18 };
    if (!free(box)) return;
    placed.push(box);
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'left';
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = pal.ground;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = colour;
    ctx.fillText(text, x, y);
  };
  const of = (label: MapLabel) => scene.win.areas[label.area]!;
  for (const label of scene.win.labels)
    if (label.kind === 'area')
      draw(
        label.text.toUpperCase(),
        label.gx,
        label.gy,
        `600 12px ${pal.font}`,
        of(label).palette.glow,
        0.7,
        false,
        -28
      );
  for (const label of scene.win.labels)
    if (label.kind === 'landmark')
      draw(label.text, label.gx, label.gy, `600 11.5px ${pal.font}`, pal.text, 0.95, true);
  if (view.cam.z > 0.6)
    for (const label of scene.win.labels)
      if (label.kind === 'stretch')
        draw(label.text, label.gx, label.gy, `500 11px ${pal.font}`, pal.muted, 0.9, false, 24);
  const here = scene.here === null ? null : scene.byId.get(scene.here);
  for (const cell of scene.win.cells) {
    if (!cell.named && !cell.icon) continue;
    const near = here ? Math.max(Math.abs(cell.gx - here.gx), Math.abs(cell.gy - here.gy)) : 99;
    if (view.cam.z > 1.15 || near <= (cell.icon ? 4 : 2) || scene.hover === cell.id) {
      const colour = cell.icon ? pal.places[placeTone(cell.icon)] : pal.text;
      draw(
        cell.name,
        cell.gx,
        cell.gy,
        `${cell.icon ? 600 : 500} 11.5px ${pal.font}`,
        colour,
        1,
        true
      );
    }
  }
  ctx.globalAlpha = 1;
}

/** The current room: the brightest thing on the map, and the lost room's candidates dimmer. */
function drawHere(ctx: CanvasRenderingContext2D, view: View, scene: Scene, pal: GamePalette): void {
  const glow = (id: RoomId, strength: number) => {
    const cell = scene.byId.get(id);
    if (!cell) return;
    const p = toScreen(view, cell.gx, cell.gy);
    const s = tileSize(view.cam) * 1.25;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, s * 2.6);
    g.addColorStop(0, hexA(pal.accent, 0.55 * strength));
    g.addColorStop(1, hexA(pal.accent, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, s * 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = strength;
    roundRect(ctx, p.x - s / 2, p.y - s / 2, s, s, s * 0.28);
    ctx.fillStyle = pal.accent;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = pal.text;
    ctx.stroke();
    ctx.globalAlpha = 1;
  };
  for (const id of scene.candidates) glow(id, 0.45);
  if (scene.here !== null) glow(scene.here, 1);
}

/**
 * The whole map layer. `keepClear` is the arena, which labels stay out of; the
 * arena itself is drawn over this by `drawArena`.
 */
export function drawWorld(
  ctx: CanvasRenderingContext2D,
  view: View,
  scene: Scene,
  pal: GamePalette,
  keepClear: { x: number; y: number; r: number } | null,
  alpha = 1
): void {
  drawLinks(ctx, view, scene, pal, alpha);
  drawTrail(ctx, view, scene, pal);
  for (const cell of scene.win.cells)
    if (cell.id !== scene.here) drawTile(ctx, view, scene, pal, cell, alpha);
  drawPlayers(ctx, view, scene, pal);
  if (alpha === 1) drawLabels(ctx, view, scene, pal, keepClear);
  drawHere(ctx, view, scene, pal);
}

/** The faint dot grid behind everything. */
export function drawGround(ctx: CanvasRenderingContext2D, view: View, pal: GamePalette): void {
  ctx.fillStyle = pal.ground;
  ctx.fillRect(0, 0, view.width, view.height);
  const k = cellPx(view.cam) / 2;
  const ox = (((view.width / 2 - view.cam.x * k * 2) % k) + k) % k;
  const oy = (((view.height / 2 - view.cam.y * k * 2) % k) + k) % k;
  ctx.fillStyle = hexA(pal.text, 0.03);
  for (let x = ox; x < view.width; x += k)
    for (let y = oy; y < view.height; y += k) ctx.fillRect(x - 1, y - 1, 2, 2);
}

export function drawVignette(ctx: CanvasRenderingContext2D, view: View, pal: GamePalette): void {
  const { width: w, height: h } = view;
  const g = ctx.createRadialGradient(
    w / 2,
    h / 2,
    Math.min(w, h) * 0.35,
    w / 2,
    h / 2,
    Math.max(w, h) * 0.75
  );
  g.addColorStop(0, hexA(pal.shade, 0));
  g.addColorStop(1, hexA(pal.shade, 0.75));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** The room nearest a point on screen, within reach of a pointer. */
export function roomAt(view: View, scene: Scene, x: number, y: number): GameCell | null {
  let best: GameCell | null = null;
  let distance = 22;
  for (const cell of scene.win.cells) {
    const p = toScreen(view, cell.gx, cell.gy);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < distance) {
      distance = d;
      best = cell;
    }
  }
  return best;
}
