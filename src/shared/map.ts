/**
 * A local map, laid out.
 *
 * The realm data has no coordinates — only which exit leads where — so a map
 * has to be *derived* by walking directions outward from where the character is
 * standing, which is what every MUD mapper has always done. The result is a
 * grid position per room, in cells, relative to the centre.
 *
 * Dependency-free: the main process lays it out because it owns the graph, the
 * renderer draws it — and `layoutMap` below is here rather than beside the card
 * because it is a pure function of the layout, and a renderer test that reached
 * into `src/main` to build one would be crossing a boundary the project keeps
 * on purpose.
 */
import { OPPOSITE, type Direction, type MapObstacle, type RoomId, type ShopKind } from './world';

export type { MapObstacle };

/** How a room leaves the plane. `null` when it does not. */
export type Vertical = 'up' | 'down' | 'both' | null;

export interface MapCell {
  id: RoomId;
  name: string;
  /** Cells east of the centre. Negative is west. */
  gx: number;
  /** Cells south of the centre. Negative is north. */
  gy: number;
  /** Directions the realm data gives this room, for drawing the links. */
  exits: Direction[];
  /** What stands in the way, per direction. Absent where the way is open. */
  blocked?: Partial<Record<Direction, MapObstacle>>;
  /**
   * Which way this room leaves the plane, if it does.
   *
   * Not a boolean: a room with only a way down was drawn with an arrow pointing
   * up, which is a map telling you the opposite of the truth. Plenty of rooms
   * have both.
   */
  vertical: Vertical;
  shop: boolean;
  /**
   * What kind of place the shop is, when the realm says. A bank is drawn
   * differently from a shop — it is where the money is, not where it goes —
   * and the map is read for exactly that at a glance.
   */
  place?: ShopKind;
  lair: boolean;
}

export interface LocalMap {
  centre: RoomId | null;
  cells: MapCell[];
  /**
   * Rooms reached but not placed, because the cell was already taken.
   *
   * A MUD is not Euclidean: two exits can lead to the same place, and a corridor
   * can bend back over itself. Reporting the count is honest — the map is a
   * projection, and saying how much it could not show beats drawing a confident
   * picture that is wrong.
   */
  dropped: number;
}

export const EMPTY_MAP: LocalMap = { centre: null, cells: [], dropped: 0 };

/** How a direction moves the pen, in cells. */
export const STEP: Record<Direction, { dx: number; dy: number } | null> = {
  n: { dx: 0, dy: -1 },
  s: { dx: 0, dy: 1 },
  e: { dx: 1, dy: 0 },
  w: { dx: -1, dy: 0 },
  ne: { dx: 1, dy: -1 },
  nw: { dx: -1, dy: -1 },
  se: { dx: 1, dy: 1 },
  sw: { dx: -1, dy: 1 },
  // Up and down leave the plane. A map that placed them on it would draw two
  // different rooms in one square and call it a floor plan.
  u: null,
  d: null
};

/**
 * Turns a laid-out map into something drawable, in map units.
 *
 * The map is drawn as vector shapes rather than as characters. That was the
 * other way round to begin with, on the argument that the game lays its own
 * maps out in character cells — but this map is not the game's. It is *derived*
 * from the realm data by the client, and nothing about it ever crosses the
 * wire, so the character-cell rule that governs the console does not reach it.
 * It is chrome, and chrome follows the design language: tonal fills, a themed
 * palette, and shapes that can say "shop" without spending a glyph on it.
 *
 * Emitted in abstract units with the origin at the top-left of the extent; the
 * card scales them with a viewBox, so nothing here needs to know how large the
 * card is.
 */

/** Distance between neighbouring rooms. Rooms are drawn much smaller. */
export const MAP_CELL = 10;

/**
 * The middle of the density slider, and what the map is drawn at until
 * somebody moves it.
 *
 * A fraction rather than a room count, because what the slider actually
 * chooses is *how small a room may be drawn* — the count still comes from the
 * card's own measured box, so a map dragged twice as big still shows more of
 * the realm at every setting. See `roomPixelsFor`.
 */
export const DEFAULT_MAP_DENSITY = 0.5;

