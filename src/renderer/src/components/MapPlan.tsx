/**
 * The map itself, drawn — without the card around it.
 *
 * It was the whole of `MapCard` until the route panel needed the same picture
 * of somewhere *else*: a destination's neighbourhood, from the destination's
 * own point of view, beside the plan for getting there. Two SVGs drawing the
 * same realm data in two files is two pictures that come to disagree about
 * what a door looks like, so the drawing moved here and both surfaces call it.
 *
 * What stayed in the card is what is *about* a card: the fetch keyed on where
 * the character is standing, the folded-rooms badge and the empty state — and
 * since the map became something to pan and zoom, those live in `MapView`,
 * which both cards share.
 *
 * Two ways of looking at the picture. Given a `viewport`, the SVG shows exactly
 * what a box of that size can hold at that zoom, centred where the eye was
 * taken — the Map card and the builder. Without one it *fits*: the whole
 * neighbourhood scaled into the box, which is what the route panel's strip
 * wants and what every map did until 2026-09-05.
 *
 * Drawn as vector shapes. It was character cells first, on the argument that
 * the game draws its own maps that way — but this map is not the game's. It is
 * derived by the client and never crosses the wire, so the character-cell rule
 * that governs the console does not reach it. It is chrome, and chrome follows
 * the design language.
 */
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { viewBoxFor, type Box, type MapView } from '../lib/mapView';
import {
  layoutMap,
  MAP_CELL,
  NO_TRAIL,
  trailOf,
  type LocalMap,
  type MapAway,
  type MapDrawing,
  type MapNode,
  type MapTrail
} from '@shared/map';
import type { RoomId } from '@shared/world';
import { tuning } from '../lib/tuning';

/**
 * The smallest neighbourhood a *fitted* viewBox will ever claim to be, in map
 * units (`MAP_CELL` apart per room).
 *
 * The viewBox is what makes a wide neighbourhood draw smaller rather than
 * taller — but run that the other way, on a one-room map like the Halls of
 * the Dead, and the single room is "the whole neighbourhood" and gets scaled
 * up to fill the box. A floor on the span keeps a lone room drawn at roughly
 * the size it would be as part of a small cluster, about four rooms across,
 * instead of ballooning to the size of the card. A window has no such
 * problem: a lone room is drawn at the zoom, like any other.
 */
const MIN_SPAN = MAP_CELL * 4;

/**
 * What is drawn *on* a room, and how far past the room's own radius each one
 * reaches — its offset, and the stroke it is drawn with, because a stroke
 * straddles the path it follows and half of it lies outside.
 *
 * One table, read by the marks themselves **and** by the fitted viewBox's
 * padding. They were separately-written numbers and they disagreed: the `you`
 * ring is `radius + 2.2` with an 0.8 stroke, so it reaches `radius + 2.6`,
 * while the pad was `radius + 2`. Every ring on a room at the edge of the
 * neighbourhood was therefore drawn *outside* the viewBox, and `.map-plan`
 * carried `overflow: visible` so it could paint there — which works only for
 * as long as nothing above the SVG clips. The card's own body does (a
 * scrolling body computes `overflow-x: auto` too), so the ring on the top row
 * of rooms was sheared off flat by the heading, and reported as the heading
 * cutting into the map. A drawing has to fit inside the box it declares.
 *
 * The room shapes themselves are not in here because they cannot be the
 * constraining ones: the widest is the lair's diamond at `radius + 0.6` with
 * an 0.5 stroke — `radius + 0.85`, a third of the rings' reach. Anything added
 * that reaches further than a ring belongs in this table.
 */
const MARKS = {
  /** The route's halo. Filled, no stroke, so it reaches exactly its radius. */
  onroute: { over: 1.6, stroke: 0 },
  /** A stop this lap still owes, dashed. */
  stop: { over: 2.2, stroke: 0.8 },
  /** Which room is mine — the one deliberately loud element on the surface. */
  you: { over: 2.2, stroke: 0.8 },
  /** The builder's start: the red ring the request asked for. */
  start: { over: 2.2, stroke: 0.8 },
  /** A room the builder was clicked on. */
  pick: { over: 1.6, stroke: 0.8 },
  /** A room the builder's way runs through without having been clicked. */
  through: { over: 1.6, stroke: 0.5 }
} as const;

/**
 * The furthest anything drawn on a room reaches past that room's centre, less
 * the room's own radius — which is a tuning key and so is added where it is
 * read, never captured at module scope.
 */
const MARK_REACH = Math.max(...Object.values(MARKS).map((mark) => mark.over + mark.stroke / 2));

/**
 * The find dot's radius, in the same units the room's own radius is in.
 *
 * Not in `MARKS`: everything there is measured *over the room's radius* and
 * feeds `MARK_REACH`, and this one sits on the corner rather than around the
 * room — adding it there would widen every map's padding for a mark that
 * reaches no further than the room already does.
 */
const FIND_DOT = 1.1;

/**
 * How far out the off-plane controls sit, past the room's radius, the size of
 * their glyph, the stroke they wear and the hit target round each — `MARKS`'
 * shape, kept apart because they are drawn only for a builder and every other
 * map should not pay their padding.
 */
const AWAY = { over: 2.4, size: 1.5, stroke: 0.6, hit: 1.2 } as const;
const AWAY_REACH = AWAY.over + AWAY.size + AWAY.hit + AWAY.stroke / 2;

