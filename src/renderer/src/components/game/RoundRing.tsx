/**
 * The glow round the arena (todo 154, drawn as the game view prototype's
 * `todo/archive/140-game-view-prototype.html`): a soft band just outside the
 * rim, the off-round after each round in one colour and the rest of the round,
 * which a run waits out, in another; an arc fills it once a round from the
 * top. The arc grows by a CSS animation, so the map's canvas still draws only
 * on change (`mudengine-ui` › parts/game.md). `WorldCanvas` places it on the
 * arena each frame it draws.
 */
import { forwardRef, memo, type CSSProperties, type ForwardedRef } from 'react';

import { intoRound, type RoundAnchor } from '../../lib/gameRounds';
import { t } from '../../lib/i18n';

/** The SVG's size as a share of the ring's radius; the blur spills past it (`overflow: visible`). */
export const RING_EXTENT = 1.1;
/** The glow's width, px; `placeRing` keeps the ring half this off the exit discs. */
export const RING_GLOW_PX = 8;
const SWEEP_PX = 2.5;
/**
 * The ring is drawn at radius 1 and `placeRing` sets `--ring-unit` to one screen px in those
 * units. Widths are scaled by it rather than drawn with `non-scaling-stroke`, which makes
 * Chromium ignore `pathLength` and break each arc into dots (measured 2026-10-17).
 */
const width = (px: number): CSSProperties => ({ strokeWidth: `calc(var(--ring-unit) * ${px}px)` });
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
      <g transform="rotate(-90)">
        {share === null ? (
          <circle className="gv-round-glow gv-round-unknown" r={1} style={width(RING_GLOW_PX)} />
        ) : (
          <>
            <circle className="gv-round-glow gv-round-wait" r={1} style={width(RING_GLOW_PX)} />
            <circle
              className="gv-round-glow gv-round-off"
              pathLength={1}
              r={1}
              strokeDasharray={`${share} 1`}
              style={width(RING_GLOW_PX)}
            />
          </>
        )}
        <circle
          className="gv-round-sweep"
          key={anchor.roundAt}
          pathLength={1}
          r={1}
          style={{
            ...width(SWEEP_PX),
            animationDuration: `${anchor.periodMs}ms`,
            animationDelay: `${-intoRound(anchor, Date.now())}ms`
          }}
        />
      </g>
    </svg>
  );
}

export default memo(forwardRef(RoundRing));
