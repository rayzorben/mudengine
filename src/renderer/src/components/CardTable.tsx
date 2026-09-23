import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';

import Icon from './Icon';
import ClearField from './ClearField';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { useRemembered, useRememberedChoice } from '../hooks/useRemembered';
import {
  matches,
  narrowed,
  nextSort,
  readSort,
  shelve,
  sortRows,
  writeSort,
  type CellValue,
  type Group,
  type Sort
} from '../lib/table';
import type { SessionId } from '@shared/ipc';

/**
 * One column of a card's table.
 *
 * `value` is what the column **is** — it is what the column sorts by, what the
 * find field searches, and what is drawn when `cell` says nothing more. Keeping
 * those one function is what stops a table from being searchable by text nobody
 * can see, or sorted by a number that is not the one in the row.
 */
export interface Column<Row> {
  id: string;
  /** The heading, and the word the sort control announces where `name` is absent. */
  label: string;
  /**
   * What the sort control announces, where the heading itself is a symbol.
   *
   * `#` over the realm's row numbers is the whole heading a five-digit column
   * can carry, and *Sort by #* is not a sentence: a heading that is a glyph
   * needs a word somewhere, and this is it. Absent for every ordinary column,
   * whose heading already is the word.
   */
  name?: string;
  value(row: Row): CellValue;
  /** Drawn instead of the value, where the row needs a control, a chip or a bar. */
  cell?(row: Row): ReactNode;
  /** A figure read down the column: right-aligned, tabular, sorted as a number. */
  numeric?: boolean;
  /** Takes the width the other columns leave. One per table. */
  wide?: boolean;
  /**
   * The cell holds a *control*, not text, so it is centred on the row rather
   * than hung off a baseline it does not have. An `inline-flex` around an SVG
   * takes the bottom of its box as its baseline, so aligning it to the row's
   * text baseline lifts the glyph clear of the word it belongs to — the
   * `.readout` baseline failure one level out, and what the equip glyph beside
   * a carried item was doing.
   */
  control?: boolean;
  /** Kept out of the find field, for a column whose text is chrome rather than fact. */
  unsearchable?: boolean;
  /** Nothing to sort by — a bar, a control. */
  unsortable?: boolean;
}

/**
 * One value of the table's **one** filtering dimension.
 *
 * One, deliberately: a chip row that mixed "weapons" with "worn" would be two
 * questions in one control, and muting one of each would leave a player unable
 * to say which of the two emptied the card. A pack filters by what a thing *is*
 * and says what is worn in a column; a roster filters by standing. A second
 * dimension is a second card, or a column somebody sorts by.
 */
export interface Facet {
  id: string;
  label: string;
  /** Ranked facets tint their chip, as the Alerts card's levels do. */
  level?: string;
}

/** Attributes a card puts on its own rows — the tint on a worn item, a level. */
export type RowAttrs = {
  className?: string;
  /**
   * Why the row is drawn the way it is, as hover text over the whole of it.
   *
   * For a row the card has *changed the look of* and owes the reader an
   * explanation for — the quest book's sunk rows, which are dimmed for a
   * reason the realm states. Not a place to restate what a cell already says.
   */
  title?: string;
} & Partial<Record<`data-${string}`, string>>;

const NO_FACETS: readonly Facet[] = [];

/**
 * The modifier classes a column puts on its heading and on every cell in it.
 *
 * Stated once so the two cannot drift: a `numeric` heading over cells that are
 * not right-aligned reads as a column that stopped lining up.
 */
function columnClassName<Row>(column: Column<Row>, extra?: string): string {
  return [
    extra ?? '',
    column.numeric === true ? 'numeric' : '',
    column.wide === true ? 'wide' : '',
    column.control === true ? 'control' : ''
  ]
    .filter((part) => part.length > 0)
    .join(' ');
}

