/**
 * Reading a cell out of a realm database, without inventing one.
 *
 * Two helpers, shared by everything that converts an `.mdb`. They lived inside
 * `buildRealm.ts` until `roomScript.ts` needed the same reading of the same
 * columns — and a second copy of "what counts as a number here" is two answers
 * that come to disagree about a blank cell, which in this database is a real
 * hazard (see `BLANK_AS_NUMBER`).
 *
 * Their own module rather than an export from `buildRealm`, because
 * `buildRealm` imports `roomScript`: the other direction would be a **value**
 * cycle, and this project has one of those written down
 * (`src/shared/__tests__/module-cycle.test.ts`).
 */

/**
 * A value that should be a number, or null.
 *
 * **Never coerced to zero.** A column a derivative does not have, a cell the
 * realm left empty and a genuine `0` are three different facts, and the one
 * thing they must not become is a confident number — a monster with no armour
 * and a realm that never stated one are the same absence, and neither is "0".
 */
export function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A value that should be text. Absent reads as empty, never as `"null"`. */
export function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}
