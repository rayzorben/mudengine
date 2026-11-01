/**
 * A share drawn as a ring, with what it is about in the middle: a party
 * member's health and mana around their initial, a target's health around its
 * percentage. Several arcs nest inward, outermost first. A share nobody has
 * stated is an empty dashed track, never a full or an empty arc. Its colour is
 * the arc's `tone` and `level` read by the stylesheet (`.ring`), and its
 * diameter is `--ring-d` on the element. See `mudengine-ui` › `parts/viz.md`.
 */
import { memo, type ReactNode } from 'react';

export interface RingArc {
  /** 0 to 1, or null while unknown. */
  fraction: number | null;
  /** What the arc measures, for its colour: `hp`, `mana`, `kai`, `exp`, `foe`. */
  tone: string;
  /** `ok`, `caution` or `critical` where the arc has a level, else absent. */
  level?: string | null;
}

/** The ring is drawn in a 40-unit box; each arc inward is one track narrower. */
const OUTER = 17;
const STEP = 5;

function Ring({ arcs, children, label }: { arcs: readonly RingArc[]; children?: ReactNode; label?: string }) {
  return (
    <span aria-label={label} className="ring" role={label === undefined ? undefined : 'img'}>
      <svg aria-hidden="true" viewBox="0 0 40 40">
        {arcs.map((arc, index) => {
          const r = OUTER - index * STEP;
          return (
            <g data-level={arc.level ?? undefined} data-tone={arc.tone} key={index}>
              <circle className="ring-track" cx="20" cy="20" data-unknown={arc.fraction === null} r={r} />
              {arc.fraction !== null && arc.fraction > 0 && (
                <circle
                  className="ring-arc"
                  cx="20"
                  cy="20"
                  pathLength={100}
                  r={r}
                  strokeDasharray={`${Math.min(1, arc.fraction) * 100} 100`}
                  transform="rotate(-90 20 20)"
                />
              )}
            </g>
          );
        })}
      </svg>
      {children !== undefined && <span className="ring-centre">{children}</span>}
    </span>
  );
}

export default memo(Ring);
