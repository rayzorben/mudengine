/**
 * The conditions a character's state says are on, in words: the Vitals card's
 * own, and a shared character's on the Players card. Only a stated `yes` is
 * named; unknown is not a condition, and `no` is the ordinary state.
 */
import { t } from './i18n';
import type { Afflictions } from '@shared/character';

/*
 * Six literal `t()` calls rather than a lookup keyed on the field name:
 * `i18n-coverage.test.ts` reads only the literal after `t(`, so a dynamic key
 * would be an unexempted dynamic call and a key nothing is seen to read.
 */
export function afflictedWords(afflictions: Afflictions): string[] {
  return [
    afflictions.blind === 'yes' ? t('cards.vitals.afflicted.blind') : null,
    afflictions.poisoned === 'yes' ? t('cards.vitals.afflicted.poisoned') : null,
    afflictions.diseased === 'yes' ? t('cards.vitals.afflicted.diseased') : null,
    afflictions.held === 'yes' ? t('cards.vitals.afflicted.held') : null,
    afflictions.confused === 'yes' ? t('cards.vitals.afflicted.confused') : null,
    afflictions.afraid === 'yes' ? t('cards.vitals.afflicted.afraid') : null
  ].filter((word): word is string => word !== null);
}
