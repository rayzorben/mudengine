/**
 * A lap as a ring of its stops: one node per stop round a circle, read
 * clockwise from the top, in the progression's three words (`done` quiet,
 * `now` the accent, `left` ordinary ink), with the arc drawn up to the stop
 * being walked to. A lap not running has no `now`, and every node is `left`.
 * The middle holds what the caller puts there. See `mudengine-ui` ›
 * `parts/viz.md`.
 */
import { memo, type ReactNode } from 'react';

const R = 16;
/** The node's radius, smaller as the stops crowd the circle. */
function nodeRadius(stops: number): number {
  return Math.max(1.2, Math.min(2.8, 40 / Math.max(1, stops)));
}

function LapRing({
  stops,
  at,
  label,
  children
}: {
  stops: number;
  /** The stop walked to, one-based, or 0 while the lap is not running. */
  at: number;
  label: string;
  children?: ReactNode;
}) {
  const r = nodeRadius(stops);
  // The arc runs to the node being walked to, so it meets the loud node rather than passing it.
  const share = stops > 0 && at > 1 ? Math.min(1, (at - 1) / stops) : 0;
  return (
    <span aria-label={label} className="lap-ring" role="img">
      <svg aria-hidden="true" viewBox="0 0 40 40">
        <circle className="lap-ring-track" cx="20" cy="20" r={R} />
        {share > 0 && (
          <circle
            className="lap-ring-arc"
            cx="20"
            cy="20"
            pathLength={100}
            r={R}
            strokeDasharray={`${share * 100} 100`}
            transform="rotate(-90 20 20)"
          />
        )}
        {Array.from({ length: stops }, (_, index) => {
          const angle = (index / stops) * Math.PI * 2 - Math.PI / 2;
          return (
            <circle
              className="lap-ring-stop"
              cx={20 + R * Math.cos(angle)}
              cy={20 + R * Math.sin(angle)}
              data-progress={
                at === 0 ? 'left' : index < at - 1 ? 'done' : index === at - 1 ? 'now' : 'left'
              }
              key={index}
              r={index === at - 1 ? r * 1.5 : r}
            />
          );
        })}
      </svg>
      {children !== undefined && <span className="lap-ring-centre">{children}</span>}
    </span>
  );
}

export default memo(LapRing);
