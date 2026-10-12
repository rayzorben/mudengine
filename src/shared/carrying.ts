/**
 * How many more of one item the character can carry (todo 80), for a shop trip
 * that would otherwise buy past what the pack holds.
 *
 * The limit is the server's, from GreaterMUD source: `BuyCommand` refuses a
 * purchase whose weight brings the pack to its maximum (`You cannot carry that
 * much!`). The grade AutoLoot stops picking up at is not a limit here: a
 * supply the player asked for is bought though the pack goes Medium or Heavy.
 */

/**
 * How many of an item weighing `weight` fit, or null where any figure is
 * unknown: an unread pack or an unweighed item caps nothing.
 */
export function countThatFits(
  encumbrance: number | null,
  encumbranceMax: number | null,
  weight: number | null
): number | null {
  if (encumbrance === null || encumbranceMax === null || weight === null || weight <= 0) {
    return null;
  }
  return Math.max(0, Math.floor((encumbranceMax - 1 - encumbrance) / weight));
}
