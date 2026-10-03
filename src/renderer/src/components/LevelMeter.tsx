/**
 * Where a character stands in its level, drawn as the target meter draws a
 * fight: the Combat Stats card's first face and the Vitals card at its large
 * size (todo 06). See `mudengine-ui` › `parts/cards.md`.
 */
import type { CharacterState } from '@shared/character';
import { t } from '../lib/i18n';
import { figure } from '../lib/stats';

export interface LevelReading {
  next: number;
  into: number;
  span: number;
  over: number;
  made: number;
}

/**
 * Where the character stands in its level, off the experience table.
 *
 * `into` is what it has past the level's own threshold and `span` what the
 * next one costs from there; past the next threshold `over` is the surplus,
 * which is a banked level the trainer has not been asked for. `made` is this
 * scope's own experience, drawn as the band it accounts for.
 */
export function levelReading(
  progress: CharacterState['progress'],
  made: number
): LevelReading | null {
  const { level, exp, expTable } = progress;
  if (level === null || exp === null || expTable === null) return null;
  const rowAt = (which: number): number | null =>
    expTable.rows.find((row) => row.level === which)?.experience ?? null;
  const base = rowAt(level) ?? (level <= 1 ? 0 : null);
  const top = rowAt(level + 1);
  if (base === null || top === null || top <= base) return null;
  const into = Math.max(0, exp - base);
  const span = top - base;
  return { next: level + 1, into, span, over: Math.max(0, into - span), made: Math.max(0, made) };
}

/**
 * The level meter. The scale is the larger of the way into the level and the
 * level's span, so a character past the threshold fills the whole track, the
 * 100% mark moves left to where the span ends and the overage is tinted past
 * it, as the todo drew it. The band inside the fill is this scope's
 * share, as the target meter draws this character's share of the damage.
 */
export default function LevelMeter({ reading }: { reading: LevelReading }) {
  const scale = Math.max(reading.into, reading.span, 1);
  const pct = (value: number): number => Math.max(0, Math.min(100, (value / scale) * 100));
  const fill = pct(reading.into);
  const mark = pct(reading.span);
  const mineFrom = pct(Math.max(0, reading.into - reading.made));
  const percent = Math.round((reading.into / reading.span) * 100);
  return (
    <div className="stats-level">
      <div className="meter exp-meter" data-level="ok">
        <div className="fill" style={{ width: `${fill}%` }} />
        {reading.made > 0 && (
          <span className="mine" style={{ left: `${mineFrom}%`, width: `${fill - mineFrom}%` }} />
        )}
        {reading.over > 0 && (
          <>
            <span className="over" style={{ left: `${mark}%`, width: `${100 - mark}%` }} />
            <span className="mark" style={{ left: `${mark}%` }} />
          </>
        )}
        {/* A figure and a word, like every meter: a sentence in a bar wraps
            when the chrome font is turned up. The sentence is the hint's. */}
        <span className="meter-label">
          {t('cards.stats.percent', { value: String(percent) })}
          {reading.over > 0 && (
            <span className="meter-state">
              {t('cards.stats.levelOver', { over: figure(reading.over) })}
            </span>
          )}
        </span>
      </div>
      <span className="hint">
        {t('cards.stats.levelFigure', { percent, next: reading.next })}
        {' · '}
        {t('cards.stats.levelMade', { made: figure(reading.made) })}
      </span>
    </div>
  );
}