/**
 * The shape a room is drawn as.
 *
 * Shape carries the meaning and colour reinforces it, never the other way
 * round: §6 of the design language forbids stating a condition by hue alone,
 * and a map read at a glance in a fight is exactly where that matters. The
 * legend names all four.
 *
 * **Every one of them carries `map-shape`, and that class is load-bearing.**
 * The room's fill and edge used to be stated as `.map-room > circle` — *any*
 * child of the kind — which is a rule about position rather than about what
 * the element is, and a room's group holds marks that are not its shape: the
 * `you` ring, the route halo, the lap's ring. At `(0,1,1)` it outranked each
 * of their own single-class rules at `(0,1,0)`, so all three were painted the
 * room's grey and the shop's amber instead of their own colours — the `you`
 * ring drew as a filled grey disc behind the accent square for as long as the
 * map has existed, and the two marks added for the route inherited it whole.
 * Naming the shape is what lets a rule mean *the shape* and no longer catch
 * whatever else the group happens to hold.
 */
/**
 * A small arrowhead at the middle of a leg, pointing the way it is walked.
 *
 * Returned as `points` for a polygon in the map's own coordinate space, so it
 * zooms with everything else rather than staying one size while the rooms grow
 * — the map is a window on a drawing and a fixed-size mark on it would be a
 * pixel constant in the layout path, which no part of this client is allowed.
 *
 * Sized off the room's radius for the same reason, and deliberately small: it
 * says which way, and the line says where. At a third of a room it reads at the
 * sparse end and disappears politely into the stroke at the dense one, which is
 * the right way round — a lap drawn at ten pixels a room is being read for its
 * shape, not its direction.
 *
 * The midpoint, not the end: an arrowhead at the end of a leg lands on the room
 * marker and fights with it, and every leg's end is another leg's start.
 */
function arrowAt(leg: { x1: number; y1: number; x2: number; y2: number }, scale?: number): string {
  // The legend's keys are drawn in a 12-unit box rather than in map units, so
  // they hand in their own size — the same thing the trap's key does.
  const size = scale ?? tuning().mapRoomRadius / 1.5;
  const dx = leg.x2 - leg.x1;
  const dy = leg.y2 - leg.y1;
  const length = Math.hypot(dx, dy);
  // A corridor of no length has no direction to state. Zero would divide to
  // NaN and put `points="NaN,NaN …"` in the DOM, which paints nothing and
  // reports nothing.
  if (length === 0) return '';
  const ux = dx / length;
  const uy = dy / length;
  const mx = (leg.x1 + leg.x2) / 2;
  const my = (leg.y1 + leg.y2) / 2;
  // The tip, and two barbs behind it at right angles to the way it points.
  const tipX = mx + ux * size;
  const tipY = my + uy * size;
  const backX = mx - ux * size * 0.35;
  const backY = my - uy * size * 0.35;
  const wing = size * 0.62;
  return [
    `${round(tipX)},${round(tipY)}`,
    `${round(backX - uy * wing)},${round(backY + ux * wing)}`,
    `${round(backX + uy * wing)},${round(backY - ux * wing)}`
  ].join(' ');
}

/** Two decimals is under a thousandth of a room and keeps the DOM readable. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function shape(node: MapNode) {
  // The room's radius, read once per shape rather than six times.
  const r = tuning().mapRoomRadius;
  if (node.kind === 'shop') return <circle className="map-shape" cx={node.x} cy={node.y} r={r} />;
  /* A bank: the shop's circle with a `$` in it, in gold — where the money is. */
  if (node.kind === 'bank') {
    return (
      <>
        <circle className="map-shape" cx={node.x} cy={node.y} r={r + 0.4} />
        <text className="map-bank" textAnchor="middle" x={node.x} y={node.y + 1.15}>
          $
        </text>
      </>
    );
  }
  if (node.kind === 'lair') {
    const points = [
      `${node.x},${node.y - r - 0.6}`,
      `${node.x + r + 0.6},${node.y}`,
      `${node.x},${node.y + r + 0.6}`,
      `${node.x - r - 0.6},${node.y}`
    ].join(' ');
    return <polygon className="map-shape" points={points} />;
  }
  return (
    <rect
      className="map-shape"
      height={r * 2}
      rx={1.1}
      width={r * 2}
      x={node.x - r}
      y={node.y - r}
    />
  );
}

/**
 * The hazard triangle a trapped corridor wears, centred on a point.
 *
 * One function for the map and its legend, so the key looks like the thing it
 * names. Sized to the corridor: a room is `mapRoomRadius` (3) from its centre
 * and rooms sit `MAP_CELL` (10) apart, so the passage between two edges is
 * four units and a door's bar is 4.2 across; this is 3.2 wide and 2.8 tall,
 * which reads as a mark on the passage rather than a third room in it.
 */
function trapPoints(x: number, y: number, scale = 1): string {
  const w = 1.6 * scale;
  const up = 1.6 * scale;
  const down = 1.2 * scale;
  return `${x},${y - up} ${x + w},${y + down} ${x - w},${y + down}`;
}

/**
 * Which way a room leaves the plane, drawn as the way it actually goes.
 *
 * A chevron pointing up on a room whose only other exit is *down* is a map
 * stating the opposite of the truth, and plenty of rooms have both. Up points
 * up, down points down, both shows both.
 */
function Vertical({ which, x, y }: { which: 'up' | 'down' | 'both'; x: number; y: number }) {
  const up = `M ${x - 1.4} ${y + 0.5} L ${x} ${y - 0.9} L ${x + 1.4} ${y + 0.5}`;
  const down = `M ${x - 1.4} ${y - 0.5} L ${x} ${y + 0.9} L ${x + 1.4} ${y - 0.5}`;
  const bothUp = `M ${x - 1.4} ${y - 0.3} L ${x} ${y - 1.7} L ${x + 1.4} ${y - 0.3}`;
  const bothDown = `M ${x - 1.4} ${y + 0.3} L ${x} ${y + 1.7} L ${x + 1.4} ${y + 0.3}`;

  if (which === 'both') {
    return (
      <>
        <path className="map-vertical" d={bothUp} />
        <path className="map-vertical" d={bothDown} />
      </>
    );
  }
  return <path className="map-vertical" d={which === 'up' ? up : down} />;
}

