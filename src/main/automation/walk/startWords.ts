/**
 * The line a walk starts with, in the word its pace takes: `Walking` with
 * auto-combat on, `Running` with it off (todo 129). A run that turned
 * auto-combat off for the way says so in the same line, so *Run it* has one
 * start line (2026-10-20). Out of `Walker`, which is at its size ceiling.
 */
import { t } from '../../app/i18n';
import type { Pace } from '../../../shared/walk';
import type { Route } from '../../../shared/world';

export function walkStarted(
  stepCount: number,
  destination: string,
  pace: Pace,
  combatOff = false
): string {
  const params = { stepCount, destination };
  if (pace === 'running' && combatOff) {
    return stepCount === 1
      ? t('automation.walk.startedRunningCombatOff.one', params)
      : t('automation.walk.startedRunningCombatOff.many', params);
  }
  if (pace === 'running') {
    return stepCount === 1
      ? t('automation.walk.startedRunning.one', params)
      : t('automation.walk.startedRunning.many', params);
  }
  return stepCount === 1
    ? t('automation.walk.started.one', params)
    : t('automation.walk.started.many', params);
}

/**
 * A run's start line, said by whoever began the run once the combat switch
 * has answered (the walker starts with `startSaid: false`): `combatOff` is
 * whether this run turned it off.
 */
export function runStarted(route: Route, combatOff: boolean): string {
  return walkStarted(route.steps.length, route.steps.at(-1)?.name ?? '', 'running', combatOff);
}
