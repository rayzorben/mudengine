/**
 * A route cut into the stretches the map can draw flat, for the Map card's
 * route preview to page through.
 *
 * The map lays rooms out by compass steps on one plane (`STEP`), so a route
 * reads as one line only until it leaves that plane: a way up or down, a
 * portal, a typed exit such as `go manhole`, or a step onto another map
 * number. Each of those ends a leg, and the step that ends it is the jump the
 * pager names between two pages. A leg the map cannot draw whole around its
 * first room (it runs past the fetch, or folds onto rooms already placed) is
 * cut again where the line would stop (`pagesOf`). Pure, so the cuts can be
 * asserted without a DOM. See `mudengine-ui` › `parts/map.md` › *The route
 * preview*.
 */
import { corridorBetween, corridorsOf, layoutMap, STEP, type LocalMap } from './map';
import { asRoomReference, type RoomId, type Route, type RouteStep } from './world';

export interface RouteLeg {
  /** The rooms this leg passes through, its first room included: a trail. */
  rooms: RoomId[];
  /** The flat steps walked within the leg. Empty when two jumps meet. */
  steps: RouteStep[];
  /**
   * The step that leaves this leg for the next, or null where the next page
   * carries straight on (or there is none).
   */
  jump: RouteStep | null;
  /** The step that came into this leg, the last leg's jump; null on the first. */
  entry: RouteStep | null;
}

function mapOf(room: RoomId): number | null {
  return asRoomReference(room)?.map ?? null;
}

/** Whether this step leaves the plane the map is drawing. */
export function isJump(step: RouteStep): boolean {
  if (step.direction === 'portal') return true;
  if (STEP[step.direction] === null) return true;
  if (step.command !== step.direction) return true;
  return mapOf(step.from) !== mapOf(step.to);
}

/**
 * The legs of a route, in walking order. A route with no steps (the two ends
 * are one room) is one leg of that room; a blocked route is no legs.
 */
export function legsOf(route: Route, from: RoomId): RouteLeg[] {
  if (route.blocked) return [];
  const legs: RouteLeg[] = [];
  let current: RouteLeg = { rooms: [from], steps: [], jump: null, entry: null };
  for (const step of route.steps) {
    if (isJump(step)) {
      legs.push({ ...current, jump: step });
      current = { rooms: [step.to], steps: [], jump: null, entry: step };
      continue;
    }
    current.rooms.push(step.to);
    current.steps.push(step);
  }
  legs.push(current);
  return legs;
}

/** How a stretch on a page is reached from the stretch before it. */
export type JoinKind = 'up' | 'down' | 'jump' | 'onward';

/** One plane of a page: the rooms around the stretches walked on it. */
export interface RouteFloor {
  /** Cropped to the stretches plus a ring of rooms, with no ways off it. */
  map: LocalMap;
  /** Floors above (+) or below (−) the page's first. */
  level: number;
}

/** A flat run of the route on one floor of a page. */
export interface RouteStretch {
  /** Index into the page's floors. */
  floor: number;
  rooms: RoomId[];
  /** How the route came here from the stretch before; null on the first. */
  join: { kind: JoinKind; step: RouteStep | null } | null;
}

/** Several short stretches drawn on one page, floor above floor. */
export interface RouteSheet {
  floors: RouteFloor[];
  stretches: RouteStretch[];
}

/**
 * One page of the preview. `rooms` and `steps` run the whole page, the jumps
 * between its stretches included. `sheet` is null for a page of one stretch,
 * which the live map draws around its first room.
 */
export interface RoutePage extends RouteLeg {
  sheet: RouteSheet | null;
}

/** A preview route and the pages it is shown in. */
export interface RoutePages {
  route: Route;
  legs: RoutePage[];
}

/**
 * The route being walked, paged from the room the character stood in when it
 * was asked for. `done` is the walk's `WalkProgress.done` at that moment, so
 * the page being walked is found by the steps taken since (`pageWalking`).
 */