export interface CardTableProps<Row> {
  rows: readonly Row[];
  columns: ReadonlyArray<Column<Row>>;
  /**
   * A stable name for a row. The index is the row's place in `rows` as the card
   * gave them, not in what is on screen — a pack can hold two torches, and a key
   * that moved when the table was sorted would be React reconciling two
   * different items into one.
   */
  keyOf(row: Row, index: number): string;
  /**
   * Which character's table this is. Its filters and its sort are remembered
   * against it, like the rail's arrangement and the Talk card's channels: a
   * healer sets an instrument up differently from a warrior, and asking again
   * on every launch is the client asking after being told.
   */
  session: SessionId;
  /** Storage name for those. `alerts` keeps `alerts-muted`, which already exists. */
  name: string;
  /** What the table is called, for anything reading the screen aloud. */
  caption: string;
  /** Placeholder for the find field. Absent means the listing is short enough not to need one. */
  find?: string;
  /** Every facet this table can ever produce; the chips drawn are the ones present. */
  facets?: readonly Facet[];
  /** Which facet a row belongs to. Required when `facets` is given. */
  facetOf?(row: Row): string;
  /**
   * The shelves the card's own order is made of, in order — `shelve`.
   *
   * A head is drawn over each shelf that has a row on screen, and only in the
   * card's own order: a column sort is a sort of the whole table, as it is on
   * every card, and takes the heads with it. The rows still carry whatever
   * the card put on them (`rowAttrs`), which is what keeps a shelved state
   * legible once the shelves are gone.
   */
  groups?: readonly Group[];
  /** Which shelf a row is on. Required when `groups` is given. */
  groupOf?(row: Row): string;
  rowAttrs?(row: Row): RowAttrs;
  /** What the card says when it holds nothing at all — a fact, not a filter result. */
  empty: ReactNode;
  /** The card's own name for its table, where its styles or the smoke run need one. */
  className?: string;
  /** Hands the caret back to the game when the find field is left. */
  returnFocus?(): void;
  /** Handle on the scroll region, for a table that pins itself to its newest row. */
  scrollerRef?: RefObject<HTMLDivElement>;
  /**
   * The key of the row whose *detail* the card is drawing under the table.
   *
   * A card with a detail panel — the quest book's timeline, opened from a row —
   * has state the table knows nothing about, and a filter that hides the row
   * used to leave the panel behind: click a quest, mute its facet, and its
   * steps stayed on screen under a table that no longer listed it. The table is
   * the only thing that knows what survived the chips and the find field, so it
   * is the thing that has to say when the row is gone.
   *
   * A key rather than the row, so this is a primitive an effect can depend on
   * without a new identity every render.
   */
  detailKey?: string | null;
  /**
   * Called when `detailKey` names a row that is no longer on screen.
   *
   * The card closes its panel; the table never touches it. Give a stable
   * callback — it is an effect dependency.
   */
  onDetailHidden?(): void;
  /**
   * Whether the find row is out, when the card drives it from a glyph.
   *
   * Left `undefined` the field stands open above the table, which is right for
   * a listing whose whole point is being searched. Given, it is the Talk card's
   * arrangement applied to a table: the row appears because somebody asked for
   * it, takes the caret because the next keystroke was always going there, and
   * clears itself on the way out — a table left quietly narrowed by a query
   * nobody can see is the failure the `n of m` line exists to prevent, and this
   * does not create it.
   */
  findOpen?: boolean;
  /** Escape in the find row: the card puts the glyph back. */
  onFindDismiss?(): void;
}

export interface FindFieldProps {
  /** What is being searched, as the placeholder and the accessible name. */
  label: string;
  query: string;
  onChange(query: string): void;
  /** Hands the caret back to the game. */
  returnFocus?(): void;
  /**
   * The row was opened by a control and Escape puts it away — the Talk
   * card's search glyph. Called after the clear, so one press still means
   * done: cleared, closed, caret returned.
   */
  onDismiss?(): void;
  /**
   * Take the caret on mount. Only for a row that appears *because the
   * player asked for it* — the search action — where the next keystroke was
   * always going here. The standing rule (never take the caret on its own)
   * is about rows that appear on their own.
   */
  autoFocus?: boolean;
}

