import type { CharacterState } from '@shared/character';

/**
 * The realm's roster, kept the same array for as long as its rows are equal.
 *
 * A character push is a structured clone, so `online` is a new array on every
 * status line whether or not anybody came or went, and everything keyed on it
 * redraws a list that did not change: the Realm card's sort and its table of
 * hundreds of rows (todo 744). Rows are compared on every field they carry,
 * so a field added to `Adventurer` is compared too; a field that is not
 * flat compares by reference and only ever costs a redraw, never a stale row.
 */
export function keepRoster(previous: CharacterState, next: CharacterState): CharacterState {
  return next.online !== previous.online && sameRows(previous.online, next.online)
    ? { ...next, online: previous.online }
    : next;
}

function sameRows<T extends object>(a: readonly T[], b: readonly T[]): boolean {
  return (
    a.length === b.length &&
    a.every((row, at) => {
      const other = b[at];
      return other !== undefined && sameFields(row, other);
    })
  );
}

function sameFields<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}
