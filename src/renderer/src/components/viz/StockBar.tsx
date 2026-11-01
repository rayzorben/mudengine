/**
 * How many are carried against the most to keep, with a tick at the fewest:
 * a supply row's stock as a hairline under its figure. Short of the minimum
 * is drawn in the danger ink, at or over it in the ok ink. A count nobody has
 * read is no bar at all, never an empty one. See `mudengine-ui` ›
 * `parts/viz.md`.
 */
import { memo, type CSSProperties } from 'react';

function StockBar({ have, min, max }: { have: number; min: number; max: number }) {
  // The scale is the larger of the ceiling and what is carried, so an
  // overstock reads as a full bar rather than spilling past its track.
  const top = Math.max(1, max, min, have);
  return (
    <span
      aria-hidden="true"
      className="stock-bar"
      data-short={have < min}
      style={{ '--share': have / top, '--floor': min / top } as CSSProperties}
    >
      {min > 0 && <i />}
    </span>
  );
}

export default memo(StockBar);
