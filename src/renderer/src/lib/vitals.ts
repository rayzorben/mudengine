/**
 * The word a vital level wears, stated once.
 *
 * Vitals, Combat and Party each map the same level to the same word beside a
 * bar — and the map existed three times, twice as an identical table and once
 * as an inline ternary, which is three places for 'low' to drift apart. The
 * levels that say nothing return null on purpose: an `ok` bar wearing a word
 * would be the scale nobody can read under pressure.
 */
import type { VitalLevel } from '@shared/character';
import { t } from './i18n';
import { tuning } from './tuning';

export function levelWord(level: string): string | null {
  if (level === 'caution') return t('cards.vitals.level.caution');
  if (level === 'critical') return t('cards.vitals.level.critical');
  return null;
}

/**
 * The figure in a party member's bar: `current/max` once a maximum is known
 * (this character's own prompt, or the member's `@health` answer kept by
 * `listedVitals`, which moves the current figure to every listing's share), the
 * listing's percentage until then, and a dash, never a zero, while nothing has
 * said. Localised like the purse, so `4,434` reads as `2,199,807` does.
 */
export function meterValue(
  fraction: number | null,
  current: number | null,
  max: number | null
): string {
  if (fraction === null) return '—';
  if (current === null || max === null) return `${Math.round(fraction * 100)}%`;
  return t('cards.party.ofMax', {
    current: current.toLocaleString(),
    max: max.toLocaleString()
  });
}

/**
 * A monster's level from the share of it left, at the Combat card's lines
 * (`woundCaution`, `woundCritical`): the arena's gauges and the card's bar wear
 * the same colour for the same monster (todo 20261018-1314-01).
 */
export function woundLevel(remaining: number | null): VitalLevel {
  if (remaining === null) return 'unknown';
  if (remaining < tuning().woundCritical) return 'critical';
  if (remaining < tuning().woundCaution) return 'caution';
  return 'ok';
}