export interface MapPlanProps {
  map: LocalMap;
  /**
   * What the picture shows, when it is a window rather than a fit: the zoom
   * and pan the eye is at, and the box it is being drawn in. See the header.
   */
  viewport?: { view: MapView; box: Box };
  /**
   * What the loud ring is marking, in words.
   *
   * The ring itself is always on the map's centre — `localMap` lays the
   * neighbourhood out from one room and that room is `here` — so this changes
   * only what the picture is *called*. The card centres on the character and
   * says "you"; the route panel centres on the destination and must not, or
   * the one deliberately loud element on screen would be claiming the
   * character is somewhere it is not.
   */
  focus?: 'here' | 'destination' | 'centre';
  /**
   * The room the character is standing in, to ring as *you* when the centre
   * is something else — the builder's map is centred on wherever the reader
   * has taken it, and the character is wherever it is. Only drawn where the
   * map shows that room; absent, the centre wears the ring per `focus`.
   */
  you?: RoomId | null;
  /**
   * Plan a route to a room. Absent where there is nothing to plan — and a room
   * is then drawn as a picture rather than a control, per the rule that a
   * control bound to nowhere is worse than none.
   */
  onChoose?: (map: number, room: number) => void;
  /**
   * The loop builder's own marks: the start in red, every room clicked in
   * green, and every room the planned way runs through in a thinner green.
   * The way itself arrives as `path` and draws as the ordinary trail.
   */
  marks?: BuilderMarks;
  /**
   * Take a way out that leaves the plane — up, down, or a teleport — from a
   * room. Present only on the builder's map, and only then are the ways
   * drawn as controls beside the room, in place of the chevrons the room
   * wears everywhere else: two glyphs saying *up* five units apart, one a
   * mark and one a control, was the map the reader could not tell apart.
   * Everywhere else the chevrons stay a mark, because a control bound to
   * nowhere is worse than none.
   */
  onAway?: (away: MapAway, from: RoomId) => void;
  /**
   * The rooms the walk in progress has still to travel through, opening with
   * the one the character is standing in — `WalkProgress.path`.
   *
   * Drawn over the corridors it walks along, and *only* over corridors this
   * map already draws: a route runs through rooms the projection may have
   * folded away, and a straight line between two placed-but-unjoined rooms
   * would invent a passage. Empty while nothing is being walked.
   */
  path?: readonly RoomId[];
  /**
   * The loop stops this lap has still to reach — `LoopProgress.remainingStops`.
   *
   * Marks rather than a line, because a loop is a list of *places*: the legs
   * between them are planned when they are walked, so the only honest line is
   * the one being walked now, which arrives here as `path`.
   */
  stops?: readonly RoomId[];
  /**
   * A pointer came to rest on a room, or left it: open the room's quick view
   * beside it, and let the caller's linger start.
   *
   * The dwell itself is here, on the room, because that is where the pointer
   * is; what the panel *is* and how long it lingers afterwards belong to the
   * caller, which owns the one-panel-at-a-time rule. Absent where there is
   * nothing to open — a pinned float has no realm of its own to ask.
   */
  onPeek?: (room: RoomId, at: SVGGElement, settled: boolean) => void;
  onPeekEnd?: () => void;
  /**
   * The rooms this realm's find log names — where searching has turned
   * something up.
   *
   * A **mark**, not a kind: `RoomKind` is a closed, priority-ordered union and
   * one shape per room, so folding this into it would fight lairs and shops for
   * the shape and only ever show on a plain room — while "there is something
   * hidden here" is exactly the fact you want beside a lair. Drawn as a dot on
   * the corner instead, over whatever the room already is.
   *
   * A dot rather than a bolder room or a flashing one: a bold room says
   * something about the *room*, and this is a note attached to it; and nothing
   * on this surface animates, which is a rule the console holds and the chrome
   * around it keeps.
   */
  finds?: readonly RoomId[];
}

export interface BuilderMarks {
  start: RoomId | null;
  picks: ReadonlySet<RoomId>;
  through: ReadonlySet<RoomId>;
}

const NO_ROOMS: readonly RoomId[] = [];
const ORIGIN = { x: 0, y: 0 } as const;

