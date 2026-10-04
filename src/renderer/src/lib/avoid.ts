/**
 * Why the realm data says to leave a monster alone (`MobAvoid`): the Room
 * card's chip and the Reference card's temper line.
 */
import type { MobAvoid } from '@shared/mobs';
import { t } from './i18n';

export function avoidNote(avoid: MobAvoid): string {
  switch (avoid) {
    case 'no-experience':
      return t('automation.avoid.noExperience');
    case 'no-attacks':
      return t('automation.avoid.noAttacks');
    default: {
      const unreachable: never = avoid;
      return unreachable;
    }
  }
}
