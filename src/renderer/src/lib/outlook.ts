import type { VitalLevel } from '@shared/character';
import type { SurvivalHorizon, SurvivalLevel } from '@shared/survival';

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

/**
 * A share of fights survived on the scale every bar wears: safe is `ok`, risky
 * `caution`, deadly `critical`, so the odds and a health bar share a hue.
 */
export function survivalVital(level: SurvivalLevel): VitalLevel {
  switch (level) {
    case 'safe':
      return 'ok';
    case 'risky':
      return 'caution';
    case 'deadly':
      return 'critical';
    default: {
      const never: never = level;
      return never;
    }
  }
}
