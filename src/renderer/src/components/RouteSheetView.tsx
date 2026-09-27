/**
 * A page of the route preview that holds several short stretches: each floor
 * drawn with the live map's own picture (`Picture`), tilted and stacked when
 * the route climbs or descends between them, side by side when it jumps any
 * other way, with the join drawn between the end of one stretch and the start
 * of the next. Fitted to its box; the pager moves between pages. Where the
 * floors go is `layoutSheet`'s. See `mudengine-ui` › `parts/map.md` ›
 * *The route preview*.
 */
import { memo, useMemo } from 'react';

import { arrowAt, MapLegend, Picture } from './MapPlan';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { FLOOR_PAD, layoutSheet, type SheetJoin } from '../lib/routeSheet';
import { tuning } from '../lib/tuning';
import type { RouteSheet } from '@shared/routeLegs';
import type { RoomId } from '@shared/world';

export interface RouteSheetViewProps {
  sheet: RouteSheet;
  /** The character's room, ringed where a floor shows it. */
  you: RoomId | null;
  /** Rooms to ring as where the page ends. */
  stops: readonly RoomId[];
  /** Rooms the find log names. */
  finds: readonly RoomId[];
  onPeek?: (room: RoomId, at: SVGGElement, settled: boolean) => void;
  onPeekEnd?: () => void;
}

/**
 * Where a join's badge and label sit, in room radii from the join's middle:
 * the badge beside the line so the arrow on it stays clear, the label past
 * the badge, and the text dropped to sit on the badge's middle.
 */
const JOIN = { badge: 1.6, label: 3, baseline: 0.4 } as const;

/** The glyph on a join's badge. The realm's own words stay in code. */
const GLYPH = { up: '▲', down: '▼', jump: '…', onward: '…' } as const;

function JoinMark({ join }: { join: SheetJoin }) {
  const mx = (join.x1 + join.x2) / 2;
  const my = (join.y1 + join.y2) / 2;
  const command = join.step?.command ?? null;
  /* The bare `u` and `d` say nothing the arrow does not. */
  const said = command !== null && command !== join.step?.direction ? command : null;
  const title =
    command === null
      ? t('cards.map.sheet.onward', { roomName: join.name })
      : t('cards.map.sheet.join', { command, roomName: join.name });
  const badge = tuning().mapRoomRadius;
  return (
    <g className="map-join" data-kind={join.kind}>
      <title>{title}</title>
      <line x1={join.x1} x2={join.x2} y1={join.y1} y2={join.y2} />
      <polygon className="map-join-arrow" points={arrowAt(join)} />
      <circle className="map-join-badge" cx={mx + badge * JOIN.badge} cy={my} r={badge} />
      <text
        className="map-join-glyph"
        textAnchor="middle"
        x={mx + badge * JOIN.badge}
        y={my + badge * JOIN.baseline}
      >
        {GLYPH[join.kind]}
      </text>
      {said !== null && (
        <text className="map-join-label" x={mx + badge * JOIN.label} y={my + badge * JOIN.baseline}>
          {said}
        </text>
      )}
    </g>
  );
}

function RouteSheetView({ sheet, you, stops, finds, onPeek, onPeekEnd }: RouteSheetViewProps) {
  const layout = useMemo(() => layoutSheet(sheet, stops, tuning().mapTrailBands), [sheet, stops]);
  const found = useMemo(() => new Set(finds), [finds]);
  const { x, y, width, height } = layout.box;
  const room = tuning().mapRoomRadius;
  return (
    <div className="map-box">
      <div className="map-view map-sheet" onMouseDown={keepFocus}>
        <svg
          aria-label={t('cards.map.sheet.ariaLabel', { count: sheet.stretches.length })}
          className="map-plan"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          viewBox={`${x - room} ${y - room} ${width + room * 2} ${height + room * 2}`}
        >
          {layout.floors.map((floor, index) => (
            <g
              className="map-floor"
              data-level={floor.level}
              key={index}
              transform={floor.transform}
            >
              <rect
                className="map-floor-plane"
                height={floor.drawing.height + FLOOR_PAD * 2}
                rx={FLOOR_PAD / 2}
                width={floor.drawing.width + FLOOR_PAD * 2}
                x={-FLOOR_PAD}
                y={-FLOOR_PAD}
              />
              <Picture
                drawing={floor.drawing}
                focus="centre"
                found={found}
                marks={undefined}
                onChoose={undefined}
                onLook={undefined}
                onPeek={onPeek}
                onPeekEnd={onPeekEnd}
                onTeleport={undefined}
                trail={floor.trail}
                you={you}
              />
            </g>
          ))}
          <g className="map-joins">
            {layout.joins.map((join, index) => (
              <JoinMark join={join} key={index} />
            ))}
          </g>
        </svg>
      </div>
      <MapLegend />
    </div>
  );
}

export default memo(RouteSheetView);
