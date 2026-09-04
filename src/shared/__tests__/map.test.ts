import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAP_DENSITY,
  layoutMap,
  MAP_CELL,
  radiusForBox,
  roomPixelsFor,
  trailOf,
  type LocalMap,
  type MapNode
} from '../map';

/** A map built by hand, so a test says what it means without a world file. */
function cells(...entries: Array<[string, number, number, string[]]>): LocalMap {
  return {
    centre: entries[0]?.[0] ?? null,
    dropped: 0,
    cells: entries.map(([id, gx, gy, exits]) => ({
      id,
      name: id,
      gx,
      gy,
      exits: exits as never,
      vertical: null,
      shop: false,
      lair: false
    }))
  };
}

/** The node for a room id, so assertions can name what they mean. */
const node = (map: LocalMap, id: string): MapNode | undefined =>
  layoutMap(map).nodes.find((entry) => entry.id === id);

describe('laying out a map', () => {
  it('draws nothing at all for an empty map', () => {
    expect(layoutMap(cells())).toEqual({ nodes: [], links: [], width: 0, height: 0 });
  });

  it('marks where the character is standing', () => {
    const drawing = layoutMap(cells(['1/1', 0, 0, []]));
    expect(drawing.nodes).toHaveLength(1);
    expect(drawing.nodes[0]?.here).toBe(true);
    expect(drawing.nodes[0]?.kind).toBe('here');
  });

  it('marks exactly one room as where you are', () => {
    const map = cells(['1/1', 0, 0, ['e']], ['1/2', 1, 0, ['w']]);
    expect(layoutMap(map).nodes.filter((entry) => entry.here)).toHaveLength(1);
  });

  it('puts north above and south below', () => {
    const map = cells(['1/1', 0, 0, ['n']], ['1/2', 0, -1, ['s']]);
    expect(node(map, '1/2')!.y).toBeLessThan(node(map, '1/1')!.y);
  });

  it('puts east to the right of west', () => {
    const map = cells(['1/1', 0, 0, ['e']], ['1/2', 1, 0, ['w']]);
    expect(node(map, '1/2')!.x).toBeGreaterThan(node(map, '1/1')!.x);
  });

  it('joins neighbours with one link, not two', () => {
    // Exits are usually reciprocal. Two strokes on one corridor would read
    // heavier than a one-way passage beside it.
    const map = cells(['1/1', 0, 0, ['e']], ['1/2', 1, 0, ['w']]);
    expect(layoutMap(map).links).toHaveLength(1);
  });

  it('does not draw a link to a room the map is not showing', () => {
    // An exit into the dark would read as a corridor to a room that is not
    // there.
    expect(layoutMap(cells(['1/1', 0, 0, ['e', 'n', 's', 'w']])).links).toEqual([]);
  });

  it('does not put a link on the plane for up or down', () => {
    const map = cells(['1/1', 0, 0, ['u', 'd']], ['1/2', 0, 1, []]);
    expect(layoutMap(map).links).toEqual([]);
  });

  it('gives each kind of room its own kind, most urgent first', () => {
    const map = cells(['1/1', 0, 0, []], ['1/2', 1, 0, []], ['1/3', 2, 0, []], ['1/4', 3, 0, []]);
    map.cells[1]!.lair = true;
    map.cells[2]!.shop = true;
    map.cells[3]!.vertical = 'down';
    expect(layoutMap(map).nodes.map((entry) => entry.kind)).toEqual([
      'here',
      'lair',
      'shop',
      'stairs'
    ]);
  });

  it('still shows you where you are, whatever else the room is', () => {
    const map = cells(['1/1', 0, 0, []]);
    map.cells[0]!.lair = true;
    map.cells[0]!.shop = true;
    // Standing in it outranks what it is: the one thing the map must never lose
    // is which square is yours.
    expect(layoutMap(map).nodes[0]?.kind).toBe('here');
  });

  it('keeps a staircase findable even when it is drawn in the plane', () => {
    const map = cells(['1/1', 0, 0, []], ['1/2', 1, 0, []]);
    map.cells[1]!.vertical = 'up';
    expect(node(map, '1/2')!.vertical).toBe('up');
  });

  it('carries the room name, so the card can say what it is', () => {
    const map = cells(['1/1', 0, 0, []]);
    map.cells[0]!.name = 'Newhaven, Docks';
    expect(layoutMap(map).nodes[0]?.name).toBe('Newhaven, Docks');
  });

  it('reports an extent that contains every room', () => {
    const map = cells(['1/1', 0, 0, []], ['1/2', 2, 0, []], ['1/3', 0, 3, []]);
    const drawing = layoutMap(map);
    expect(drawing.width).toBe(2 * MAP_CELL);
    expect(drawing.height).toBe(3 * MAP_CELL);
    for (const entry of drawing.nodes) {
      expect(entry.x).toBeGreaterThanOrEqual(0);
      expect(entry.y).toBeGreaterThanOrEqual(0);
      expect(entry.x).toBeLessThanOrEqual(drawing.width);
      expect(entry.y).toBeLessThanOrEqual(drawing.height);
    }
  });

  it('places the extent origin at the top left however far west the map runs', () => {
    // The centre is not the origin: a map that runs west of where you stand
    // would otherwise have negative coordinates and clip out of its own box.
    const map = cells(['1/1', 0, 0, ['w']], ['1/2', -1, 0, ['e']]);
    expect(node(map, '1/2')!.x).toBe(0);
    expect(node(map, '1/1')!.x).toBe(MAP_CELL);
  });

  it('carries what stands in the way onto the corridor', () => {
    const map = cells(['1/1', 0, 0, ['e']], ['1/2', 1, 0, ['w']]);
    map.cells[0]!.blocked = {
      e: {
        kind: 'door',
        label: 'Door, pick or bash 21',
        detail: 'Door — pick or bash 21',
        raw: 'Door [21 picklocks/strength]'
      }
    };
    const [link] = layoutMap(map).links;
    expect(link?.obstacle?.kind).toBe('door');
    expect(link?.obstacle?.detail).toContain('21');
  });

  it('finds the door when only the far side describes it', () => {
    // A doorway is one thing seen from two rooms, and the realm data does not
    // always annotate both sides.
    const map = cells(['1/1', 0, 0, ['e']], ['1/2', 1, 0, ['w']]);
    map.cells[1]!.blocked = {
      w: {
        kind: 'key',
        label: 'Key: angular key',
        detail: 'Locked: needs angular key',
        raw: 'Key: 1124'
      }
    };
    expect(layoutMap(map).links[0]?.obstacle?.kind).toBe('key');
  });

  it('leaves an open corridor unmarked', () => {
    const map = cells(['1/1', 0, 0, ['e']], ['1/2', 1, 0, ['w']]);
    expect(layoutMap(map).links[0]?.obstacle).toBeUndefined();
  });

  it('says which way a room leaves the plane, not merely that it does', () => {
    // A room with only a way down was drawn with an arrow pointing up, which is
    // a map stating the opposite of the truth.
    const map = cells(['1/1', 0, 0, []], ['1/2', 1, 0, []], ['1/3', 2, 0, []]);
    map.cells[0]!.vertical = 'down';
    map.cells[1]!.vertical = 'up';
    map.cells[2]!.vertical = 'both';
    expect(layoutMap(map).nodes.map((n) => n.vertical)).toEqual(['down', 'up', 'both']);
  });
});

