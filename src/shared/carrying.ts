/**
 * How many more of one item the character can carry (todo 80), for a shop trip
 * that would otherwise buy past what the pack holds.
 *
 * Both limits are the server's, from GreaterMUD source: `BuyCommand` refuses
 * a purchase whose weight brings the pack to its maximum (`You cannot carry
 * that much!`), and `InventoryCommand.GetEncName` grades the pack `Medium`
 * past 33.3% of the maximum and `Heavy` past 66.6%. A gate stops the count
 * where the pack would reach that grade, as AutoLoot's `stopAtGrade` does.
 */
import type { EncumbranceGate } from './config';

/** The share of the maximum, in percent, a pack may hold before it reads as the grade. */
const GRADE_STARTS_ABOVE: Readonly<Record<Exclude<EncumbranceGate, 'never'>, number>> = {
  medium: 33.3,
  heavy: 66.6
};

/**
 * How many of an item weighing `weight` fit, or null where any figure is
 * unknown: an unread pack or an unweighed item caps nothing.
 */
export function countThatFits(
  encumbrance: number | null,
  encumbranceMax: number | null,
  weight: number | null,
  gate: EncumbranceGate
): number | null {
  if (encumbrance === null || encumbranceMax === null || weight === null || weight <= 0) {
    return null;
  }
  const limit =
    gate === 'never'
      ? encumbranceMax - 1
      : Math.floor((encumbranceMax * GRADE_STARTS_ABOVE[gate]) / 100);
  return Math.max(0, Math.floor((limit - encumbrance) / weight));
}