/**
 * How many pixels one room may have, at this density.
 *
 * The slider's two ends are the tuning file's (`view.mapRoomPixelsSparse` and
 * `mapRoomPixelsDense`) and are chosen so that a **rail-sized** card spans the
 * 5×5 to 20×20 the request asked for — that is the card the setting is about,
 * and a float shows correspondingly more at every setting, which is the
 * behaviour it already had and which nothing here takes away.
 *
 * `0` is the least dense end and `1` the most, which is the direction a slider
 * labelled *density* reads. Out-of-range values are clamped rather than
 * refused: this comes out of `localStorage`, and a map that drew nothing
 * because a stored fraction was 1.2 would be a card broken by its own history.
 *
 * Pure and here rather than beside the card, for `radiusForBox`' reason: it is
 * a function of the layout with edge cases worth testing, and the suite runs
 * with no DOM.
 */
export function roomPixelsFor(density: number, sparse: number, dense: number): number {
  const at = Number.isFinite(density) ? Math.max(0, Math.min(1, density)) : DEFAULT_MAP_DENSITY;
  return sparse + at * (dense - sparse);
}

/**
 * How far out to walk for a card of this size.
 *
 * The map used to ask for five rooms in every direction whatever it was drawn
 * in, and the viewBox scaled whatever came back to fit. On the rail that is
 * right — the card has a declared height and does not move. Dragged out to a
 * float and made twice as big, it drew *the same six rooms twice as large*:
 * the picture grew and the neighbourhood did not, which is the one thing a map
 * being made bigger is for.
 *
 * So the radius is **measured**, not chosen. `width` and `height` are the
 * laid-out box in pixels; `perRoom` is how much room one cell wants to stay
 * pointable-at. The result is the count of rooms that fit across the *smaller*
 * side, halved because a radius reaches both ways from the centre.
 *
 * Pure, and here rather than beside the card, for the reason `layoutMap` is:
 * this is a function of the layout, it has edge cases worth testing, and the
 * suite runs with no DOM to measure anything in.
 *
 * The smaller side, deliberately. A wide short card that asked for the radius
 * its *width* could show would fetch rooms the height then has to scale away —
 * the viewBox fits the whole extent, so the constraining side is the one that
 * decides what is legible.
 *
 * A box with no size yet — the first paint, a card in a collapsed pane — is
 * `min`, never zero: a map that fetched nothing while it was being measured
 * would flash empty on every mount.
 */
export function radiusForBox(
  width: number,
  height: number,
  perRoom: number,
  min: number,
  max: number
): number {
  const side = Math.min(width, height);
  if (!Number.isFinite(side) || side <= 0 || !Number.isFinite(perRoom) || perRoom <= 0) return min;
  // Rooms across the box, then out from the middle.
  const across = side / perRoom;
  return Math.max(min, Math.min(max, Math.floor(across / 2)));
}

/** What a room is, for choosing its shape and colour. First match wins. */
export type RoomKind = 'here' | 'lair' | 'bank' | 'shop' | 'stairs' | 'room';

export interface MapNode {
  id: RoomId;
  name: string;
  x: number;
  y: number;
  kind: RoomKind;
  /** True for the room the character is standing in. */
  here: boolean;
  /** Which way this room also leads, which a plane cannot show. */
  vertical: Vertical;
}

/** A corridor between two rooms the map is showing. */
export interface MapLink {
  /**
   * The two rooms it joins.
   *
   * Coordinates alone were enough while a corridor was only ever drawn, and
   * are not enough to answer *is the route walking along this one* — which is
   * a question about rooms. Unordered: `layoutMap` draws one line per pair, so
   * which end is which says nothing about direction.
   */
  from: RoomId;
  to: RoomId;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /**
   * What stands in the way, if anything.
   *
   * Drawn on the corridor rather than on either room, because a door belongs to
   * the passage: the rooms on both sides are ordinary.
   */
  obstacle?: MapObstacle;
}

export interface MapDrawing {
  nodes: MapNode[];
  links: MapLink[];
  /** Extent in map units, for the viewBox. */
  width: number;
  height: number;
}

function kindOf(cell: MapCell, here: boolean): RoomKind {
  if (here) return 'here';
  if (cell.lair) return 'lair';
  if (cell.place === 'bank') return 'bank';
  if (cell.shop) return 'shop';
  if (cell.vertical !== null) return 'stairs';
  return 'room';
}