/* A bank is drawn as a bank, ahead of the shop it also is. */
describe('a bank on the map', () => {
  it('is its own kind, and a shop without a kind stays a shop', () => {
    const cell = (id: string, over: Record<string, unknown>) => ({
      id,
      name: id,
      gx: 0,
      gy: 0,
      exits: [],
      vertical: null,
      shop: true,
      lair: false,
      ...over
    });
    const drawn = layoutMap({
      centre: '1/1',
      cells: [
        cell('1/1', { shop: false }),
        cell('1/2', { gx: 1, place: 'bank' }),
        cell('1/3', { gx: 2 })
      ],
      truncated: false
    } as never);
    expect(drawn.nodes.map((node) => node.kind)).toEqual(['here', 'bank', 'shop']);
  });
});

/**
 * How far out to walk, from how big the card actually is.
 *
 * The complaint this answers: a map dragged out of the rail and made bigger
 * drew *the same rooms larger* rather than more of them, because the radius
 * was a constant and the viewBox scaled whatever came back.
 */
describe('the radius a card of this size can show', () => {
  // The shipped numbers, so the cases below read as the real thing.
  const PER_ROOM = 34;
  const MIN = 3;
  const MAX = 12;
  const radius = (w: number, h: number) => radiusForBox(w, h, PER_ROOM, MIN, MAX);

  it('asks for more rooms as the card grows', () => {
    const railed = radius(300, 240);
    const floated = radius(900, 700);
    expect(floated).toBeGreaterThan(railed);
  });

  /* The constraining side is the one that decides what is legible: the viewBox
     fits the whole extent, so rooms fetched for a wide box are scaled away by
     a short one. */
  it('measures the smaller side, not the larger', () => {
    expect(radius(2000, 240)).toBe(radius(240, 240));
  });

  it('never goes below the floor a rail card needs', () => {
    expect(radius(40, 40)).toBe(MIN);
    expect(radius(1, 1)).toBe(MIN);
  });

  /* The search is breadth-first and exponential in the radius, so a
     full-screen float must not be allowed to walk the whole realm. */
  it('never goes above the ceiling, however large the card', () => {
    expect(radius(6000, 6000)).toBe(MAX);
  });

  /*
   * A box with no size yet: the first paint, or a card in a pane that is
   * collapsed. Asking for the floor rather than nothing is what keeps a map
   * from flashing empty on every mount.
   */
  it('asks for the floor while it has no size at all', () => {
    expect(radius(0, 0)).toBe(MIN);
    expect(radiusForBox(Number.NaN, 300, PER_ROOM, MIN, MAX)).toBe(MIN);
    expect(radiusForBox(300, 300, 0, MIN, MAX)).toBe(MIN);
  });

  it('counts rooms out from the centre, not across the whole box', () => {
    // Ten rooms across at 34px each is five in each direction.
    expect(radius(PER_ROOM * 10, PER_ROOM * 10)).toBe(5);
  });
});

