import { t } from './i18n';
import type { MobRuleSource, MobTreatment } from '@shared/mobRules';

/**
 * One literal `t()` per treatment, never a key built from the value:
 * `i18n-coverage.test.ts` reads only the literal after `t(`, so a dynamic key
 * would be an unexempted dynamic call and nine keys nothing is seen to read.
 */
export const TREATMENT_WORD: Record<MobTreatment, () => string> = {
  never: () => t('settings.combat.mobRuleNever'),
  friend: () => t('settings.combat.mobRuleFriend'),
  escape: () => t('settings.combat.mobRuleEscape'),
  hangup: () => t('settings.combat.mobRuleHangup'),
  first: () => t('settings.combat.mobRuleFirst'),
  high: () => t('settings.combat.mobRuleHigh'),
  default: () => t('settings.combat.mobRuleDefault'),
  low: () => t('settings.combat.mobRuleLow'),
  last: () => t('settings.combat.mobRuleLast')
};

/** Where an inherited row comes from, as its chip says it (todo 817). One literal `t()` each, as above. */
export const SOURCE_WORD: Record<MobRuleSource, () => string> = {
  megamud: () => t('settings.combat.mobRuleFromMegamud'),
  global: () => t('settings.combat.mobRuleFromGlobal'),
  realm: () => t('settings.combat.mobRuleFromRealm')
};
