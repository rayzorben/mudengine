/**
 * Experience and other figures an hour, as every card writes them.
 *
 * MegaMUD switched between `k/hr` and `m/hr` for the same reason: six figures
 * of experience per hour is a number nobody reads at a glance, and a card is
 * three inches wide. One form, so a rate reads the same on every card.
 */
import { t } from './i18n';

/** `850`, `12.0k`, `1.20M`. */
export function compact(value: number): string {
  const size = Math.abs(value);
  if (size >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (size >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toFixed(0);
}

/** A rate an hour, `12.0k/hr`, or a dash while there is none. */
export function rate(value: number | null): string {
  return value === null ? '—' : t('cards.stats.ratePerHour', { value: compact(value) });
}
