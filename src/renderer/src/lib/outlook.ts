import type { SurvivalHorizon } from '@shared/survival';

/** A share of fights as the Combat card prints it, a whole percent. */
export function percent(share: number): number {
  return Math.round(share * 100);
}

/**
 * The rounds the Combat card lists (todo 10): up to and including the first
 * that reads 100% won, since every later round reads 100% won too. The cut is
 * on the printed figure, as the player reads it. When it rounds up from 99.5%,
 * the few fights still running can lose more health by a later round; the
 * worst single round and the meter above still show.
 */
export function horizonsShown(horizons: readonly SurvivalHorizon[]): readonly SurvivalHorizon[] {
  const won = horizons.findIndex((at) => percent(at.won) === 100);
  return won === -1 ? horizons : horizons.slice(0, won + 1);
}