function MapPlan({
  map,
  viewport,
  focus = 'here',
  you = null,
  onChoose,
  marks,
  onAway,
  onPeek,
  onPeekEnd,
  path = NO_ROOMS,
  stops = NO_ROOMS,
  finds = NO_ROOMS
}: MapPlanProps) {
  /*
   * Laid out once per neighbourhood, not once per render: a pan re-renders
   * this for a new viewBox a dozen times a second, and the drawing under it
   * has not changed. The picture below is memoised on the same values, so
   * what a pan actually costs is one attribute on one element.
   */
  const drawing = useMemo(() => layoutMap(map), [map]);
  const centre = useMemo(() => drawing.nodes.find((node) => node.here), [drawing]);
  /*
   * Where the character is going, over the map of where it is.
   *
   * Skipped outright when there is nothing planned, so a client standing
   * still pays nothing for a feature it is not using — and `NO_TRAIL` is a
   * constant, so the empty case is the same value on every render.
   */
  const trail = useMemo(
    () =>
      path.length === 0 && stops.length === 0
        ? NO_TRAIL
        : trailOf(drawing, path, stops, tuning().mapTrailBands),
    [drawing, path, stops]
  );

  /*
   * A `Set`, built once per change of the log rather than per drawn room: the
   * question is asked for every cell on the map and the log grows all session,
   * which is the `O(N²)` the standards name.
   */
  const found = useMemo(() => new Set(finds), [finds]);

  /*
   * The viewBox: a window on the drawing where there is one, else the fit.
   *
   * Fitted, the box is padded around the content and then floored to
   * MIN_SPAN — evenly, so the extra room stays centred on what is actually
   * drawn rather than shifting it toward one corner. The pad is the room's
   * own radius plus the furthest anything drawn on a room reaches past it
   * (`MARK_REACH`), so the drawing is inside the box it declares whichever
   * marks are showing. Read here rather than at module scope so an edited
   * radius reaches an open window.
   */
  let viewBox: string;
  if (viewport !== undefined) {
    const shown = viewBoxFor(viewport.view, viewport.box, centre ?? ORIGIN);
    viewBox = `${shown.x} ${shown.y} ${shown.width} ${shown.height}`;
  } else {
    const PAD = tuning().mapRoomRadius + (onAway ? Math.max(MARK_REACH, AWAY_REACH) : MARK_REACH);
    const spanX = Math.max(drawing.width + PAD * 2, MIN_SPAN);
    const spanY = Math.max(drawing.height + PAD * 2, MIN_SPAN);
    const originX = -PAD - (spanX - (drawing.width + PAD * 2)) / 2;
    const originY = -PAD - (spanY - (drawing.height + PAD * 2)) / 2;
    viewBox = `${originX} ${originY} ${spanX} ${spanY}`;
  }

  return (
    <svg
      aria-label={
        focus === 'destination'
          ? t('cards.map.svgAriaLabelDestination', {
              roomCount: map.cells.length,
              roomName: centre?.name ?? t('cards.map.destinationFallback')
            })
          : t('cards.map.svgAriaLabel', {
              roomCount: map.cells.length,
              roomName:
                centre?.name ??
                (focus === 'centre' ? t('cards.map.centreFallback') : t('cards.map.hereFallback'))
            })
      }
      className="map-plan"
      role="img"
      viewBox={viewBox}
    >
      <Picture
        drawing={drawing}
        focus={focus}
        marks={marks}
        onAway={onAway}
        found={found}
        onChoose={onChoose}
        onPeek={onPeek}
        onPeekEnd={onPeekEnd}
        trail={trail}
        you={you}
      />
    </svg>
  );
}

/**
 * Everything inside the SVG, memoised apart from the viewBox around it, so
 * that panning and zooming — which change only where the window is — never
 * reconcile two hundred rooms and their corridors.
 */