/**
 * How much of the realm fits, which the player now chooses.
 *
 * There was one figure and it decided for everybody. The slider chooses the
 * room *budget* rather than a room count, so the measured radius above still
 * does its job: a card dragged twice as big shows more at every setting.
 */
describe('the density slider', () => {
  // The shipped ends, so the cases read as the real thing.
  const SPARSE = 40;
  const DENSE = 10;
  const budget = (density: number) => roomPixelsFor(density, SPARSE, DENSE);

  it('gives a room its whole budget at the sparse end and least at the dense one', () => {
    expect(budget(0)).toBe(SPARSE);
    expect(budget(1)).toBe(DENSE);
  });

  it('sits halfway in the middle, which is what a fresh card is drawn at', () => {
    expect(budget(DEFAULT_MAP_DENSITY)).toBe(25);
  });

  /*
   * The numbers the request named, on the card it was about: a rail map's
   * picture is roughly 200px on the short side, and the two ends of the slider
   * are chosen so that box spans 5x5 rooms and 20x20.
   */
  it('spans 5x5 to 20x20 on a rail-sized card', () => {
    const across = (density: number) => radiusForBox(220, 200, budget(density), 2, 12) * 2 + 1;
    expect(across(0)).toBe(5);
    expect(across(1)).toBe(21);
  });

  it('shows more of the realm at every setting once the card is bigger', () => {
    const railed = radiusForBox(220, 200, budget(0.5), 2, 12);
    const floated = radiusForBox(900, 700, budget(0.5), 2, 12);
    expect(floated).toBeGreaterThan(railed);
  });

  /*
   * Clamped rather than refused: this comes out of `localStorage`, and a map
   * that drew nothing because a stored fraction was 1.2 would be a card broken
   * by its own history.
   */
  it('clamps a fraction outside the slider, and answers the middle for a non-number', () => {
    expect(budget(-3)).toBe(SPARSE);
    expect(budget(9)).toBe(DENSE);
    expect(budget(Number.NaN)).toBe(budget(DEFAULT_MAP_DENSITY));
  });
});

