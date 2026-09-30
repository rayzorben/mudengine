import { memo, type CSSProperties } from 'react';

import Icon from './Icon';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { goalDetail, goalIcon, goalName, shareText } from '../lib/konami';
import { compact, rate } from '../lib/rates';
import { goalKey } from '@shared/konamiLessons';
import type { KonamiOptionRow, KonamiSpotFacts } from '@shared/konamiRecords';

export interface KonamiOddsProps {
  options: readonly KonamiOptionRow[];
  /** Picks one instead of the provider's choice, by `goalKey`; absent where nothing may be picked. */
  onChoose?(key: string): void;
  /** Leaves the spot facts out, for a decision's row in the timeline. */
  compact?: boolean;
}

/** What the provider was told about a spot, one fact a chip. */
function SpotFacts({ spot }: { spot: KonamiSpotFacts }) {
  const facts: Array<{ text: string; tone?: 'bad'; share?: number }> = [];
  if (spot.expPerHour !== null) {
    facts.push({ text: rate(spot.expPerHour) });
  } else if (spot.expPerLap !== null) {
    facts.push({ text: t('cards.konami.facts.lap', { exp: compact(spot.expPerLap) }) });
  }
  if (spot.survives !== null) {
    facts.push({
      text: t('cards.konami.facts.survives', { share: shareText(spot.survives) }),
      share: spot.survives
    });
  }
  if (spot.steps !== null)
    facts.push({ text: t('cards.konami.facts.steps', { steps: spot.steps }) });
  if (spot.lairs !== null && spot.lairs > 0) {
    facts.push({ text: t('cards.konami.facts.lairs', { lairs: spot.lairs }) });
    facts.push({
      text:
        spot.routeHp === null
          ? t('cards.konami.facts.routeUnknown')
          : t('cards.konami.facts.routeHp', { hp: Math.round(spot.routeHp) })
    });
  }
  if (spot.deadly !== null) {
    facts.push({ text: t('cards.konami.facts.deadly', { room: spot.deadly }), tone: 'bad' });
  }
  return (
    <div className="konami-facts">
      {facts.map((fact) => (
        <span
          className="konami-fact"
          data-tone={fact.tone}
          key={fact.text}
          style={
            fact.share === undefined ? undefined : ({ '--share': fact.share } as CSSProperties)
          }
        >
          {fact.text}
        </span>
      ))}
    </div>
  );
}

/**
 * The odds the reply gave every goal it was offered, likeliest first, drawn
 * as bars against each other: the answer as a choice among others rather
 * than a word. The chosen one is marked; any other can be chosen instead.
 */
function KonamiOdds({ options, onChoose, compact = false }: KonamiOddsProps) {
  const most = Math.max(...options.map((option) => option.p), 0.0001);
  return (
    <ol className={`konami-odds${compact ? ' compact' : ''}`}>
      {options.map((option) => {
        const key = goalKey(option.goal);
        const detail = goalDetail(option.goal);
        return (
          <li
            className="konami-option"
            data-chosen={option.chosen}
            key={key}
            style={{ '--fill': option.p / most } as CSSProperties}
          >
            <span className="konami-option-icon">
              <Icon name={option.chosen ? 'check' : goalIcon(option.goal)} />
            </span>
            <div className="konami-option-main">
              <div className="konami-option-name">
                <span className="konami-option-title">{goalName(option.goal)}</span>
                {detail !== null && <span className="konami-option-detail">{detail}</span>}
              </div>
              <div className="konami-bar" aria-hidden>
                <span />
              </div>
              {!compact && option.spot !== null && <SpotFacts spot={option.spot} />}
            </div>
            <span className="konami-pct">{shareText(option.p)}</span>
            {onChoose !== undefined &&
              (option.chosen ? (
                <span className="konami-go chosen">{t('cards.konami.chosen')}</span>
              ) : (
                <button
                  className="quiet konami-go"
                  onClick={() => onChoose(key)}
                  onMouseDown={keepFocus}
                  title={t('cards.konami.goHint')}
                  type="button"
                >
                  {t('cards.konami.go')}
                </button>
              ))}
          </li>
        );
      })}
    </ol>
  );
}

export default memo(KonamiOdds);