export interface WalkPages {
  done: number;
  legs: RoutePage[];
}

/** No walk under way, so no pages. */
export const NO_WALK_PAGES: Readonly<WalkPages> = Object.freeze({ done: 0, legs: [] });

/** The steps a page walks: its own, and the jump off its end. */
function stepsOn(page: RouteLeg): number {
  return page.steps.length + (page.jump === null ? 0 : 1);
}

/**
 * The page holding the step `walked` steps into the paged route, or null
 * when the count falls outside the pages, which are then stale.
 */
export function pageWalking(pages: readonly RouteLeg[], walked: number): number | null {
  // Behind the pages: the push has not caught up with the paging yet.
  if (walked < 0) return null;
  let start = 0;
  for (const [index, page] of pages.entries()) {
    const end = start + stepsOn(page);
    if (walked < end || (walked === end && index === pages.length - 1)) return index;
    start = end;
  }
  return null;
}

/** How many stretches may share a page, and how many flat steps they may walk between them. */
export interface PagePacking {
  stretches: number;
  steps: number;
}

/** A map as the paging reads it: which rooms it places and which steps it draws. */
interface Drawn {
  map: LocalMap;
  placed: ReadonlySet<RoomId>;
  corridors: ReturnType<typeof corridorsOf>;
}

function drawnBy(draw: (centre: RoomId) => LocalMap): (centre: RoomId) => Drawn {
  const cache = new Map<RoomId, Drawn>();
  return (centre) => {
    const known = cache.get(centre);
    if (known !== undefined) return known;
    const map = draw(centre);
    const drawn = {
      map,
      placed: new Set(map.cells.map((cell) => cell.id)),
      corridors: corridorsOf(layoutMap(map))
    };
    cache.set(centre, drawn);
    return drawn;
  };
}

const drawsStep = (drawn: Drawn, step: RouteStep): boolean =>
  corridorBetween(drawn.corridors, step.from, step.to) !== undefined;

/**
 * The route's legs, each cut again wherever the map drawn around the piece's
 * first room stops drawing the line. The next piece starts on the last room
 * drawn, so the line carries on from where the reader left it. A step no map
 * around its own start can draw is kept whole on one piece rather than
 * looped on.
 */
function piecesOf(route: Route, from: RoomId, drawn: (centre: RoomId) => Drawn): RouteLeg[] {
  const pieces: RouteLeg[] = [];
  for (const leg of legsOf(route, from)) {
    let at = 0;
    for (;;) {
      const centre = leg.rooms[at];
      if (centre === undefined) break;
      const map = drawn(centre);
      let end = at;
      while (end < leg.steps.length && drawsStep(map, leg.steps[end]!)) end += 1;
      if (end === at && at < leg.steps.length) end = at + 1;
      const last = end === leg.steps.length;
      pieces.push({
        rooms: leg.rooms.slice(at, end + 1),
        steps: leg.steps.slice(at, end),
        jump: last ? leg.jump : null,
        entry: at === 0 ? leg.entry : null
      });
      if (last) break;
      at = end;
    }
  }
  return pieces;
}

function joinOf(step: RouteStep | null): { kind: JoinKind; step: RouteStep | null } {
  if (step === null) return { kind: 'onward', step };
  if (step.direction === 'u') return { kind: 'up', step };
  if (step.direction === 'd') return { kind: 'down', step };
  return { kind: 'jump', step };
}

/** Rooms kept round a floor's stretches, so a corridor off the way shows where it leads. */
const FLOOR_MARGIN = 1;

/**
 * The part of a map around `rooms`: their bounding box and a ring past it.
 * The ways up and down are dropped, since the sheet draws them as its joins.
 */
