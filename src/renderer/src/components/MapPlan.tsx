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
 * the character is standing, the folded-rooms badge and the empty state.
 *
 * Drawn as vector shapes. It was character cells first, on the argument that
 * the game draws its own maps that way — but this map is not the game's. It is
 * derived by the client and never crosses the wire, so the character-cell rule
 * that governs the console does not reach it. It is chrome, and chrome follows
 * the design language.
 */
import { memo, type KeyboardEvent } from 'react';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { layoutMap, MAP_CELL, NO_TRAIL, trailOf, type LocalMap, type MapNode } from '@shared/map';
import type { RoomId } from '@shared/world';
import { tuning } from '../lib/tuning';

/**
 * The smallest neighbourhood the viewBox will ever claim to be, in map units
 * (`MAP_CELL` apart per room).
 *
 * The viewBox is what makes a wide neighbourhood draw smaller rather than
 * taller — but run that the other way, on a one-room map like the Halls of
 * the Dead, and the single room is "the whole neighbourhood" and gets scaled
 * up to fill the box. A floor on the span keeps a lone room drawn at roughly
 * the size it would be as part of a small cluster, about four rooms across,
 * instead of ballooning to the size of the card.
 */
const MIN_SPAN = MAP_CELL * 4;

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
   * What the loud ring is marking, in words.
   *
   * The ring itself is always on the map's centre — `localMap` lays the
   * neighbourhood out from one room and that room is `here` — so this changes
   * only what the picture is *called*. The card centres on the character and
   * says "you"; the route panel centres on the destination and must not, or
   * the one deliberately loud element on screen would be claiming the
   * character is somewhere it is not.
   */
  focus?: 'here' | 'destination';
  /**
   * Plan a route to a room. Absent where there is nothing to plan — and a room
   * is then drawn as a picture rather than a control, per the rule that a
   * control bound to nowhere is worse than none.
   */
  onChoose?: (map: number, room: number) => void;
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
}

const NO_ROOMS: readonly RoomId[] = [];

function MapPlan({
  map,
  focus = 'here',
  onChoose,
  path = NO_ROOMS,
  stops = NO_ROOMS
}: MapPlanProps) {
  const drawing = layoutMap(map);
  const centre = drawing.nodes.find((node) => node.here);
  /*
   * Where the character is going, over the map of where it is.
   *
   * Skipped outright when there is nothing planned, so a client standing
   * still pays nothing for a feature it is not using — and `NO_TRAIL` is a
   * constant, so the empty case is the same value on every render.
   */
  const trail = path.length === 0 && stops.length === 0 ? NO_TRAIL : trailOf(drawing, path, stops);

  /*
   * Padded around the content, then floored to MIN_SPAN — evenly, so the extra
   * room stays centred on what is actually drawn rather than shifting it toward
   * one corner. The pad is the room's own radius plus a little, read here
   * rather than at module scope so an edited radius reaches an open window.
   */
  const PAD = tuning().mapRoomRadius + 2;
  const spanX = Math.max(drawing.width + PAD * 2, MIN_SPAN);
  const spanY = Math.max(drawing.height + PAD * 2, MIN_SPAN);
  const originX = -PAD - (spanX - (drawing.width + PAD * 2)) / 2;
  const originY = -PAD - (spanY - (drawing.height + PAD * 2)) / 2;

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
              roomName: centre?.name ?? t('cards.map.hereFallback')
            })
      }
      className="map-plan"
      role="img"
      viewBox={`${originX} ${originY} ${spanX} ${spanY}`}
    >
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
      <g className="map-trail">
        {trail.legs.map((leg, index) => (
          <line key={index} x1={leg.x1} x2={leg.x2} y1={leg.y1} y2={leg.y2} />
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
        const choose =
          pick === undefined
            ? undefined
            : (): void => {
                const [mapId, roomId] = node.id.split('/');
                pick(Number(mapId), Number(roomId));
              };
        /*
         * A room is a control only where there is somewhere to send the click.
         * Absent a handler it is drawn as a picture, per the standing rule that
         * a control bound to nowhere is worse than none — and `role="button"`
         * on an element that does nothing announces one to a screen reader.
         */
        const control = choose
          ? {
              onClick: choose,
              onMouseDown: keepFocus,
              onKeyDown: (event: KeyboardEvent<SVGGElement>): void => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                choose();
              },
              role: 'button',
              tabIndex: 0
            }
          : {};
        return (
          <g className="map-room" data-kind={node.kind} key={node.id} {...control}>
            <title>{t('cards.map.roomTooltip', { roomName: node.name })}</title>
            {/*
             * A room the route still has to enter. Behind the shape rather
             * than instead of it: what a room *is* — a lair, a shop, a way
             * down — is the reason to look at the map while walking through
             * it, so the route says "through here" around the room's own
             * mark instead of painting over it.
             */}
            {trail.rooms.has(node.id) && (
              <circle
                className="map-onroute"
                cx={node.x}
                cy={node.y}
                r={tuning().mapRoomRadius + 1.6}
              />
            )}
            {/*
             * A place this lap still owes. Not drawn on the room the
             * character is standing in, however: the loud ring below already
             * says it is there, and two rings on one room is one ring too
             * many for a map read at a glance.
             */}
            {trail.stops.has(node.id) && !node.here && (
              <circle
                className="map-stop"
                cx={node.x}
                cy={node.y}
                r={tuning().mapRoomRadius + 2.2}
              />
            )}
            {/* The one deliberately loud element on the surface, spent on the
              only question it is asked under pressure: which one is me — or, in
              the route panel, which one am I being sent to. */}
            {node.here && (
              <circle
                className="map-you"
                cx={node.x}
                cy={node.y}
                r={tuning().mapRoomRadius + 2.2}
              />
            )}
            {shape(node)}
            {/*
             * A room that also leads up or down. The plane cannot show it —
             * placing what is up there would draw two rooms in one square
             * and call it a floor plan — so the room carries a mark instead.
             */}
            {node.vertical !== null && <Vertical which={node.vertical} x={node.x} y={node.y} />}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * What the shapes mean, listed whether or not one of them is in view.
 *
 * A legend that gained an entry only when a door was on screen changed the
 * card's height as the character walked, and every control below it moved
 * under the pointer — which is the whole reason the map card is a fixed box.
 */
export function MapLegend() {
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
      <span data-kind="route">
        <svg aria-hidden="true" className="key" viewBox="-6 -6 12 12">
          <g className="map-trail">
            <line x1="-5" x2="5" y1="0" y2="0" />
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
      <span>
        <svg aria-hidden="true" className="key" viewBox="-6 -6 12 12">
          <rect className="map-shape" height="6" rx="1.1" width="6" x="-3" y="-3" />
          <path className="map-vertical" d="M -1.4 -0.3 L 0 -1.7 L 1.4 -0.3" />
          <path className="map-vertical" d="M -1.4 0.3 L 0 1.7 L 1.4 0.3" />
        </svg>
        {t('cards.map.legendVertical')}
      </span>
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
    </div>
  );
}

export default memo(MapPlan);
