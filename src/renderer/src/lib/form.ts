/**
 * The little conversions every settings form needs, stated once.
 *
 * Both settings screens grew their own copies, and the copies had already
 * started to disagree — one `percent` returned a string, the other a number,
 * and only one `fraction` survived a cleared field without `NaN`. One home,
 * the forgiving variants.
 */

/** A stored fraction as the whole percent a person types. */
export function percentOf(fraction: number): number {
  return Math.round(fraction * 100);
}

/** And back, forgivingly: a field somebody cleared is 0, not NaN. */
export function fractionOf(value: string): number {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number / 100)) : 0;
}

/**
 * What a percentage field is worth in the character's own numbers: `56/80`.
 *
 * A percentage is the right thing to store — one figure holds at every level,
 * which is why every threshold in this client is one — and the wrong thing to
 * reason with when the question is *will this rest start before or after the
 * next bite*, which is asked in hit points. So the field keeps the percentage
 * and this states it beside it.
 *
 * Three ways to answer nothing, and all three are the same rule this client
 * follows everywhere: **unknown is not zero.**
 *
 * - **No maximum**, which is the Global page (edited with no character in the
 *   realm), a character not yet in the game, and a warrior's mana. Drawing
 *   `0/0` would be the meter painted red for want of a figure.
 * - **A non-positive maximum**, which is a maximum that has not arrived rather
 *   than a character with none.
 * - **A threshold of 0**, which means *never* in every field this is offered
 *   on. `0/80` is a true division and a false statement: nothing happens at
 *   that figure, so naming one invites somebody to reason about it.
 *
 * Rounded, because the client compares `value / max < threshold` against whole
 * hit points — so the figure shown is the one a player can count to.
 */
export function figureOf(percent: number, max: number | null): string | null {
  if (max === null || max <= 0) return null;
  if (percent <= 0) return null;
  return `${Math.round((percent / 100) * max)}/${max}`;
}

/** `giant rat, kobold thief` <-> the list the config keeps. */
export function joinNames(names: readonly string[]): string {
  return names.join(', ');
}

export function splitNames(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
