/**
 * How the Hunting card says its figures: an hourly rate, seconds, a share of
 * the health bar and a floor under one. Unknown is `?` in every one, so the
 * best lair's tile, the table and the detail say unknown the same way.
 */

/** An hourly figure, whole and grouped. */
export const hours = (rate: number | null): string =>
  rate === null ? '?' : Math.round(rate).toLocaleString();

export const seconds = (value: number | null): string =>
  value === null ? '?' : `${Math.round(value)}s`;

/** A share of the health bar. */
export const percent = (share: number | null): string =>
  share === null ? '?' : `${Math.round(share * 100)}%`;

/** A floor, marked as one: the least the room can cost where a spawn's rounds are unknown. */
export const atLeast = (share: number | null): string =>
  share === null ? '?' : `\u2265 ${percent(share)}`;
