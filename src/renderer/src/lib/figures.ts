/**
 * How the chrome prints a few of the realm's figures, so every card that shows
 * one prints it the same way.
 */

/** A weapon's damage as the realm states it, `Min`–`Max`. */
export function damageRangeText(range: { min: number; max: number }): string {
  return `${range.min}–${range.max}`;
}

/** One decimal: a round's damage is an average, and a whole number would tie two weapons. */
export function perRoundText(value: number): string {
  return value.toFixed(1);
}

/** A figure with its sign, as the server signs one: `+75`, `-175`, `0`; a fraction to one place. */
export function signed(value: number): string {
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return value > 0 ? `+${text}` : text;
}