/**
 * The route drawn over the map: what the walker has still to walk, and the
 * places a lap still owes.
 *
 * The rule under all of it is that the picture must not claim more than the
 * projection supports — a MUD is not Euclidean, so a route runs through rooms
 * this map may not be showing and past corridors it could not draw.
 */
describe('drawing a route over a map', () => {
  /* Four rooms in a row, joined west to east. */
  const row = () =>
    cells(
      ['1/1', 0, 0, ['e']],
      ['1/2', 1, 0, ['w', 'e']],
      ['1/3', 2, 0, ['w', 'e']],
      ['1/4', 3, 0, ['w']]
    );

  it('draws nothing at all when nothing is planned', () => {
    expect(trailOf(layoutMap(row()), [], [])).toEqual({
      legs: [],
      rooms: new Set(),
      stops: new Set()
    });
  });

  it('runs a leg along every corridor the route walks', () => {
    const trail = trailOf(layoutMap(row()), ['1/1', '1/2', '1/3'], []);
    expect(trail.legs).toHaveLength(2);
    // Along the row, in the order they are walked.
    expect(trail.legs[0]).toMatchObject({ x1: 0, y1: 0, x2: MAP_CELL, y2: 0 });
    expect(trail.legs[1]).toMatchObject({ x1: MAP_CELL, y1: 0, x2: MAP_CELL * 2, y2: 0 });
  });

  /*
   * The room the character is standing in opens the path so the leg out of it
   * has two ends — it is not somewhere still to go, and it is already the
   * loudest thing on the map.
   */
  it('does not count the room the character is standing in as one still to enter', () => {
    const trail = trailOf(layoutMap(row()), ['1/1', '1/2', '1/3'], []);
    expect(trail.rooms.has('1/1')).toBe(false);
    expect([...trail.rooms].sort()).toEqual(['1/2', '1/3']);
  });

  /*
   * A route through a room the projection folded away would otherwise be
   * joined by a straight line across whatever lies between — a passage the
   * realm does not have.
   */
  it('never invents a corridor between two rooms the map does not join', () => {
    // 1/1 and 1/4 are both drawn and are three cells apart with no exit
    // between them; the route claims to step from one to the other.
    const trail = trailOf(layoutMap(row()), ['1/1', '1/4'], []);
    expect(trail.legs).toEqual([]);
    // The room is still marked: the map knows where it is, only not how the
    // route gets there.
    expect([...trail.rooms]).toEqual(['1/4']);
  });

  it('skips the part of a route that runs off the map, and draws the part that does not', () => {
    const trail = trailOf(layoutMap(row()), ['1/1', '1/2', '9/1', '9/2'], []);
    expect(trail.legs).toHaveLength(1);
    expect([...trail.rooms]).toEqual(['1/2']);
  });

  it('joins a corridor whichever end of it the route names first', () => {
    // Walked east and walked west are the same passage; `layoutMap` draws one
    // line per pair and does not record which way round it went.
    const east = trailOf(layoutMap(row()), ['1/1', '1/2'], []).legs;
    const west = trailOf(layoutMap(row()), ['1/2', '1/1'], []).legs;
    expect(east).toEqual(west);
  });

  it('marks the lap stops the map is showing and drops the ones it is not', () => {
    const trail = trailOf(layoutMap(row()), [], ['1/3', '9/9']);
    expect([...trail.stops]).toEqual(['1/3']);
    expect(trail.legs).toEqual([]);
  });

  /* A lap's stop that is also on the leg being walked is both, and each mark
     answers a different question: the line is this leg, the ring is the lap. */
  it('lets a room be on the route and a stop at once', () => {
    const trail = trailOf(layoutMap(row()), ['1/1', '1/2', '1/3'], ['1/3']);
    expect(trail.rooms.has('1/3')).toBe(true);
    expect(trail.stops.has('1/3')).toBe(true);
  });
});
