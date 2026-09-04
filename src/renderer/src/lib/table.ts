/**
 * What a card's table does when it is searched, filtered and sorted.
 *
 * A card states facts about one character, and for most cards that is a handful
 * of rows nobody needs help with. Three of them are *listings* whose length the
 * player does not control — a pack with a hundred things in it, a realm with
 * forty people in it, a shop with three hundred lines of stock — and a listing
 * that can only be read from the top is one nobody reads at all.
 *
 * The decisions live here rather than in the component because they are where
 * the edge cases are: what a two-word query means, where a row the realm cannot
 * place sorts to, and what a third click on a heading does. The component draws
 * the answer; this decides it, and the tests are on this.
 */

import { t } from './i18n';

/** What a column holds, once it is reduced to something sortable and searchable. */
export type CellValue = string | number | null;

/** Which column a table is pointed at, and which way. Null is the card's own order. */
export interface Sort {
  column: string;
  direction: 'ascending' | 'descending';
}

/**
 * What somebody typed, as terms.
 *
 * Split on whitespace, because `silk glo` is how a person narrows to
 * `silk gloves` — one substring over the whole row would match nothing, and
 * asking for the exact spelling of a thing is asking the question the find
 * field exists to answer.
 */
export function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

/**
 * Does this row answer the query?
 *
 * Every term must appear **somewhere** in the row, and not necessarily in the
 * same field: `plat head` finds a platinum helm listed as `Head`, which is the
 * question somebody with forty items is actually asking. An empty query matches
 * everything rather than nothing — a find field that empties the card the
 * moment it is cleared would be one nobody dares click into.
 */
export function matches(query: string, fields: readonly CellValue[]): boolean {
  const wanted = terms(query);
  if (wanted.length === 0) return true;
  const text = fields
    .filter((field): field is string | number => field !== null)
    .map((field) => String(field).toLowerCase());
  return wanted.every((term) => text.some((field) => field.includes(term)));
}

/**
 * Two cells of the same column, ascending.
 *
 * Numbers numerically — `100` is not less than `20` because `1` sorts before
 * `2`, and a weight column that claimed so would be wrong about the only
 * question it is consulted for. Text with `numeric`, so `padded helm 2` follows
 * `padded helm 1`, and case-insensitively, because the realm capitalises names
 * inconsistently and a player does not read a case boundary as a sort order.
 */
export function compareCells(a: CellValue, b: CellValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, {
    numeric: true,
    sensitivity: 'base'
  });
}

/**
 * The rows, in the order the table is pointed in.
 *
 * **A value the realm does not have sorts last whichever way the column
 * points.** Most of what a monster drops is a name the realm data cannot place,
 * so a weight column is half empty — and an absent weight is not the answer to
 * "what is heaviest" nor to "what is lightest". Reversing a comparator that put
 * them last would put them first, which is a screen of blanks above the answer.
 *
 * `Array.prototype.sort` is stable, so rows the column cannot separate keep the
 * order the card put them in — worst-first for the realm roster, the listing's
 * own order for a pack.
 */
export function sortRows<Row>(
  rows: readonly Row[],
  sort: Sort | null,
  value: (row: Row, column: string) => CellValue
): Row[] {
  if (sort === null) return [...rows];
  const sign = sort.direction === 'ascending' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = value(a, sort.column);
    const right = value(b, sort.column);
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return sign * compareCells(left, right);
  });
}

/**
 * What a click on a heading does.
 *
 * Ascending, then descending, then **back to the card's own order** — which is
 * the one a third click has to be able to reach, because a card's natural order
 * is a decision it made on purpose: the realm roster is worst-first because
 * that is who matters, and a pack is in the order the listing printed it. A
 * table that could only be sorted would be a table that has quietly thrown that
 * away with no way to ask for it back.
 */
export function nextSort(current: Sort | null, column: string): Sort | null {
  if (current === null || current.column !== column) return { column, direction: 'ascending' };
  if (current.direction === 'ascending') return { column, direction: 'descending' };
  return null;
}

/** A sort as one string, for remembering it per character. `none` is the card's own order. */
export function writeSort(sort: Sort | null): string {
  return sort === null
    ? 'none'
    : `${sort.column}:${sort.direction === 'ascending' ? 'up' : 'down'}`;
}

/**
 * A remembered sort, back again — or null for anything this build cannot honour.
 *
 * A column that no longer exists must not leave a table pointed at nothing:
 * same rule the remembered filters follow, and for the same reason. The caller
 * passes the columns it actually has.
 */
export function readSort(stored: string, columns: readonly string[]): Sort | null {
  const [column, direction] = stored.split(':');
  if (column === undefined || !columns.includes(column)) return null;
  if (direction !== 'up' && direction !== 'down') return null;
  return { column, direction: direction === 'up' ? 'ascending' : 'descending' };
}

/**
 * What to say about a table that is not showing everything it holds.
 *
 * Null when nothing is hidden, so the line is absent rather than saying
 * "40 of 40" on every card that has never been filtered.
 *
 * This is the half that keeps a filtered card honest. Filters are remembered
 * per character, so a pack narrowed to `key` a fortnight ago opens narrowed
 * — and a card that said "Carrying nothing" because of it would be lying about
 * the one thing it exists to state.
 */
export function narrowed(shown: number, total: number): string | null {
  return shown === total ? null : t('table.narrowedCount', { shown, total });
}
