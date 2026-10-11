/** A room spell's damage as a share of the reader's health, on a route step and the Room card (todo 72). */
import { t } from './i18n';

/**
 * Under a percent is said as *under a percent*: rounding it up to one is a
 * figure the data did not give, and rounding it to zero is a reassurance it
 * did not give either.
 */
export function healthShareWords(share: number): string {
  return share * 100 < 1
    ? t('cards.route.hazardSlight')
    : t('cards.route.hazardShare', { percent: Math.round(share * 100) });
}
