/**
 * The room you stand in, as the game view draws it (todo 140): a see-through
 * round arena over its tile. The character stands on its own room's square at
 * the middle, see-through; the party in a half circle behind it to the left and
 * monsters in one to the right. Each ring is its health (a monster's its wound
 * band, the target's only; others are unknown, never full), an inner ring for
 * mana or kai. Exits are
 * discs on the rim at their bearing with the next room's name, and each blow
 * is a line from attacker to target that fades with the damage.
 */
import type { MapArea } from '@shared/gameMap';
import { STEP } from '@shared/map';
import type { Direction } from '@shared/world';
import type { Blow } from '../../lib/gameBlows';
import type { ArenaExit, ArenaToken } from '../../lib/gameArena';
import { hexA, icon, PATHS, type GamePalette } from './drawWorld';

export interface ArenaRoom {
  name: string;
  /** The line under the arena: the fight, the light, the lair. */
  facts: string;
  /** The place's banner over the name, if it is one. */
  place: { label: string; colour: string; path: Path2D } | null;
  area: MapArea;
  dark: boolean;
  engaged: boolean;
  docked: boolean;
  /** The line under the facts while the map is detached. */
  detached: string | null;
}

export interface Disc {
  x: number;
  y: number;
  r: number;
}

/** A blow in flight, with when it started. */
export interface Flight extends Blow {
  at: number;
}

/** How long a blow is drawn, ms: the line flies, the number rises, both fade. */
export const FLIGHT_MS = 1300;
const FLY_MS = 200;
/** After it lands: the line fades, the target's ring shakes, the ripple spreads. */
const LINE_FADE_MS = 500;
const STRUCK_MS = 260;
const RIPPLE_MS = 350;
/** The number: it grows in, holds, then fades. */
const NUMBER_IN_MS = 120;
const NUMBER_HOLD_MS = 600;
const NUMBER_OUT_MS = 400;
const NUMBER_GROW_MS = 140;

/** Where each token stands: the character at the middle, the party on an arc to the left, monsters to the right. */
export function standings(
  disc: Disc,
  tokens: readonly ArenaToken[]
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const place = (list: readonly ArenaToken[], from: number, to: number, reach: number) =>
    list.forEach((token, index) => {
      const t = list.length === 1 ? 0.5 : index / (list.length - 1);
      const angle = ((from + (to - from) * t) * Math.PI) / 180;
      out.set(token.key, {
        x: disc.x + Math.cos(angle) * disc.r * reach,
        y: disc.y + Math.sin(angle) * disc.r * reach
      });
    });
  // The character stands on its own room's square, at the middle (user, 2026-10-14).
  for (const token of tokens) if (token.self) out.set(token.key, { x: disc.x, y: disc.y });
  // The party in a half circle behind it to the left, monsters in one to the right.
  place(
    tokens.filter((one) => one.side === 'party' && !one.self),
    235,
    125,
    0.55
  );
  place(
    tokens.filter((one) => one.side === 'foe'),
    -55,
    55,
    0.58
  );
  // Other players below, apart from both.
  place(
    tokens.filter((one) => one.side === 'player'),
    112,
    68,
    0.78
  );
  return out;
}

/** Up and down leave the plane, so their discs sit off the rim, high and low on the east side. */
const OFF_PLANE: Partial<Record<Direction, number>> = {
  u: (-68 * Math.PI) / 180,
  d: (68 * Math.PI) / 180
};

/** Where an exit sits on the rim: its compass bearing on the plane, as `STEP` points it. */
function bearing(direction: Direction): number {
  const step = STEP[direction];
  return step === null ? (OFF_PLANE[direction] ?? 0) : Math.atan2(step.dy, step.dx);
}

export interface ExitSpot {
  direction: Direction;
  x: number;
  y: number;
  box: { x: number; y: number; w: number; h: number };
}

