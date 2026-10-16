/**
 * The line a walk starts with, in the word its pace takes: `Walking` with
 * auto-combat on, `Running` with it off (todo 129). Out of `Walker`, which is
 * at its size ceiling.
 */
import { t } from '../../app/i18n';
import type { Pace } from '../../../shared/walk';

export function walkStarted(stepCount: number, destination: string, pace: Pace): string {
  const params = { stepCount, destination };
  if (pace === 'running') {
    return stepCount === 1
      ? t('automation.walk.startedRunning.one', params)
      : t('automation.walk.startedRunning.many', params);
  }
  return stepCount === 1
    ? t('automation.walk.started.one', params)
    : t('automation.walk.started.many', params);
}
