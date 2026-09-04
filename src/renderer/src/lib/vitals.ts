/**
 * The word a vital level wears, stated once.
 *
 * Vitals, Combat and Party each map the same level to the same word beside a
 * bar — and the map existed three times, twice as an identical table and once
 * as an inline ternary, which is three places for 'low' to drift apart. The
 * levels that say nothing return null on purpose: an `ok` bar wearing a word
 * would be the scale nobody can read under pressure.
 */
import { t } from './i18n';

export function levelWord(level: string): string | null {
  if (level === 'caution') return t('cards.vitals.level.caution');
  if (level === 'critical') return t('cards.vitals.level.critical');
  return null;
}

/**
 * The number beside a party member's bar.
 *
 * The party listing gives a percentage and nothing else; `@health` gives the
 * absolute figures, once, when a member's own client answers. The two are not
 * printed side by side as `hp/max`: the percentage is refreshed by every
 * listing and the figures are a quotation from the moment the reply arrived,
 * so a bar at 40% beside `3000/4434` would be the card contradicting itself
 * within one row. What the reply adds that stays true is the **maximum** —
 * 30% of 4,434 and 30% of 62 are the same bar and different emergencies, and
 * the maximum is what tells them apart. An unknown fraction is a dash, never a
 * zero, whatever else is known.
 */
export function meterValue(fraction: number | null, max: number | null): string {
  if (fraction === null) return '—';
  const percent = Math.round(fraction * 100);
  // Localised like every other large figure in the chrome — the purse, the
  // experience — so `4,434` here reads as `2,199,807` does two cards up.
  return max === null
    ? `${percent}%`
    : t('cards.party.ofMax', { percent, max: max.toLocaleString() });
}
