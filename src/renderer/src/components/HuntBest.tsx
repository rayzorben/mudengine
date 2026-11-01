import { memo, type CSSProperties } from 'react';

import HuntCycle from './HuntCycle';
import Icon from './Icon';
import { keepFocus } from '../lib/focus';
import { atLeast, hours, percent } from '../lib/huntWords';
import { t } from '../lib/i18n';
import { spotRate, type HuntingSpot } from '@shared/hunting';

/**
 * The best lair the Hunting card rated, set large: what a small card is read
 * for, and the head of a large one. Its name opens its row as the table's
 * does; the rate is the figure the table ranks by, the measured one where
 * hunting there measured one; under it how far, how many rooms the loop
 * walks, and what its worst spawn costs of the health bar. A large card adds
 * where a lap's time goes (`HuntCycle`). Not drawn where no lair has a rate.
 */
function HuntBest({
  spot,
  open,
  onOpen
}: {
  spot: HuntingSpot;
  open: boolean;
  onOpen(key: string): void;
}) {
  const rate = spotRate(spot);
  const steps = spot.rooms[0]?.steps;
  const cost = spot.estimate.worstShare ?? spot.estimate.worstShareAtLeast;
  return (
    <section className="hunt-best" aria-label={t('cards.hunting.best.label')}>
      <div className="hunt-best-head">
        <span className="hunt-best-glyph" aria-hidden="true">
          <Icon name="crosshair" />
        </span>
        <div className="hunt-best-who">
          <em>{t('cards.hunting.best.label')}</em>
          <button
            aria-expanded={open}
            className="lookup"
            onClick={() => onOpen(spot.key)}
            onMouseDown={keepFocus}
            type="button"
          >
            {spot.mobs.map((mob) => mob.name).join(', ')}
          </button>
        </div>
        <div
          className="hunt-best-rate"
          data-measured={spot.estimate.measured ? 'true' : undefined}
          title={
            spot.estimate.measured
              ? t('cards.hunting.measuredHint', {
                  minutes: Math.round(spot.estimate.measured.minutes)
                })
              : undefined
          }
        >
          <b>{hours(rate)}</b>
          <small>{t('cards.hunting.best.unit')}</small>
        </div>
      </div>
      <ul className="hunt-best-facts">
        {steps === undefined ? null : (
          <li>
            <Icon name="route" />
            {t('cards.hunting.best.steps', { steps })}
          </li>
        )}
        <li>
          <Icon name="loop" />
          {t('cards.hunting.best.rooms', { loop: spot.walk.length, total: spot.roomCount })}
        </li>
        {cost === null ? null : (
          <li
            className="hunt-best-cost"
            data-costly={spot.estimate.costly ? 'true' : undefined}
            style={{ '--share': Math.min(1, cost) } as CSSProperties}
            title={t('cards.hunting.best.costTitle')}
          >
            <Icon name="heart" />
            <i aria-hidden="true" />
            {spot.estimate.worstShare === null ? atLeast(cost) : percent(cost)}
          </li>
        )}
      </ul>
      <div className="hunt-best-cycle from-large">
        <HuntCycle estimate={spot.estimate} />
      </div>
    </section>
  );
}

export default memo(HuntBest);