const Picture = memo(function Picture({
  drawing,
  focus,
  found,
  marks,
  onAway,
  onChoose,
  onPeek,
  onPeekEnd,
  trail,
  you
}: {
  drawing: MapDrawing;
  focus: 'here' | 'destination' | 'centre';
  /** Rooms the realm's find log names. A `Set`, asked once per drawn room. */
  found: ReadonlySet<RoomId>;
  marks: BuilderMarks | undefined;
  onAway: ((away: MapAway, from: RoomId) => void) | undefined;
  onChoose: ((map: number, room: number) => void) | undefined;
  onPeek: ((room: RoomId, at: SVGGElement, settled: boolean) => void) | undefined;
  onPeekEnd: (() => void) | undefined;
  trail: MapTrail;
  you: RoomId | null;
}) {
  /*
   * The one dwell timer, owned here rather than per room: only one pointer is
   * ever on the picture, so a second room entered has to cancel the first
   * room's countdown rather than run a second one beside it.
   */
  const dwell = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(dwell.current), []);
  return (
    <>
      {/* Corridors first, so a room always sits on top of its own links. */}
      <g className="map-links">
        {drawing.links.map((link, index) => (
          <line
            data-kind={link.obstacle?.kind}
            key={index}
            x1={link.x1}
            x2={link.x2}
            y1={link.y1}
            y2={link.y2}
          >
            {link.obstacle && <title>{link.obstacle.detail}</title>}
          </line>
        ))}
      </g>

      {/*
       * The way ahead, drawn along the corridors it walks.
       *
       * Over the corridors and under the obstacle bars, deliberately: a
       * route through a shut door has to keep looking wrong at the step that
       * will not work, and a line painted over the bar would hide exactly the
       * thing the player needs to see before walking into it.
       */}
      {/*
        `data-band` rather than a stroke chosen here: colour lives in
        `tokens.css`, so what this says is *which pass* the leg belongs to and
        the stylesheet says what that looks like — which is also what lets a
        theme repaint it.

        The arrow is drawn per leg and points the way it is walked, which is
        the whole reason `MapTrailLeg` is oriented by travel rather than by the
        link's own ends. `marker-mid` and friends are deliberately not used: a
        marker inherits the stroke rather than the band's colour without a
        marker element per band, and four of those to avoid one polygon is the
        wrong trade.
      */}
      <g className="map-trail">
        {trail.legs.map((leg, index) => (
          <g data-band={leg.band} key={index}>
            <line x1={leg.x1} x2={leg.x2} y1={leg.y1} y2={leg.y2} />
            <polygon className="map-trail-arrow" points={arrowAt(leg)} />
          </g>
        ))}
      </g>

      {/*
       * What stands in the way, drawn on the corridor rather than on
       * either room: the rooms on both sides of a door are ordinary, and
       * a route that will not work needs to look wrong at the step that
       * will not work.
       */}
      {/*
        The whole corridor is the hover target, not the two-pixel bar
        across it. A mark small enough to read at this scale is far too
        small to point at.
      */}
      <g className="map-reach">
        {drawing.links
          .filter((link) => link.obstacle)
          .map((link, index) => (
            <line key={index} x1={link.x1} x2={link.x2} y1={link.y1} y2={link.y2}>
              <title>{link.obstacle!.detail}</title>
            </line>
          ))}
      </g>

      <g className="map-blocks">
        {drawing.links
          .filter((link) => link.obstacle)
          .map((link, index) => {
            const mx = (link.x1 + link.x2) / 2;
            const my = (link.y1 + link.y2) / 2;
            /*
             * A trap is not a bar. A bar says *shut*, and a trap is not shut:
             * the route walks straight through it and takes the hit, which is
             * the one obstacle on this map the character cannot open, pay or
             * search for. So it is its own shape — the hazard triangle,
             * upright whichever way the corridor runs, because it is a glyph
             * rather than a gate across the passage. It was a bar in a second
             * hue for as long as the map existed, and §6 says hue alone may
             * not carry a condition: the legend had no entry for it and a red
             * bar beside an amber one read as a door of another kind.
             */
            if (link.obstacle!.kind === 'trap') {
              return (
                <polygon
                  className="map-trap"
                  data-kind="trap"
                  key={index}
                  points={trapPoints(mx, my)}
                >
                  <title>{link.obstacle!.detail}</title>
                </polygon>
              );
            }
            // Across the corridor, so it reads as a bar in the way rather
            // than a mark beside it.
            const along = Math.atan2(link.y2 - link.y1, link.x2 - link.x1);
            const nx = Math.cos(along + Math.PI / 2) * 2.1;
            const ny = Math.sin(along + Math.PI / 2) * 2.1;
            return (
              <line
                data-kind={link.obstacle!.kind}
                key={index}
                x1={mx - nx}
                x2={mx + nx}
                y1={my - ny}
                y2={my + ny}
              >
                <title>{link.obstacle!.detail}</title>
              </line>
            );
          })}
      </g>

      {drawing.nodes.map((node) => {
        const pick = onChoose;
        /*
         * What a click on a room does.
         *
         * **Where a room has a quick view, the click opens it and the panel
         * carries the walk** — the room's facts are read before the way there
         * is planned, and the plan is one button further on rather than one
         * mis-click away. Where it has none — the loop builder, whose clicks
         * are picks — the click is the caller's, unchanged.
         *
         * Settled, not hovered: a click nails the panel down, so it survives
         * the pointer leaving on its way to the button.
         */
        const peekHere = onPeek;
        const choose =
          peekHere !== undefined
            ? (at: SVGGElement): void => peekHere(node.id, at, true)
            : pick !== undefined
              ? (): void => {
                  const [mapId, roomId] = node.id.split('/');
                  pick(Number(mapId), Number(roomId));
                }
              : undefined;
        /*
         * A room is a control only where there is somewhere to send the click.
         * Absent a handler it is drawn as a picture, per the standing rule that
         * a control bound to nowhere is worse than none — and `role="button"`
         * on an element that does nothing announces one to a screen reader.
         */
        const control = choose
          ? {
              onClick: (event: ReactMouseEvent<SVGGElement>): void => choose(event.currentTarget),
              onMouseDown: keepFocus,
              onKeyDown: (event: KeyboardEvent<SVGGElement>): void => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                choose(event.currentTarget);
              },
              role: 'button',
              tabIndex: 0
            }
          : {};
        /*
         * A pointer resting on a room opens its quick view; leaving it starts
         * the caller's linger. The dwell is here rather than in the caller
         * because it is a property of *this* pointer on *this* room — sweeping
         * across a map is a dozen rooms a second, and one panel per room
         * crossed is two hundred queries for one question.
         *
         * `onPointerEnter`, not `onPointerOver`: a room is a group of shapes
         * and `over` fires again for every child crossed inside it, which
         * would restart the dwell at each and mean a slow hand never opened
         * anything. Cleared on the way out and when the element goes.
         */
        const peek =
          onPeek === undefined
            ? {}
            : {
                onPointerEnter: (event: ReactPointerEvent<SVGGElement>): void => {
                  const at = event.currentTarget;
                  window.clearTimeout(dwell.current);
                  dwell.current = window.setTimeout(
                    () => onPeek(node.id, at, false),
                    tuning().roomPeekDelayMs
                  );
                },
                onPointerLeave: (): void => {
                  window.clearTimeout(dwell.current);
                  onPeekEnd?.();
                }
              };
        return (
          <g
            className="map-room"
            data-kind={node.kind}
            data-room={node.id}
            key={node.id}
            {...control}
            {...peek}
          >
            <title>{t('cards.map.roomTooltip', { roomName: node.name })}</title>
            {/*
             * A room the route still has to enter. Behind the shape rather
             * than instead of it: what a room *is* — a lair, a shop, a way
             * down — is the reason to look at the map while walking through
             * it, so the route says "through here" around the room's own
             * mark instead of painting over it.
             */}
            {/* Not under the builder's own rings: the halo sits at the same
                radius as the pick ring, and a disc behind a ring is a ring
                nobody can tell from the next one. */}
            {marks === undefined && trail.rooms.has(node.id) && (
              <circle
                className="map-onroute"
                cx={node.x}
                cy={node.y}
                r={tuning().mapRoomRadius + MARKS.onroute.over}
                strokeWidth={MARKS.onroute.stroke}
              />
            )}
            {/*
             * A place this lap still owes. Not drawn on the room the
             * character is standing in, however: the loud ring below already
             * says it is there, and two rings on one room is one ring too
             * many for a map read at a glance.
             */}
            {/*
             * Something has been found here by searching. On the corner rather
             * than around the room, so it never has to compete with the route
             * halo, a lap's stop ring or the loud ring on the room the
             * character is standing in — all of which are about *now*, where
             * this is about what the realm has been hiding.
             */}
            {found.has(node.id) && (
              <circle
                className="map-find"
                cx={node.x + tuning().mapRoomRadius}
                cy={node.y - tuning().mapRoomRadius}
                r={FIND_DOT}
              />
            )}
            {trail.stops.has(node.id) && !node.here && (
              <circle
                className="map-stop"
                cx={node.x}
                cy={node.y}
                r={tuning().mapRoomRadius + MARKS.stop.over}
                strokeWidth={MARKS.stop.stroke}
              />
            )}
            {/*
             * The builder's rings, under the shape for the route halo's
             * reason: what a room *is* stays readable through them. The
             * start is the loud one — the red ring the request asked for —
             * a pick is a heavier green ring than a room merely walked
             * through, so the two kinds of green say which rooms were chosen
             * and which the planner filled in.
             */}
            {marks !== undefined && marks.start === node.id && (
              <circle
                className="map-start"
                cx={node.x}
                cy={node.y}
                r={tuning().mapRoomRadius + MARKS.start.over}
                strokeWidth={MARKS.start.stroke}
              />
            )}
            {marks !== undefined && marks.start !== node.id && marks.picks.has(node.id) && (
              <circle
                className="map-pick"
                cx={node.x}
                cy={node.y}
                r={tuning().mapRoomRadius + MARKS.pick.over}
                strokeWidth={MARKS.pick.stroke}
              />
            )}
            {marks !== undefined &&
              marks.start !== node.id &&
              !marks.picks.has(node.id) &&
              marks.through.has(node.id) && (
                <circle
                  className="map-through"
                  cx={node.x}
                  cy={node.y}
                  r={tuning().mapRoomRadius + MARKS.through.over}
                  strokeWidth={MARKS.through.stroke}
                />
              )}
            {/* The one deliberately loud element on the surface, spent on the
              only question it is asked under pressure: which one is me — or, in
              the route panel, which one am I being sent to. On a map centred
              on wherever the reader took it, the centre claims nothing and the
              ring goes on the character's own room, if it is in view. */}
            {(focus === 'centre' ? you === node.id : node.here) && (
              <circle
                className="map-you"
                cx={node.x}
                cy={node.y}
                r={tuning().mapRoomRadius + MARKS.you.over}
                strokeWidth={MARKS.you.stroke}
              />
            )}
            {shape(node)}
            {/*
             * A room that also leads up or down. The plane cannot show it —
             * placing what is up there would draw two rooms in one square
             * and call it a floor plan — so the room carries a mark instead.
             * Not on a builder's map, where the way is a control beside the
             * room and a second chevron inside it was the one the reader
             * clicked, expecting to go up.
             */}
            {onAway === undefined && node.vertical !== null && (
              <Vertical which={node.vertical} x={node.x} y={node.y} />
            )}
          </g>
        );
      })}

      {/*
       * The ways out that leave the plane, as controls, beside the rooms that
       * have them — only where there is something to send the click to. Each
       * one names where it goes, because *up* is not an answer and *up to
       * Rocky Ledge* is. Drawn after every room so a control is never under
       * a neighbour's shape.
       */}
      {onAway !== undefined &&
        drawing.nodes.flatMap((node) =>
          (node.away ?? []).map((away, index) => (
            <AwayControl
              away={away}
              index={index}
              key={`${node.id}:${away.kind}:${away.to}`}
              node={node}
              onAway={onAway}
            />
          ))
        )}
    </>
  );
});