export function layoutMap(map: LocalMap): MapDrawing {
  if (map.cells.length === 0) return { nodes: [], links: [], width: 0, height: 0 };

  const minX = Math.min(...map.cells.map((cell) => cell.gx));
  const maxX = Math.max(...map.cells.map((cell) => cell.gx));
  const minY = Math.min(...map.cells.map((cell) => cell.gy));
  const maxY = Math.max(...map.cells.map((cell) => cell.gy));

  const at = (cell: { gx: number; gy: number }) => ({
    x: (cell.gx - minX) * MAP_CELL,
    y: (cell.gy - minY) * MAP_CELL
  });

  const placed = new Map(map.cells.map((cell) => [`${cell.gx},${cell.gy}`, cell]));
  const links: MapLink[] = [];
  const seen = new Set<string>();

  for (const cell of map.cells) {
    for (const direction of cell.exits) {
      const step = STEP[direction as Direction];
      // Up and down are not on this plane; the room's own mark says so instead.
      if (!step) continue;
      const neighbour = placed.get(`${cell.gx + step.dx},${cell.gy + step.dy}`);
      // Only join rooms the map actually shows. An exit into the dark would
      // otherwise read as a corridor to a room that is not there.
      if (!neighbour) continue;

      // One line per pair. Exits are usually reciprocal, and drawing both would
      // stack two strokes and read heavier than a one-way passage beside it.
      const key = [cell.id, neighbour.id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);

      const from = at(cell);
      const to = at(neighbour);
      const obstacle =
        cell.blocked?.[direction as Direction] ??
        // The far side may describe the same doorway when this side does not.
        neighbour.blocked?.[OPPOSITE[direction as Direction]];
      links.push({
        from: cell.id,
        to: neighbour.id,
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: to.y,
        ...(obstacle ? { obstacle } : {})
      });
    }
  }

  const nodes = map.cells.map((cell) => {
    const here = cell.id === map.centre;
    return {
      id: cell.id,
      name: cell.name,
      ...at(cell),
      kind: kindOf(cell, here),
      here,
      vertical: cell.vertical
    };
  });

  return {
    nodes,
    links,
    width: (maxX - minX) * MAP_CELL,
    height: (maxY - minY) * MAP_CELL
  };
}

/**
 * A route drawn over a map: which corridors it runs along, and which rooms it
 * has still to reach.
 *
 * Everything here is *remaining* — the walker publishes only the part of the
 * route it has not walked yet (`WalkProgress.path`), so a room comes off the
 * drawing when the step into it is confirmed rather than the renderer having
 * to work out which are behind.
 */
export interface MapTrail {
  /** The corridors the route runs along, in the order it walks them. */
  legs: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  /** Rooms the route has still to enter that the map is showing. */
  rooms: ReadonlySet<RoomId>;
  /** Loop stops still owed this lap that the map is showing. */
  stops: ReadonlySet<RoomId>;
}

/** Nothing planned. A constant so a card with no route re-renders no differently. */
export const NO_TRAIL: MapTrail = { legs: [], rooms: new Set(), stops: new Set() };

/**
 * The part of a route and a lap that this map can actually show.
 *
 * Two rules, both about refusing to draw what the picture does not support:
 *
 * - **A leg is drawn only where the map already draws that corridor.** A route
 *   runs through rooms the map may have dropped (a MUD is not Euclidean, and
 *   `layoutMap` places what it can), and joining two placed-but-unjoined rooms
 *   with a straight line would invent a passage between them. Matching against
 *   the drawing's own links also means the route is drawn on top of the
 *   corridor it walks, exactly, rather than beside it.
 * - **The room the character is standing in is not one of the route's rooms.**
 *   It is the line's anchor — `path` opens with it so the leg out of it has
 *   two ends — and it is already the loudest thing on the map. Tinting it as
 *   somewhere still to go would say the character has not arrived where it is.
 *
 * Pure and here rather than beside the card, for `layoutMap`'s reason: it is a
 * function of the layout, it has edge cases worth testing, and the suite runs
 * with no DOM.
 */
export function trailOf(
  drawing: MapDrawing,
  path: readonly RoomId[],
  stops: readonly RoomId[]
): MapTrail {
  const shown = new Set(drawing.nodes.map((node) => node.id));
  const corridors = new Map(drawing.links.map((link) => [pairKey(link.from, link.to), link]));

  const legs: MapTrail['legs'] = [];
  for (let index = 1; index < path.length; index += 1) {
    const link = corridors.get(pairKey(path[index - 1]!, path[index]!));
    if (link === undefined) continue;
    legs.push({ x1: link.x1, y1: link.y1, x2: link.x2, y2: link.y2 });
  }

  return {
    legs,
    // From index 1: the first entry is where the character already is.
    rooms: new Set(path.slice(1).filter((room) => shown.has(room))),
    stops: new Set(stops.filter((room) => shown.has(room)))
  };
}

/** One key for a corridor whichever end it is named from. */
function pairKey(from: RoomId, to: RoomId): string {
  return from < to ? `${from}|${to}` : `${to}|${from}`;
}
