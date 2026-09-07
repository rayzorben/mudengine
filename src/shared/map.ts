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

/**
 * A way out of a room that the plane cannot draw as a corridor: up, down, or
 * a scripted teleport.
 *
 * The map places rooms by compass direction and joins the ones it placed, so
 * a way that leaves the plane has always been a *mark* on the room — the
 * chevrons — and never something a reader could act on: the room above was
 * not on the picture and nothing said which room it was. The loop builder
 * needs exactly that answer, because *route me up from here* is a click on
 * the way up, and a click has to name where it goes. So each of these
 * carries its destination, the realm's name for it and the command that
 * takes it, composed where the realm data lives (`localMap`).
 *
 * `command` is what a walker would send — `u`, `d`, or the portal's own
 * phrase (`go vortex`). A vertical exit with a `Text:` instruction carries
 * that phrase rather than the bare direction, for the reason `RouteStep.
 * command` does: the direction does not work there.
 */
export interface MapAway {
  kind: 'up' | 'down' | 'teleport';
  to: RoomId;
  name: string;
  command: string;
  /**
   * What stands in the way, when the realm says something does — a door on
   * the way up, a level a portal wants. A way out offered as a plain control
   * with the price the realm already stated thrown away would be the map
   * saying "up" about a door the character cannot open.
   */
  obstacle?: MapObstacle;
}

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
   * The ways out that leave the plane, with where each one lands. Absent
   * when there are none, which is most rooms. See {@link MapAway}.
   */
  away?: MapAway[];
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
 * the realm at every setting. See `roomPixelsFor`, and `zoomFloor` in the
 * renderer for the one case the dense end is not honoured: a window so large
 * that the widest fetch could not fill it.
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
 * Pure and here rather than beside the card, for `layoutMap`'s reason: it is
 * a function of the layout with edge cases worth testing, and the suite runs
 * with no DOM. How many rooms then fit is the window's question
 * (`radiusForView`, in the renderer), measured from the laid-out box.
 */
export function roomPixelsFor(density: number, sparse: number, dense: number): number {
  const at = Number.isFinite(density) ? Math.max(0, Math.min(1, density)) : DEFAULT_MAP_DENSITY;
  return sparse + at * (dense - sparse);
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
  /** The off-plane ways out, for a picture that lets a reader take one. */
  away?: MapAway[];
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
      vertical: cell.vertical,
      ...(cell.away && cell.away.length > 0 ? { away: cell.away } : {})
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
/**
 * One corridor of the way, oriented the way it is walked.
 *
 * `x1,y1` is where the step starts and `x2,y2` where it ends — which is **not**
 * necessarily the drawing's own order for that link. A corridor is stored once,
 * from whichever end the layout reached first, and a lap that comes back along
 * it walks it the other way; drawing the arrow off the link's own coordinates
 * would point half the lap backwards.
 */
export interface MapTrailLeg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /**
   * Which colour band this leg is drawn in — 0 for the first pass over fresh
   * corridors, one higher each time the way starts doubling back over ground
   * it has already covered.
   */
  band: number;
}

export interface MapTrail {
  /** The corridors the route runs along, in the order it walks them. */
  legs: MapTrailLeg[];
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
  stops: readonly RoomId[],
  bands = 1
): MapTrail {
  const shown = new Set(drawing.nodes.map((node) => node.id));
  const corridors = new Map(drawing.links.map((link) => [pairKey(link.from, link.to), link]));

  const legs: MapTrail['legs'] = [];
  /*
   * A lap that comes back the way it went draws one line over another, and the
   * picture then says a corridor is on the way rather than on the way *twice*
   * — which is precisely what somebody building a loop is looking at the map
   * to check.
   *
   * So the way changes colour when it starts covering ground it has already
   * covered, and keeps the new colour going forward.
   *
   * **On the rising edge, not per repeated corridor.** Walking back down a
   * five-room corridor is five repeats, and bumping at each would spend every
   * band before the lap had crossed itself once. What is worth marking is the
   * moment the way *starts* doubling back; the legs after it, new or not, are
   * the same pass and stay the same colour until it doubles back again.
   *
   * **Counted over the corridors the map actually draws.** A route runs
   * through rooms the layout may have dropped, and a band that changed for an
   * invisible repeat would be a colour change with nothing on screen to
   * explain it. The band is a property of the picture, so it is decided by the
   * picture.
   */
  const walked = new Set<string>();
  const ceiling = Math.max(1, Math.floor(bands)) - 1;
  let band = 0;
  let doublingBack = false;
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1]!;
    const to = path[index]!;
    const key = pairKey(from, to);
    const link = corridors.get(key);
    if (link === undefined) continue;

    const again = walked.has(key);
    if (again && !doublingBack) band = Math.min(band + 1, ceiling);
    doublingBack = again;
    walked.add(key);

    // Oriented by travel rather than by the link's own ends, so the arrow on
    // it points the way the character goes. See `MapTrailLeg`.
    const forward = link.from === from;
    legs.push({
      x1: forward ? link.x1 : link.x2,
      y1: forward ? link.y1 : link.y2,
      x2: forward ? link.x2 : link.x1,
      y2: forward ? link.y2 : link.y1,
      band
    });
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
