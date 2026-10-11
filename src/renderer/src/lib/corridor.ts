/** The tooltip a timed passage carries, on a route step and on the Room card (todo 72). */
import { t } from './i18n';
import type { Corridor } from '@shared/world';

export function corridorTitle(corridor: Pick<Corridor, 'ticks' | 'then'>): string {
  return corridor.ticks !== undefined && corridor.then !== undefined
    ? t('cards.route.corridorTitle', { ticks: corridor.ticks, then: corridor.then })
    : t('cards.route.corridorTitleShort');
}
