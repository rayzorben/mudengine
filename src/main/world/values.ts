/**
 * Reading a cell out of a realm database, without inventing one.
 *
 * The readings shared by everything that converts an `.mdb`: a number, text,
 * the blank cell, a row's ability pairs, a monster's drop table and a shop's
 * slots. They lived
 * inside `buildRealm.ts` until `roomScript.ts` and `supplyIndex.ts` needed the
 * same reading of the same columns — and a second copy of "what counts as a
 * number here" is two answers that come to disagree about a blank cell, which
 * in this database is a real hazard (see `BLANK_AS_NUMBER`).
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

/**
 * What a *blank* looks like once a text value has been read out of a numeric
 * column: `0x2020`, two ASCII spaces, little-endian.
 *
 * 348 rows of the shipped realm's `Items.Speed` read as this. Nothing in the
 * database distinguishes it from a real 8224, and no column in it has a
 * plausible value there — weapon speeds run 900–3000, a monster's armour class
 * tops out at 9999 — so it is refused wherever a new column is read. It costs
 * one impossible value and removes the whole class of bug where an empty cell
 * becomes a confident number.
 */
export const BLANK_AS_NUMBER = 8224;

/**
 * How many `Abil-n` slots a row has.
 *
 * Twenty on `Items` and ten on `Monsters`, `Spells`, `Races` and `Classes`;
 * reading twenty everywhere is safe because a column that is not there reads as
 * absent, and one number is one fewer thing to keep in step with the schema.
 */
const ABILITY_SLOTS = 20;

/**
 * The `Abil-n` / `AbilVal-n` pairs on one row, in slot order and undecoded.
 *
 * Five tables carry them — `Items`, `Monsters`, `Spells`, `Races` and
 * `Classes` — and until 2026-08-31 only the item half was ever written out, so
 * the client showed a spell's level and mana and never what casting it does. A
 * shared reader rather than the loop copied five times: the empty-slot rule
 * (`0`) and the blank-cell rule (`8224`) are properties of the *format*, and
 * five copies of them is five places for one of them to be forgotten.
 *
 * Kept as the realm's own numbers; `src/shared/abilities.ts` names them at the
 * point of display, because the reading is a claim from another client's
 * source and may be corrected while the number is what the realm said.
 */
export function abilityPairs(row: Record<string, unknown>): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let slot = 0; slot < ABILITY_SLOTS; slot += 1) {
    const which = number(row[`Abil-${slot}`]);
    if (which === null || which <= 0 || which === BLANK_AS_NUMBER) continue;
    const value = number(row[`AbilVal-${slot}`]);
    pairs.push([which, value === null || value === BLANK_AS_NUMBER ? 0 : value]);
  }
  return pairs;
}

/**
 * A monster row's drop table: each `DropItem-n` with its `DropItem%-n`, the
 * empty slot (`0`) left out, and the percent null where the row states none.
 */
export function dropSlots(
  row: Record<string, unknown>
): Array<{ item: number; percent: number | null }> {
  const slots: Array<{ item: number; percent: number | null }> = [];
  for (const column of Object.keys(row)) {
    const slot = /^DropItem-(\d+)$/.exec(column)?.[1];
    const item = slot === undefined ? null : number(row[column]);
    if (item === null || item <= 0) continue;
    slots.push({ item, percent: number(row[`DropItem%-${slot}`]) });
  }
  return slots;
}

/** A shop slot's figures: `Max`, `Time`, `Amount` and `%`, each `<field>-n`. */
export type ShopSlotField = 'Max' | 'Time' | 'Amount' | '%';

/**
 * A shop row's slots: each `Item-n`, the empty slot (`0`) left out, with a
 * reader for that slot's figures.
 */
export function shopSlots(
  row: Record<string, unknown>
): Array<{ item: number; figure: (field: ShopSlotField) => number | null }> {
  const slots: Array<{ item: number; figure: (field: ShopSlotField) => number | null }> = [];
  for (const column of Object.keys(row)) {
    const slot = /^Item-(\d+)$/.exec(column)?.[1];
    const item = slot === undefined ? null : number(row[column]);
    if (item === null || item <= 0) continue;
    slots.push({ item, figure: (field) => number(row[`${field}-${slot}`]) });
  }
  return slots;
}
