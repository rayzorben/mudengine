/**
 * How the Combat Stats card's faces write a figure, a share and a stretch of
 * time, so every face reads the same. See `mudengine-ui` › *The Combat Stats
 * card*.
 */
import { t } from './i18n';

/** A figure the realm has not made yet reads as a dash, never as zero. */
export function figure(value: number | null, digits = 0): string {
  return value === null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

/** A share as a percentage, or a dash. `share` already returns null for 0/0. */
export function percent(value: number | null): string {
  return value === null ? '—' : t('cards.stats.percent', { value: (value * 100).toFixed(1) });
}

/**
 * A stretch of time on the clock, `h:mm:ss` — MegaMUD's own `Duration:` shape.
 *
 * It was `3m` / `51s`, and the badge these go in is uppercased, so a three
 * minute count read `3M`. One unbroken format also means the badge and the
 * time rows cannot disagree about what counts as a long time.
 */
export function duration(ms: number | null): string {
  if (ms === null) return '—';
  const total = Math.max(0, Math.round(ms / 1000));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${Math.floor(total / 3600)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}