function cropped(map: LocalMap, rooms: ReadonlySet<RoomId>, centre: RoomId | null): LocalMap {
  const on = map.cells.filter((cell) => rooms.has(cell.id));
  const xs = on.map((cell) => cell.gx);
  const ys = on.map((cell) => cell.gy);
  const [left, right] = [Math.min(...xs) - FLOOR_MARGIN, Math.max(...xs) + FLOOR_MARGIN];
  const [top, bottom] = [Math.min(...ys) - FLOOR_MARGIN, Math.max(...ys) + FLOOR_MARGIN];
  const cells = map.cells
    .filter((cell) => cell.gx >= left && cell.gx <= right && cell.gy >= top && cell.gy <= bottom)
    .map((cell) => {
      const copy = { ...cell };
      delete copy.away;
      return copy;
    });
  return { centre, cells, dropped: 0 };
}

/**
 * Short stretches drawn on one page. A stretch goes back onto a floor already
 * on the page when that floor's map draws it (the route came back to a level
 * it was on); otherwise it opens a floor, one level up or down for a way up
 * or down, the same level for any other jump.
 */
function sheetOf(pieces: readonly RouteLeg[], drawn: (centre: RoomId) => Drawn): RoutePage {
  const floors: Array<{ centre: RoomId; level: number; rooms: Set<RoomId> }> = [];
  const stretches: RouteStretch[] = [];
  let level = 0;
  pieces.forEach((piece, index) => {
    const join = index === 0 ? null : joinOf(pieces[index - 1]!.jump);
    if (join?.kind === 'up') level += 1;
    if (join?.kind === 'down') level -= 1;
    const start = piece.rooms[0]!;
    let floor = floors.findIndex((known) => {
      const map = drawn(known.centre);
      return map.placed.has(start) && piece.steps.every((step) => drawsStep(map, step));
    });
    if (floor === -1) {
      floor = floors.push({ centre: start, level, rooms: new Set() }) - 1;
    }
    const on = floors[floor]!;
    level = on.level;
    for (const room of piece.rooms) on.rooms.add(room);
    stretches.push({ floor, rooms: piece.rooms, join });
  });
  const first = pieces[0]!;
  const last = pieces.at(-1)!;
  return {
    // A cut piece starts on the room the one before it ended in.
    rooms: pieces.flatMap((piece, index) =>
      index > 0 && pieces[index - 1]!.jump === null ? piece.rooms.slice(1) : piece.rooms
    ),
    steps: pieces.flatMap((piece, index) =>
      index < pieces.length - 1 && piece.jump !== null ? [...piece.steps, piece.jump] : piece.steps
    ),
    jump: last.jump,
    entry: first.entry,
    sheet: {
      floors: floors.map((floor, index) => ({
        map: cropped(drawn(floor.centre).map, floor.rooms, index === 0 ? floor.centre : null),
        level: floor.level
      })),
      stretches
    }
  };
}

/**
 * The route's pages. Each leg is cut where the map drawn around a piece's
 * first room stops drawing the line (`draw`), and then consecutive pieces are
 * gathered while they walk `packing.steps` flat steps or fewer between them,
 * up to `packing.stretches` to a page, so a way down five times or two short
 * walks either side of a manhole read as one page. A piece longer than the
 * budget has a page to itself.
 */
export function pagesOf(
  route: Route,
  from: RoomId,
  draw: (centre: RoomId) => LocalMap,
  packing: PagePacking
): RoutePage[] {
  const drawn = drawnBy(draw);
  const pages: RoutePage[] = [];
  let group: RouteLeg[] = [];
  let walked = 0;
  const flush = (): void => {
    if (group.length === 1) pages.push({ ...group[0]!, sheet: null });
    if (group.length > 1) pages.push(sheetOf(group, drawn));
    group = [];
    walked = 0;
  };
  for (const piece of piecesOf(route, from, drawn)) {
    const full = group.length >= packing.stretches;
    if (full || walked + piece.steps.length > packing.steps) flush();
    group.push(piece);
    walked += piece.steps.length;
  }
  flush();
  return pages;
}