/**
 * One way out of a room that the plane cannot draw, as a control.
 *
 * Up sits above the room's right shoulder, down below it, a teleport off its
 * left — fixed places, so two rooms side by side with a way up each read the
 * same way. The glyphs are the chevrons the room wears on every other map and
 * a ring-with-a-dot for a teleport, which is the mark the legend keys. A
 * press keeps the caret in the game like every other click on a map.
 *
 * What a press *does* is the builder's to say: the chevrons take the eye to
 * the level they lead to, the teleport adds itself to the way. The title
 * says which, because a control that looks like its neighbour and does
 * something else has to say so before it is pressed.
 */
function AwayControl({
  away,
  index,
  node,
  onAway
}: {
  away: MapAway;
  index: number;
  node: MapNode;
  onAway: (away: MapAway, from: RoomId) => void;
}) {
  const r = tuning().mapRoomRadius;
  const dx = away.kind === 'teleport' ? -(r + AWAY.over) : r + AWAY.over;
  // A room with several ways of one kind stacks them outward.
  const dy = (away.kind === 'up' ? -1 : away.kind === 'down' ? 1 : 0) * (AWAY.size + 0.6);
  const x = node.x + dx + (away.kind === 'teleport' ? -index * (AWAY.size * 2 + 0.6) : 0);
  const y = node.y + dy;
  const where =
    away.kind === 'up'
      ? t('cards.map.away.up', { roomName: away.name })
      : away.kind === 'down'
        ? t('cards.map.away.down', { roomName: away.name })
        : t('cards.map.away.teleport', { command: away.command, roomName: away.name });
  // The price the realm stated, beside the way: a door on the way up is
  // said here, where the corridor's bar would say it on the plane.
  const label = away.obstacle === undefined ? where : `${where} — ${away.obstacle.detail}`;
  const take = (): void => onAway(away, node.id);
  return (
    <g
      className="map-away"
      data-gated={away.obstacle === undefined ? undefined : away.obstacle.kind}
      data-kind={away.kind}
      onClick={(event) => {
        // The room underneath is a control too; a way out is not a pick.
        event.stopPropagation();
        take();
      }}
      onKeyDown={(event: KeyboardEvent<SVGGElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        take();
      }}
      onMouseDown={keepFocus}
      role="button"
      tabIndex={0}
    >
      <title>{label}</title>
      {/* The hit target: a glyph this small cannot be pointed at. */}
      <circle className="map-away-hit" cx={x} cy={y} r={AWAY.size + AWAY.hit} />
      {away.kind === 'teleport' ? (
        <TeleportGlyph size={AWAY.size} x={x} y={y} />
      ) : (
        <path
          className="map-away-glyph"
          d={
            away.kind === 'up'
              ? `M ${x - AWAY.size} ${y + AWAY.size * 0.5} L ${x} ${y - AWAY.size * 0.6} L ${x + AWAY.size} ${y + AWAY.size * 0.5}`
              : `M ${x - AWAY.size} ${y - AWAY.size * 0.5} L ${x} ${y + AWAY.size * 0.6} L ${x + AWAY.size} ${y - AWAY.size * 0.5}`
          }
          strokeWidth={AWAY.stroke}
        />
      )}
      {/*
       * Something in the way — a door on the stairs, a level the portal
       * wants — is a bar across the glyph, the corridor's own mark for a
       * shut passage, and not a hue alone: §6, and the trap's lesson above.
       */}
      {away.obstacle !== undefined && <GatedBar size={AWAY.size} x={x} y={y} />}
    </g>
  );
}