/**
 * The find field, which is a card's answer to "where is it".
 *
 * Its own component because the Talk card needs one and is **not** a table: a
 * conversation is prose that wraps, and columns are the one thing it must not
 * be cut into. What it shares with a table is the search, not the shape.
 *
 * Two rules, both from the focus policy (docs/ui-design.md §3.6):
 *
 * - It never takes the caret on its own — no autofocus, no focus on mount. A
 *   card that grabbed the keyboard when it appeared would eat the keystroke
 *   somebody was already typing at the game.
 * - **Escape means done, once.** It clears what was typed and hands the caret
 *   back, in one press. Clearing on the first press and returning on the second
 *   is a mode, and a mode is what a player in a fight gets wrong.
 */
export function FindField({
  label,
  query,
  onChange,
  returnFocus,
  onDismiss,
  autoFocus
}: FindFieldProps): React.JSX.Element {
  return (
    <div className="table-find">
      <Icon name="search" />
      <ClearField label={label} onClear={() => onChange('')} query={query}>
        <input
          aria-label={label}
          autoFocus={autoFocus}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            onChange('');
            onDismiss?.();
            returnFocus?.();
          }}
          placeholder={label}
          type="text"
          value={query}
        />
      </ClearField>
    </div>
  );
}

/**
 * A listing whose length the player does not control.
 *
 * Three cards state one — a pack, the realm's roster, a shop's stock — and each
 * had grown its own list markup with its own alignment: a column of weights
 * only lines up because `.carried` says `margin-left: auto`, and a column that
 * lines up by accident stops lining up the first time a row is different. The
 * same failure the `.readout` grid already records, one card further out.
 *
 * So this is one table: real `<table>` markup, because a column that must align
 * across rows is what a table *is* and because `aria-sort` and `<th scope>` are
 * how a sorted column says so to somebody who cannot see it lined up.
 *
 * What it adds beyond alignment is the reason it exists: **a hundred items is
 * not a list, it is a haystack.** A find field and a row of facet chips turn
 * "what am I carrying" into "where is the key" and "show me the armour", which
 * is the question somebody with a full pack actually has.
 *
 * Three rules it enforces, so a card cannot get half of them:
 *
 * - **The tools stay put.** The table scrolls inside `.scroller`; the find
 *   field and the chips do not. A filter that scrolls away is reached for
 *   exactly when it cannot be — the rule Talk and Alerts already follow. A card
 *   using this must be `paned`.
 * - **A narrowed table says so.** Filters are remembered, so a pack narrowed to
 *   `key` a fortnight ago opens narrowed; `12 of 40` and a way to undo it are
 *   what keep that from being a card that lies about what is carried.
 * - **The find field never takes the caret on its own**, and Escape hands it
 *   back to the game. Talk's composer is the one surface that *holds* the caret
 *   while you play; this one borrows it for as long as somebody is typing in it
 *   (docs §3.6 — the palette's rule, applied to a card).
 */
