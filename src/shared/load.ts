/**
 * The load as a whole percent of the maximum, as the server's
 * `CalcEncumbrancePercent` divides it (GreaterMUD `Player.cs`): a fraction
 * read here cost a point of dodge the server never takes (2026-10-07, Yang).
 * Null where either figure is unread.
 */
export function loadPercent(encumbrance: number | null, max: number | null): number | null {
  return encumbrance === null || max === null || max <= 0
    ? null
    : Math.trunc((100 * encumbrance) / max);
}