/** The bar across a way out with something in it: the door's mark, on the glyph. */
function GatedBar({ size, x, y }: { size: number; x: number; y: number }) {
  return (
    <line
      className="map-away-bar"
      strokeWidth={AWAY.stroke}
      x1={x - size - 0.4}
      x2={x + size + 0.4}
      y1={y}
      y2={y}
    />
  );
}

/**
 * A teleport's mark: a ring with a dot in it, which reads as *a hole to
 * somewhere* at any size the map draws it, where a swirl turns to mush.
 */
function TeleportGlyph({ size, x, y }: { size: number; x: number; y: number }) {
  return (
    <>
      <circle className="map-away-glyph" cx={x} cy={y} r={size} strokeWidth={AWAY.stroke} />
      <circle className="map-away-dot" cx={x} cy={y} r={size * 0.35} />
    </>
  );
}

/**
 * What the shapes mean, listed whether or not one of them is in view.
 *
 * A legend that gained an entry only when a door was on screen changed the
 * card's height as the character walked, and every control below it moved
 * under the pointer — which is the whole reason the map card is a fixed box.
 */
export function MapLegend({ builder = false }: { builder?: boolean } = {}) {
  return (
    <div className="map-legend">
      <span data-kind="here">
        <svg aria-hidden="true" className="key" viewBox="-6 -6 12 12">
          <circle className="map-you" cx="0" cy="0" r="5.2" />
          <rect className="map-shape" height="6" rx="1.1" width="6" x="-3" y="-3" />
        </svg>
        {t('cards.map.legendYou')}
      </span>
      {/*
        The route and the lap, listed like every other symbol whether or not
        anything is being walked. A key that appeared when a route was planned
        would change the card's height mid-walk, which is the churn the fixed
        box exists to prevent.
      */}
      {/*
        The builder draws neither the halo nor a lap's stops; its own keys
        below say what its rings mean, and a key for a mark the picture never
        makes is a legend to nothing.
      */}
      {!builder && (
        <>
          <span data-kind="route">
            <svg aria-hidden="true" className="key" viewBox="-6 -6 12 12">
              <g className="map-trail">
                <line x1="-5" x2="5" y1="0" y2="0" />
                <polygon
                  className="map-trail-arrow"
                  points={arrowAt({ x1: -5, y1: 0, x2: 5, y2: 0 }, 2.4)}
                />
              </g>
              <circle className="map-onroute" cx="0" cy="0" r="4.6" />
              <rect className="map-shape" height="6" rx="1.1" width="6" x="-3" y="-3" />
            </svg>
            {t('cards.map.legendRoute')}
          </span>
          <span data-kind="stop">
            <svg aria-hidden="true" className="key" viewBox="-6 -6 12 12">
              <circle className="map-stop" cx="0" cy="0" r="5.2" />
              <rect className="map-shape" height="6" rx="1.1" width="6" x="-3" y="-3" />
            </svg>
            {t('cards.map.legendStop')}
          </span>
        </>
      )}
      {/*
        Listed whether or not one is in view, like every key here: the absence
        of a symbol is itself a fact, and a legend that changed as the character
        walked would change the card's height while it was being read.
      */}
      <span data-kind="find">
        <svg aria-hidden="true" className="key" viewBox="-6 -6 12 12">
          <rect className="map-shape" height="6" rx="1.1" width="6" x="-3" y="-3" />
          <circle className="map-find" cx="3" cy="-3" r="1.6" />
        </svg>
        {t('cards.map.legendFind')}
      </span>
      <span data-kind="shop">
        <svg aria-hidden="true" className="key" viewBox="-6 -6 12 12">
          <circle className="map-shape" cx="0" cy="0" r="3" />
        </svg>
        {t('cards.map.legendShop')}
      </span>
      <span data-kind="bank">
        <svg aria-hidden="true" className="key" viewBox="-6 -6 12 12">
          <circle className="map-shape" cx="0" cy="0" r="3.4" />
          <text className="map-bank" textAnchor="middle" x="0" y="1.5">
            $
          </text>
        </svg>
        {t('cards.map.legendBank')}
      </span>
      <span data-kind="lair">
        <svg aria-hidden="true" className="key" viewBox="-6 -6 12 12">
          <polygon className="map-shape" points="0,-3.6 3.6,0 0,3.6 -3.6,0" />
        </svg>
        {t('cards.map.legendLair')}
      </span>
      {/*
        A way up or down: the chevrons the room wears, or — on the builder's
        map, where they are controls beside the room — the chevrons where the
        controls sit, keyed with what a press does. The same glyph in the same
        place as on the picture, so the key looks like the thing it names.
      */}
      {builder ? (
        <span data-kind="look">
          <svg aria-hidden="true" className="key" viewBox="-6 -6 12 12">
            <rect className="map-shape" height="6" rx="1.1" width="6" x="-5" y="-3" />
            <g className="map-away">
              <path className="map-away-glyph" d="M 2 -1.2 L 3.6 -3 L 5.2 -1.2" strokeWidth="0.8" />
              <path className="map-away-glyph" d="M 2 1.2 L 3.6 3 L 5.2 1.2" strokeWidth="0.8" />
            </g>
          </svg>
          {t('cards.map.legendLook')}
        </span>
      ) : (
        <span>
          <svg aria-hidden="true" className="key" viewBox="-6 -6 12 12">
            <rect className="map-shape" height="6" rx="1.1" width="6" x="-3" y="-3" />
            <path className="map-vertical" d="M -1.4 -0.3 L 0 -1.7 L 1.4 -0.3" />
            <path className="map-vertical" d="M -1.4 0.3 L 0 1.7 L 1.4 0.3" />
          </svg>
          {t('cards.map.legendVertical')}
        </span>
      )}
      {/*
        Always, even where nothing is shut. A key that appears and
        disappears as you walk changes the card's height with it, and the
        controls below move under the pointer — which is the whole reason
        this card is a fixed box.
      */}
      <span data-kind="door">
        <svg aria-hidden="true" className="key" viewBox="-6 -6 12 12">
          <g className="map-blocks">
            <line x1="-4" x2="4" y1="0" y2="0" />
            <line data-kind="door" x1="0" x2="0" y1="-3.4" y2="3.4" />
          </g>
        </svg>
        {t('cards.map.legendShut')}
      </span>
      {/*
        A trap, listed for the same reason as the door: the realm has 305 of
        them and a key that appeared only when one was in view would move the
        card's picture as the character walked.
      */}
      <span data-kind="trap">
        <svg aria-hidden="true" className="key" viewBox="-6 -6 12 12">
          <g className="map-blocks">
            <line x1="-5" x2="5" y1="1" y2="1" />
          </g>
          {/* Scaled up to the key's 12-unit box, the way the door's bar is. */}
          <polygon className="map-trap" points={trapPoints(0, 0.6, 2.2)} />
        </svg>
        {t('cards.map.legendTrap')}
      </span>
      {/*
        The builder's own marks, on the builder's map only: a legend on the
        Map card for rings that card never draws would be a key to nothing.
        Listed always while the builder is open, for the reason every other
        key is.
      */}
      {builder && (
        <>
          <span data-kind="start">
            <svg aria-hidden="true" className="key" viewBox="-6 -6 12 12">
              <circle className="map-start" cx="0" cy="0" r="5.2" />
              <rect className="map-shape" height="6" rx="1.1" width="6" x="-3" y="-3" />
            </svg>
            {t('cards.map.legendStart')}
          </span>
          <span data-kind="pick">
            <svg aria-hidden="true" className="key" viewBox="-6 -6 12 12">
              <circle className="map-pick" cx="0" cy="0" r="4.8" />
              <rect className="map-shape" height="6" rx="1.1" width="6" x="-3" y="-3" />
            </svg>
            {t('cards.map.legendPick')}
          </span>
          <span data-kind="through">
            <svg aria-hidden="true" className="key" viewBox="-6 -6 12 12">
              <g className="map-trail">
                <line x1="-5" x2="5" y1="0" y2="0" />
                <polygon
                  className="map-trail-arrow"
                  points={arrowAt({ x1: -5, y1: 0, x2: 5, y2: 0 }, 2.4)}
                />
              </g>
              <circle className="map-through" cx="0" cy="0" r="4.8" />
              <rect className="map-shape" height="6" rx="1.1" width="6" x="-3" y="-3" />
            </svg>
            {t('cards.map.legendThrough')}
          </span>
          {/*
            The way doubling back over itself, which is the one thing a lap
            does that a route does not — so the key is here and not on the Map
            card, where a legend for a colour that picture can never draw would
            be a key to nothing.
          */}
          <span data-kind="again">
            <svg aria-hidden="true" className="key" viewBox="-6 -6 12 12">
              <g className="map-trail" data-band="1">
                <line x1="-5" x2="5" y1="0" y2="0" />
                <polygon
                  className="map-trail-arrow"
                  points={arrowAt({ x1: -5, y1: 0, x2: 5, y2: 0 }, 2.4)}
                />
              </g>
            </svg>
            {t('cards.map.legendAgain')}
          </span>
          <span data-kind="teleport">
            <svg aria-hidden="true" className="key" viewBox="-6 -6 12 12">
              <g className="map-away">
                <TeleportGlyph size={3.4} x={0} y={0} />
              </g>
            </svg>
            {t('cards.map.legendTeleport')}
          </span>
          {/* A way out with something in it — listed always, like the door. */}
          <span data-kind="gated">
            <svg aria-hidden="true" className="key" viewBox="-6 -6 12 12">
              <g className="map-away" data-gated="door">
                <path
                  className="map-away-glyph"
                  d="M -3.4 1.7 L 0 -2.4 L 3.4 1.7"
                  strokeWidth="0.8"
                />
                <GatedBar size={3.4} x={0} y={1.2} />
              </g>
            </svg>
            {t('cards.map.legendGated')}
          </span>
        </>
      )}
    </div>
  );
}

export default memo(MapPlan);
