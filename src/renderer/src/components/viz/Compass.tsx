/**
 * A room's ways out drawn where they lead: the eight compass points around a
 * hub, with up and down in a column beside it, each a tile in the world
 * database's short code (`n`, `ne`). A way that is there is lit, one with a
 * note (`closed door`) is tinted, one that is not there is a faint slot, and
 * exits nobody could read are dashed slots, never empty ones. The hub holds
 * whatever the caller puts there: a dot, or the room's picture. See
 * `mudengine-ui` › `parts/viz.md`.
 */
import { memo, type ReactNode } from 'react';

/** The ten slots, in the order they are laid out and read. */
export const COMPASS_POINTS = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se', 'u', 'd'] as const;
export type CompassPoint = (typeof COMPASS_POINTS)[number];

export interface CompassWay {
  point: CompassPoint;
  /** `open`, or `noted` where the room says something stands in it. */
  state: 'open' | 'noted';
  /** The direction in words, with its note: the tile's hover text. */
  title: string;
}

function Compass({
  ways,
  label,
  children
}: {
  /** Null while the exits are unseen: every slot is drawn as not known. */
  ways: readonly CompassWay[] | null;
  label: string;
  children?: ReactNode;
}) {
  const byPoint = new Map((ways ?? []).map((way) => [way.point, way]));
  return (
    <div aria-label={label} className="compass" role="img">
      {COMPASS_POINTS.map((point) => {
        const way = byPoint.get(point);
        return (
          <span
            className="compass-way"
            data-point={point}
            data-state={ways === null ? 'unknown' : (way?.state ?? 'none')}
            key={point}
            title={way?.title}
          >
            {way !== undefined && point}
          </span>
        );
      })}
      <span className="compass-hub">
        {children ?? <i aria-hidden="true" className="compass-dot" />}
      </span>
    </div>
  );
}

export default memo(Compass);