function ring(
  ctx: CanvasRenderingContext2D,
  radius: number,
  share: number | null,
  colour: string,
  width: number,
  track: string
): void {
  ctx.lineWidth = width;
  ctx.strokeStyle = track;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.stroke();
  if (share === null) return;
  ctx.strokeStyle = colour;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(0, 0, radius, -Math.PI / 2, -Math.PI / 2 + Math.max(0.02, share) * Math.PI * 2);
  ctx.stroke();
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function drawToken(
  ctx: CanvasRenderingContext2D,
  pal: GamePalette,
  token: ArenaToken,
  at: { x: number; y: number },
  radius: number,
  struck: number
): void {
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.scale(1 + struck * 0.12, 1 + struck * 0.12);
  const track = hexA(pal.text, 0.12);
  if (token.side === 'foe') {
    if (token.target) {
      ctx.strokeStyle = pal.accent;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.arc(0, 0, radius + 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.shadowColor = token.hostile ? hexA(pal.hp, 0.5) : pal.shade;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.roundRect(-radius, -radius, radius * 2, radius * 2, 9);
    ctx.fillStyle = pal.ink;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = token.hostile ? hexA(pal.hp, 0.7) : hexA(pal.muted, 0.6);
    ctx.stroke();
    // The wound band: certain to `lo`, maybe to `hi`. Unknown is a dashed ring, never a full one.
    ctx.lineWidth = 3.5;
    if (token.band === null) {
      ctx.setLineDash([3, 5]);
      ctx.strokeStyle = hexA(pal.text, 0.25);
      ctx.beginPath();
      ctx.arc(0, 0, radius + 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      const angle = (share: number) => -Math.PI / 2 + share * Math.PI * 2;
      ctx.strokeStyle = track;
      ctx.beginPath();
      ctx.arc(0, 0, radius + 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineCap = 'round';
      if (token.band.lo > 0) {
        ctx.strokeStyle = pal.hp;
        ctx.beginPath();
        ctx.arc(0, 0, radius + 5, angle(0), angle(token.band.lo));
        ctx.stroke();
      }
      if (token.band.hi > token.band.lo) {
        ctx.strokeStyle = hexA(pal.hp, 0.35);
        ctx.beginPath();
        ctx.arc(0, 0, radius + 5, angle(token.band.lo), angle(token.band.hi));
        ctx.stroke();
      }
    }
    ctx.fillStyle = token.hostile ? pal.hp : pal.muted;
  } else {
    const colour = token.side === 'player' ? pal.player : token.self ? pal.accent : pal.heal;
    // The character's own token is see-through: its room's square shows under it.
    ctx.shadowColor = pal.shade;
    ctx.shadowBlur = token.self ? 0 : 14;
    ctx.fillStyle = token.self ? hexA(pal.ink, 0.35) : pal.ink;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    if (token.side === 'player') {
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
      icon(ctx, PATHS.player, at.x, at.y, radius * 1.1, colour);
      label(ctx, pal, token.name, at.x, at.y + radius + 4, colour);
      return;
    }
    const low = token.health !== null && token.health < 0.35;
    ring(ctx, radius + 4, token.health, low ? pal.hp : colour, 3.5, track);
    if (token.pool !== undefined) {
      if (token.pool.share === null) {
        ctx.setLineDash([2, 3]);
        ring(ctx, radius + 9, null, colour, 2, track);
        ctx.setLineDash([]);
      } else
        ring(ctx, radius + 9, token.pool.share, token.pool.kai ? pal.kai : pal.mana, 2.2, track);
    }
    ctx.fillStyle = colour;
  }
  ctx.font = `600 ${Math.round(radius * 0.8)}px ${pal.font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    token.side === 'foe' ? initials(token.name) : (token.name[0] ?? '?').toUpperCase(),
    0,
    1
  );
  if (struck > 0) {
    ctx.fillStyle = hexA(pal.text, struck * 0.45);
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  if (token.poisoned) {
    ctx.translate(radius * 0.8, -radius * 0.8);
    ctx.fillStyle = pal.ink;
    ctx.beginPath();
    ctx.arc(0, 0, 8.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    icon(ctx, PATHS.drop, at.x + radius * 0.8, at.y - radius * 0.8, 12, pal.poison);
  } else ctx.restore();
  label(ctx, pal, token.name, at.x, at.y + radius + (token.side === 'foe' ? 10 : 12), pal.text);
}

function label(
  ctx: CanvasRenderingContext2D,
  pal: GamePalette,
  text: string,
  x: number,
  y: number,
  colour: string
): void {
  ctx.font = `500 11px ${pal.font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 3;
  ctx.strokeStyle = hexA(pal.shade, 0.75);
  ctx.strokeText(text, x, y);
  ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
}

/** The arena's floor, rim, banner, name and facts; under the tokens. */
export function drawFloor(
  ctx: CanvasRenderingContext2D,
  pal: GamePalette,
  disc: Disc,
  room: ArenaRoom
): void {
  ctx.save();
  ctx.shadowColor = hexA(pal.shade, 0.6);
  ctx.shadowBlur = 30;
  const floor = ctx.createRadialGradient(disc.x, disc.y - disc.r * 0.3, 0, disc.x, disc.y, disc.r);
  floor.addColorStop(0, hexA(room.area.palette.edge, 0.55));
  floor.addColorStop(1, hexA(room.area.palette.ground, 0.78));
  ctx.fillStyle = floor;
  ctx.beginPath();
  ctx.arc(disc.x, disc.y, disc.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (room.dark) {
    const dark = ctx.createRadialGradient(disc.x, disc.y, disc.r * 0.45, disc.x, disc.y, disc.r);
    dark.addColorStop(0, hexA(pal.shade, 0));
    dark.addColorStop(1, hexA(pal.shade, 0.5));
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.arc(disc.x, disc.y, disc.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = room.engaged ? hexA(pal.hp, 0.6) : hexA(pal.text, 0.25);
  ctx.beginPath();
  ctx.arc(disc.x, disc.y, disc.r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (room.place) {
    const text = room.place.label.toUpperCase();
    ctx.font = `600 9.5px ${pal.font}`;
    const width = ctx.measureText(text).width + 28;
    const y = disc.y - disc.r * 0.55;
    ctx.beginPath();
    ctx.roundRect(disc.x - width / 2, y - 10, width, 20, 10);
    ctx.fillStyle = hexA(room.place.colour, 0.18);
    ctx.fill();
    ctx.strokeStyle = hexA(room.place.colour, 0.6);
    ctx.lineWidth = 1;
    ctx.stroke();
    icon(ctx, room.place.path, disc.x - width / 2 + 13, y, 12, room.place.colour);
    ctx.fillStyle = room.place.colour;
    ctx.fillText(text, disc.x + 8, y + 0.5);
  }
  ctx.font = `600 13.5px ${pal.font}`;
  ctx.lineWidth = 4;
  ctx.strokeStyle = hexA(pal.shade, 0.6);
  ctx.strokeText(room.name, disc.x, disc.y - disc.r * 0.72);
  ctx.fillStyle = pal.text;
  ctx.fillText(room.name, disc.x, disc.y - disc.r * 0.72);
  ctx.font = `500 10.5px ${pal.font}`;
  const factsAt = disc.y + disc.r + 62;
  ctx.strokeText(room.facts, disc.x, factsAt);
  ctx.fillStyle = hexA(pal.text, 0.65);
  ctx.fillText(room.facts, disc.x, factsAt);
  if (room.detached !== null) {
    ctx.fillStyle = pal.accent;
    ctx.font = `600 10px ${pal.font}`;
    ctx.fillText(room.detached, disc.x, factsAt + 16);
  }
}

/** A compass exit's disc, px, centred on the arena's rim; the ring round the room clears it. */
export const EXIT_RADIUS = 15;

/** The exits on the rim; returns where each was drawn, for the pointer. */
export function drawExits(
  ctx: CanvasRenderingContext2D,
  pal: GamePalette,
  disc: Disc,
  exits: readonly ArenaExit[],
  hover: Direction | null
): ExitSpot[] {
  const spots: ExitSpot[] = [];
  for (const exit of exits) {
    const angle = bearing(exit.direction);
    const out = exit.direction === 'u' || exit.direction === 'd' ? 28 : 0;
    const x = disc.x + Math.cos(angle) * (disc.r + out);
    const y = disc.y + Math.sin(angle) * (disc.r + out);
    const lit = hover === exit.direction;
    ctx.save();
    ctx.shadowColor = lit || exit.door ? hexA(pal.accent, 0.8) : hexA(pal.text, 0.55);
    ctx.shadowBlur = 14;
    ctx.fillStyle = lit ? pal.accent : exit.door ? pal.door : pal.text;
    ctx.beginPath();
    ctx.arc(x, y, EXIT_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = pal.ink;
    ctx.font = `700 12px ${pal.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(exit.direction, x, y + 0.5);
    if (exit.label === '') {
      spots.push({ direction: exit.direction, x, y, box: { x, y, w: 0, h: 0 } });
      continue;
    }
    ctx.font = `500 11.5px ${pal.font}`;
    const w = ctx.measureText(exit.label).width + 16;
    const h = 21;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const lx = Math.abs(c) < 0.3 ? x - w / 2 : c > 0 ? x + 21 : x - 21 - w;
    const ly = Math.abs(c) < 0.3 ? (s < 0 ? y - 21 - h : y + 21) : y - h / 2;
    ctx.beginPath();
    ctx.roundRect(lx, ly, w, h, 7);
    ctx.fillStyle = hexA(pal.ink, 0.88);
    ctx.fill();
    ctx.strokeStyle = lit ? pal.accent : exit.door ? hexA(pal.door, 0.6) : hexA(pal.text, 0.22);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = lit ? pal.accent : exit.door ? pal.door : pal.text;
    ctx.textAlign = 'left';
    ctx.fillText(exit.label, lx + 8, ly + h / 2 + 0.5);
    spots.push({ direction: exit.direction, x, y, box: { x: lx, y: ly, w, h } });
  }
  return spots;
}

/** Every token; `struck` says how recently a blow landed on each. */
export function drawTokens(
  ctx: CanvasRenderingContext2D,
  pal: GamePalette,
  disc: Disc,
  tokens: readonly ArenaToken[],
  at: ReadonlyMap<string, { x: number; y: number }>,
  struck: ReadonlyMap<string, number>
): void {
  const scale = disc.r / 110;
  for (const token of tokens) {
    const p = at.get(token.key);
    if (!p) continue;
    const radius = (token.self ? 22 : token.side === 'player' ? 15 : 18) * scale;
    drawToken(ctx, pal, token, p, radius, struck.get(token.key) ?? 0);
  }
}

/**
 * The blows in flight: a curved line, a number rising off the target, a heal
 * in green. Returns the ones still drawing and how recently each token was
 * struck, for the shake of its ring.
 */
export function drawFlights(
  ctx: CanvasRenderingContext2D,
  pal: GamePalette,
  flights: readonly Flight[],
  at: ReadonlyMap<string, { x: number; y: number }>,
  now: number
): { live: Flight[]; struck: Map<string, number> } {
  const live: Flight[] = [];
  const struck = new Map<string, number>();
  for (const flight of flights) {
    const t = now - flight.at;
    const a = at.get(flight.from);
    const b = at.get(flight.to);
    if (!a || !b || t > FLIGHT_MS) continue;
    live.push(flight);
    const colour = flight.kind === 'heal' ? pal.heal : flight.from === 'self' ? pal.accent : pal.hp;
    const k = Math.min(1, t / FLY_MS);
    const ease = 1 - (1 - k) ** 3;
    const bend = (flight.kind === 'heal' ? -40 : 28) * (a.x < b.x ? 1 : -1);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2 - bend;
    const qx = (u: number) => (1 - u) * (1 - u) * a.x + 2 * (1 - u) * u * mx + u * u * b.x;
    const qy = (u: number) => (1 - u) * (1 - u) * a.y + 2 * (1 - u) * u * my + u * u * b.y;
    const fade = t < FLY_MS ? 1 : Math.max(0, 1 - (t - FLY_MS) / LINE_FADE_MS);
    if (fade > 0) {
      ctx.globalAlpha = fade;
      ctx.strokeStyle = colour;
      ctx.lineCap = 'round';
      ctx.lineWidth = flight.kind === 'miss' ? 1.2 : 2.2;
      if (flight.kind === 'miss') ctx.setLineDash([2, 5]);
      ctx.beginPath();
      const steps = 18;
      for (let s = 0; s <= steps * ease; s += 1) {
        const u = s / steps;
        if (s === 0) ctx.moveTo(qx(u), qy(u));
        else ctx.lineTo(qx(u), qy(u));
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (t >= FLY_MS && flight.kind !== 'miss') {
      const since = t - FLY_MS;
      struck.set(
        flight.to,
        Math.max(struck.get(flight.to) ?? 0, Math.max(0, 1 - since / STRUCK_MS))
      );
      ctx.globalAlpha = Math.max(0, 1 - since / RIPPLE_MS);
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(b.x, b.y, 26 + since / 8, 0, Math.PI * 2);
      ctx.stroke();
    }
    const words =
      flight.kind === 'miss' ? null : flight.amount === null ? null : String(flight.amount);
    if (words !== null && t >= FLY_MS * 0.8) {
      const since = t - FLY_MS * 0.8;
      ctx.globalAlpha = Math.max(
        0,
        Math.min(
          1,
          since < NUMBER_IN_MS ? since / NUMBER_IN_MS : 1 - (since - NUMBER_HOLD_MS) / NUMBER_OUT_MS
        )
      );
      const size = Math.round(
        17 * (since < NUMBER_GROW_MS ? 1.35 - (since / NUMBER_GROW_MS) * 0.35 : 1)
      );
      ctx.font = `700 ${size}px ${pal.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4;
      ctx.strokeStyle = hexA(pal.shade, 0.8);
      const y = b.y - 34 - since / 28;
      ctx.strokeText(words, b.x + 18, y);
      ctx.fillStyle = flight.kind === 'heal' ? pal.heal : flight.to === 'self' ? pal.hp : pal.text;
      ctx.fillText(words, b.x + 18, y);
    }
    ctx.globalAlpha = 1;
  }
  return { live, struck };
}
