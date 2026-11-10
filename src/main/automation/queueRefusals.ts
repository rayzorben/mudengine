/**
 * Why the queue sent nothing, one sentence per `QueueRefusal`, for every
 * proposer that says so: the peer controls and the Automations card's tasks.
 */
import { t } from '../app/i18n';
import type { QueueRefusal } from './CommandQueue';

export function whyNotQueued(refusal: QueueRefusal): string {
  switch (refusal) {
    case 'held':
      return t('automation.queue.refused.held');
    case 'offline':
      return t('automation.queue.refused.offline');
    case 'not-in-realm':
      return t('automation.queue.refused.notInRealm');
    case 'switched-off':
      return t('automation.queue.refused.switchedOff');
    case 'expired':
      return t('automation.queue.refused.expired');
    case 'unavailable':
      return t('automation.queue.refused.unavailable');
    default: {
      const never: never = refusal;
      return never;
    }
  }
}
