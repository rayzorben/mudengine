/**
 * The ring round the arena (todo 154): one turn a round, the off-round after
 * each round in one colour and the rest of the round, which a run waits out,
 * in another; a hand sweeps it from the round at the top. The hand turns by a
 * CSS animation, so the map's canvas still draws only on change
 * (`mudengine-ui` › parts/game.md). `WorldCanvas` places it on the arena each
 * frame it draws.
 */
import { forwardRef, memo, type ForwardedRef } from 'react';

import { intoRound, type RoundAnchor } from '../../lib/gameRounds';
import { t } from '../../lib/i18n';

/** How far the drawing reaches past the ring's radius (the hand's tip); `placeRing` sizes by it. */
export const RING_EXTENT = 1.1;
/** The ring's and the hand's stroke, px; `placeRing` keeps the ring this far off the exit discs. */
export const RING_STROKE_PX = 3;
const VIEW = `${-RING_EXTENT} ${-RING_EXTENT} ${2 * RING_EXTENT} ${2 * RING_EXTENT}`;

function RoundRing({ anchor }: { anchor: RoundAnchor | null }, ref: ForwardedRef<SVGSVGElement>) {
  if (anchor === null) return null;
  const share = anchor.offRoundMs === null ? null : anchor.offRoundMs / anchor.periodMs;
  const label =
    anchor.offRoundMs === null
      ? t('game.arena.roundsNoSteps', { round: (anchor.periodMs / 1000).toFixed(2) })
      : t('game.arena.rounds', {
          round: (anchor.periodMs / 1000).toFixed(2),
          offRound: (anchor.offRoundMs / 1000).toFixed(2)
        });
  return (
    <svg aria-label={label} className="gv-round-ring" ref={ref} role="img" viewBox={VIEW}>
      {share === null ? (
        <circle className="gv-round-unknown" pathLength={1} r={1} strokeWidth={RING_STROKE_PX} />
      ) : (
        <g transform="rotate(-90)">
          <circle className="gv-round-wait" pathLength={1} r={1} strokeWidth={RING_STROKE_PX} />
          <circle
            className="gv-round-off"
            pathLength={1}
            r={1}
            strokeDasharray={`${share} 1`}
            strokeWidth={RING_STROKE_PX}
          />
        </g>
      )}
      <line
        className="gv-round-hand"
        key={anchor.roundAt}
        strokeWidth={RING_STROKE_PX}
        style={{
          animationDuration: `${anchor.periodMs}ms`,
          animationDelay: `${-intoRound(anchor, Date.now())}ms`
        }}
        x1={0}
        x2={0}
        y1={-0.95}
        y2={-RING_EXTENT}
      />
    </svg>
  );
}

export default memo(forwardRef(RoundRing));