export default function CardTable<Row>({
  rows,
  columns,
  keyOf,
  session,
  name,
  caption,
  find,
  facets = NO_FACETS,
  facetOf,
  groups,
  groupOf,
  rowAttrs,
  empty,
  className,
  returnFocus,
  scrollerRef,
  detailKey = null,
  onDetailHidden,
  findOpen,
  onFindDismiss
}: CardTableProps<Row>): React.JSX.Element {
  const [query, setQuery] = useState('');

  /*
   * A find row that is put away takes its query with it.
   *
   * Escape already clears in the field itself, but the glyph is the other way
   * out and a table narrowed by a query with no field on screen is exactly the
   * silent filter this card refuses to be. The `n of m` line would still say
   * so; a row hidden by something the reader can no longer see or clear is a
   * different failure and this closes it.
   */
  useEffect(() => {
    if (findOpen === false) setQuery('');
  }, [findOpen]);

  /*
   * The remembered choices are keyed against a *stable* list of what this build
   * recognises, so a value stored by an older one — a column since renamed, a
   * facet since dropped — is discarded rather than leaving the table pointed at
   * nothing. Both lists are memoised on their ids rather than on the arrays,
   * because a card that states its columns inline hands over a new array on
   * every render and the storage would be re-read on each one.
   */
  const columnIds = columns.map((column) => column.id).join('|');
  const sortable = useMemo(() => columnIds.split('|'), [columnIds]);
  const sortChoices = useMemo(
    () => ['none', ...sortable.flatMap((id) => [`${id}:up`, `${id}:down`])],
    [sortable]
  );
  const [storedSort, chooseSort] = useRememberedChoice(
    session,
    `${name}-sort`,
    sortChoices,
    'none'
  );
  const sort: Sort | null = useMemo(() => readSort(storedSort, sortable), [storedSort, sortable]);

  // Guarded, because ''.split('|') is [''] — no facets means none, not one nameless one.
  const facetKey = facets.map((facet) => facet.id).join('|');
  const facetIds = useMemo(() => (facetKey === '' ? [] : facetKey.split('|')), [facetKey]);
  const hidden = useRemembered(session, `${name}-muted`, facetIds);

  /*
   * How many rows each facet has, counted over everything the card holds rather
   * than over what is on screen: a chip saying `key 0` while keys are muted
   * would be reporting the filter back to itself.
   */
  const counts = new Map<string, number>();
  if (facetOf !== undefined) {
    for (const row of rows) {
      const id = facetOf(row);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  const searchable = columns.filter((column) => column.unsearchable !== true);
  const kept = rows.filter(
    (row) =>
      (facetOf === undefined || !hidden.has(facetOf(row))) &&
      matches(
        query,
        searchable.map((column) => column.value(row))
      )
  );
  const shown = sortRows(kept, sort, (row, id) => {
    const column = columns.find((entry) => entry.id === id);
    return column === undefined ? null : column.value(row);
  });

  const count = narrowed(shown.length, rows.length);

  /*
   * The shelves, where the card declares them and nothing is sorted. One
   * nameless shelf otherwise, so the body below is written once: a table
   * with no opinion and a sorted one are the same shape.
   */
  const shelves =
    groups !== undefined && groupOf !== undefined && sort === null
      ? shelve(shown, groups, groupOf)
      : [{ group: null, rows: shown }];

  // Where each row came in, so a key survives being filtered and sorted.
  const order = new Map(rows.map((row, at) => [row, at]));

  /*
   * Whether the card's open detail is still one of the rows on screen.
   *
   * Reported from an effect and not from this render, because the card acts on
   * it by setting state and a card told during a render would be setting state
   * during its parent's. Both dependencies are primitives, so the effect runs
   * when the answer changes rather than on every keystroke in the find field.
   */
  const detailShown =
    detailKey === null || shown.some((row) => keyOf(row, order.get(row) ?? 0) === detailKey);
  useEffect(() => {
    if (!detailShown) onDetailHidden?.();
  }, [detailShown, onDetailHidden]);

  /** Everything back: the query cleared and every muted facet unmuted. */
  const showAll = (): void => {
    setQuery('');
    for (const id of facetIds) if (hidden.has(id)) hidden.toggle(id);
  };

  /*
   * Only a facet something is actually in gets a control, the rule the Talk
   * card's channels already follow: a chip for a kind of item nobody is
   * carrying is a control that can only ever hide nothing. A muted facet that
   * empties is therefore *silently* still muted — which is exactly what the
   * `12 of 40` line above exists to stop being silent.
   */
  const present = facets.filter((facet) => (counts.get(facet.id) ?? 0) > 0);
  const tools = (find !== undefined && findOpen !== false) || present.length > 1 || count !== null;

  return (
    <>
      {tools && (
        <div className="table-tools">
          {find !== undefined && findOpen !== false && (
            <FindField
              // Only when the row came out because somebody asked for it; a
              // field that stands open never takes the caret on its own.
              autoFocus={findOpen === true}
              label={find}
              onChange={setQuery}
              onDismiss={onFindDismiss}
              query={query}
              returnFocus={returnFocus}
            />
          )}

          {present.length > 1 && (
            <div className="table-facets">
              {present.map((facet) => (
                <button
                  aria-pressed={!hidden.has(facet.id)}
                  className="chip toggle"
                  data-level={facet.level}
                  data-on={hidden.has(facet.id) ? 'false' : 'true'}
                  key={facet.id}
                  onClick={() => hidden.toggle(facet.id)}
                  // Clicked, never typed into: the caret stays with the game.
                  onMouseDown={keepFocus}
                  title={
                    hidden.has(facet.id)
                      ? t('table.chip.show', { facetLabel: facet.label })
                      : t('table.chip.hide', { facetLabel: facet.label })
                  }
                  type="button"
                >
                  {facet.label} {counts.get(facet.id) ?? 0}
                </button>
              ))}
            </div>
          )}

          {count !== null && (
            <div className="table-count">
              <span>{count}</span>
              <button className="quiet" onClick={showAll} onMouseDown={keepFocus} type="button">
                {t('table.showAll')}
              </button>
            </div>
          )}
        </div>
      )}

      {/*
        `table-scroller` beside the card's own scroll class: a table never
        scrolls sideways. A column too wide for the card is cut with an
        ellipsis, because a horizontal scrollbar on a card two hundred
        pixels tall is chrome nobody can use — and on the Self card's pack
        face it was the only thing left of the table once the tools had
        taken the height.
      */}
      <div className="scroller table-scroller" ref={scrollerRef}>
        {rows.length === 0 ? (
          <div className="empty">{empty}</div>
        ) : shown.length === 0 ? (
          <div className="empty">{t('table.noMatches')}</div>
        ) : (
          <table className={className === undefined ? 'card-table' : `card-table ${className}`}>
            {/* Named for anything reading the screen aloud; the card's own
                heading is above it and says the same thing to everyone else. */}
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th
                    aria-sort={
                      sort?.column === column.id
                        ? sort.direction
                        : column.unsortable === true
                          ? undefined
                          : 'none'
                    }
                    className={columnClassName(column)}
                    key={column.id}
                    scope="col"
                  >
                    {column.unsortable === true ? (
                      column.label
                    ) : (
                      <button
                        className="sort"
                        onClick={() => chooseSort(writeSort(nextSort(sort, column.id)))}
                        onMouseDown={keepFocus}
                        title={t('table.sortByColumn', {
                          columnLabel: column.name ?? column.label
                        })}
                        type="button"
                      >
                        {column.label}
                        {/* The arrow is the second statement, never the only
                            one: `aria-sort` above says it in words. */}
                        {sort?.column === column.id && (
                          <span aria-hidden="true" className="arrow">
                            {sort.direction === 'ascending' ? '▲' : '▼'}
                          </span>
                        )}
                      </button>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            {/*
              One body per shelf, which is what a row group is in a table: the
              head is a `<th scope="rowgroup">` across every column, so a
              screen reader hears which shelf a row is on the way a sighted
              reader sees it. Keyed by the shelf, and the rows keep their own
              keys inside it.
            */}
            {shelves.map((shelf) => (
              <tbody data-group={shelf.group?.id} key={shelf.group?.id ?? ''}>
                {shelf.group !== null && (
                  <tr className="table-group">
                    <th colSpan={columns.length} scope="rowgroup" title={shelf.group.title}>
                      {shelf.group.label}
                      <span className="table-group-count">{shelf.rows.length}</span>
                    </th>
                  </tr>
                )}
                {shelf.rows.map((row) => (
                  <tr key={keyOf(row, order.get(row) ?? 0)} {...rowAttrs?.(row)}>
                    {columns.map((column) => (
                      <td className={columnClassName(column, column.id)} key={column.id}>
                        {column.cell === undefined ? column.value(row) : column.cell(row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        )}
      </div>
    </>
  );
}
