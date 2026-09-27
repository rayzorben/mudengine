/**
 * Where a route preview's sheet puts each floor, and the joins between them.
 *
 * A sheet (`RouteSheet`, cut in main) is several short stretches of a route
 * on one page. Stretches joined by a way up or down are drawn as tilted
 * floors, one above the other, with the start of each floor under the end of
 * the one before; any other join (a typed exit, a portal, a new map, a line
 * the map could not carry on) puts the next floor beside the last. A floor
 * that would land on one already placed moves on past it, up, down or right
 * the way it was going. Pure, so the placing can be asserted without a DOM.
 * See `mudengine-ui` › `parts/map.md` › *The route preview*.
 */
import { layoutMap, MAP_CELL, trailOf, type MapDrawing, type MapTrail } from '@shared/map';
import type { JoinKind, RouteSheet } from '@shared/routeLegs';
import type { RoomId, RouteStep } from '@shared/world';

/**
 * The tilt, as the SVG matrix applies it: across by `skew` per unit down, and
 * squashed to `squash` of the height. A floor then reads as a plane seen from
 * above and in front, and a room on it keeps its compass place.
 */
export const TILT = { skew: 0.5, squash: 0.55 } as const;

/** The plane's margin past its outer rooms, in map units. */
export const FLOOR_PAD = MAP_CELL / 2;
/** Least height between two floors joined by a way up or down. */
const RISE = MAP_CELL * 1.8;
/** Space between two floors that would otherwise touch. */
const GAP = MAP_CELL;

interface Point {
  x: number;
  y: number;
}

interface Area {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SheetFloor {
  drawing: MapDrawing;
  level: number;
  /** The SVG transform that puts this floor's drawing on the sheet. */
  transform: string;
  /** Every stretch walked on this floor, as one trail. */
  trail: MapTrail;
}

export interface SheetJoin {
  kind: JoinKind;
  /** The step taken, or null where the line carries on past the map's edge. */
  step: RouteStep | null;
  /** The name of the room it arrives in. */
  name: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SheetLayout {
  /** Floors bottom first, so a floor above is painted over one below. */
  floors: SheetFloor[];
  joins: SheetJoin[];
  /** The sheet's extent, for the viewBox. */
  box: { x: number; y: number; width: number; height: number };
}

const overlaps = (a: Area, b: Area): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const moved = (extent: Area, by: Point): Area => ({
  left: extent.left + by.x,
  right: extent.right + by.x,
  top: extent.top + by.y,
  bottom: extent.bottom + by.y
});

/**
 * Lays a sheet out. `stops` are rooms to ring (the page's last), `bands` the
 * trail's colour count, as the live map takes them.
 */
export function layoutSheet(
  sheet: RouteSheet,
  stops: readonly RoomId[],
  bands: number
): SheetLayout {
  const tilted = sheet.stretches.some(
    (stretch) => stretch.join?.kind === 'up' || stretch.join?.kind === 'down'
  );
  const project = (x: number, y: number): Point =>
    tilted ? { x: x + TILT.skew * y, y: TILT.squash * y } : { x, y };

  const drawings = sheet.floors.map((floor) => layoutMap(floor.map));
  const rooms = drawings.map(
    (drawing) => new Map(drawing.nodes.map((node) => [node.id, node] as const))
  );
  const areas = drawings.map((drawing): Area => {
    const corners = [
      project(-FLOOR_PAD, -FLOOR_PAD),
      project(drawing.width + FLOOR_PAD, -FLOOR_PAD),
      project(-FLOOR_PAD, drawing.height + FLOOR_PAD),
      project(drawing.width + FLOOR_PAD, drawing.height + FLOOR_PAD)
    ];
    return {
      left: Math.min(...corners.map((corner) => corner.x)),
      right: Math.max(...corners.map((corner) => corner.x)),
      top: Math.min(...corners.map((corner) => corner.y)),
      bottom: Math.max(...corners.map((corner) => corner.y))
    };
  });

  const offsets: Array<Point | null> = sheet.floors.map(() => null);
  const placed: Area[] = [];
  const onSheet = (floor: number, room: RoomId): Point | null => {
    const node = rooms[floor]?.get(room);
    const offset = offsets[floor];
    if (node === undefined || offset === null || offset === undefined) return null;
    const at = project(node.x, node.y);
    return { x: at.x + offset.x, y: at.y + offset.y };
  };
  const place = (floor: number, offset: Point): void => {
    offsets[floor] = offset;
    placed.push(moved(areas[floor]!, offset));
  };

  const first = sheet.stretches[0];
  if (first !== undefined) place(first.floor, { x: 0, y: 0 });
  sheet.stretches.forEach((stretch, index) => {
    const before = sheet.stretches[index - 1];
    if (before === undefined || offsets[stretch.floor] !== null) return;
    const from = onSheet(before.floor, before.rooms.at(-1)!);
    const node = rooms[stretch.floor]?.get(stretch.rooms[0]!);
    const extent = areas[stretch.floor]!;
    if (from === null || node === undefined) {
      place(stretch.floor, { x: Math.max(...placed.map((box) => box.right)) + GAP, y: 0 });
      return;
    }
    const start = project(node.x, node.y);
    const kind = stretch.join?.kind ?? 'onward';
    const offset: Point =
      kind === 'up' || kind === 'down'
        ? { x: from.x - start.x, y: from.y - start.y + (kind === 'up' ? -RISE : RISE) }
        : {
            x: Math.max(...placed.map((box) => box.right)) + GAP - extent.left,
            y: from.y - start.y
          };
    for (;;) {
      const hit = placed.find((box) => overlaps(moved(extent, offset), box));
      if (hit === undefined) break;
      if (kind === 'up') offset.y = hit.top - GAP - extent.bottom;
      else if (kind === 'down') offset.y = hit.bottom + GAP - extent.top;
      else offset.x = hit.right + GAP - extent.left;
    }
    place(stretch.floor, offset);
  });

  const joins: SheetJoin[] = [];
  sheet.stretches.forEach((stretch, index) => {
    const before = sheet.stretches[index - 1];
    if (before === undefined || stretch.join === null) return;
    const from = onSheet(before.floor, before.rooms.at(-1)!);
    const to = onSheet(stretch.floor, stretch.rooms[0]!);
    /* Two stretches on one floor that meet in a room need nothing between them. */
    if (from === null || to === null || (from.x === to.x && from.y === to.y)) return;
    joins.push({
      kind: stretch.join.kind,
      step: stretch.join.step,
      name: rooms[stretch.floor]?.get(stretch.rooms[0]!)?.name ?? stretch.rooms[0]!,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y
    });
  });

  const floors = sheet.floors
    .map((floor, index): SheetFloor => {
      const drawing = drawings[index]!;
      const offset = offsets[index] ?? { x: 0, y: 0 };
      const walked = sheet.stretches.filter((stretch) => stretch.floor === index);
      return {
        drawing,
        level: floor.level,
        transform: tilted
          ? `matrix(1 0 ${TILT.skew} ${TILT.squash} ${offset.x} ${offset.y})`
          : `translate(${offset.x} ${offset.y})`,
        trail: joinedTrail(walked.map((stretch) => trailOf(drawing, stretch.rooms, stops, bands)))
      };
    })
    .sort((a, b) => a.level - b.level);

  const left = Math.min(...placed.map((box) => box.left));
  const top = Math.min(...placed.map((box) => box.top));
  const right = Math.max(...placed.map((box) => box.right));
  const bottom = Math.max(...placed.map((box) => box.bottom));
  return {
    floors,
    joins,
    box:
      placed.length === 0
        ? { x: 0, y: 0, width: 0, height: 0 }
        : { x: left, y: top, width: right - left, height: bottom - top }
  };
}

/** Several stretches' trails on one floor, drawn as one. */
function joinedTrail(trails: readonly MapTrail[]): MapTrail {
  return {
    legs: trails.flatMap((trail) => trail.legs),
    rooms: new Set(trails.flatMap((trail) => [...trail.rooms])),
    stops: new Set(trails.flatMap((trail) => [...trail.stops]))
  };
}
