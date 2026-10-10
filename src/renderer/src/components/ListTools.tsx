import { useEffect, useMemo, useState } from 'react';

import Icon from './Icon';
import ClearField from './ClearField';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { useRemembered } from '../hooks/useRemembered';
import { matches, narrowed, type CellValue } from '../lib/table';
import type { SessionId } from '@shared/ipc';

/*
 * The find field, the facet chips and the `n of m` line over a listing, and
 * the filtering they do. `CardTable` and the quest book's tiles both draw
 * them; the reasons are in `CardTable`'s header.
 */

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

/** What a listing is filtered by, and the rows it keeps. */
export interface ListFilterOptions<Row> {
  rows: readonly Row[];
  session: SessionId;
  /** Storage name; the muted facets are kept under `<name>-muted`. */
  name: string;
  facets: readonly Facet[];
  facetOf?(row: Row): string;
  /** The text a row is found by. */
  fields(row: Row): readonly CellValue[];
  /** Whether the find row is out, when the card drives it from a glyph. */
  findOpen?: boolean;
  /** The row whose detail the card draws, by key, and how to find a row's key. */
  detailKey?: string | null;
  keyOf?(row: Row): string;
  /** Called when `detailKey` names a row no longer kept. Give a stable callback. */
  onDetailHidden?(): void;
}

export interface ListFilter<Row> {
  query: string;
  setQuery(query: string): void;
  kept: Row[];
  /** How many rows each facet has, over everything the card holds. */
  counts: ReadonlyMap<string, number>;
  /** The facets something is in: only those get a chip. */
  present: readonly Facet[];
  muted: { has(id: string): boolean; toggle(id: string): void };
  /** `n of m` while something is hidden, else null. */
  count: string | null;
  /** Everything back: the query cleared and every muted facet unmuted. */
  showAll(): void;
}

export function useListFilter<Row>({
  rows,
  session,
  name,
  facets,
  facetOf,
  fields,
  findOpen,
  detailKey = null,
  keyOf,
  onDetailHidden
}: ListFilterOptions<Row>): ListFilter<Row> {
  const [query, setQuery] = useState('');

  /*
   * A find row that is put away takes its query with it: a listing narrowed by
   * a query with no field on screen is the silent filter this refuses to be.
   */
  useEffect(() => {
    if (findOpen === false) setQuery('');
  }, [findOpen]);

  // Guarded, because ''.split('|') is [''] — no facets means none, not one nameless one.
  const facetKey = facets.map((facet) => facet.id).join('|');
  const facetIds = useMemo(() => (facetKey === '' ? [] : facetKey.split('|')), [facetKey]);
  const muted = useRemembered(session, `${name}-muted`, facetIds);

  /*
   * Counted over everything the card holds rather than over what is on screen:
   * a chip saying `key 0` while keys are muted would be reporting the filter
   * back to itself.
   */
  const counts = new Map<string, number>();
  if (facetOf !== undefined) {
    for (const row of rows) {
      const id = facetOf(row);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  const kept = rows.filter(
    (row) => (facetOf === undefined || !muted.has(facetOf(row))) && matches(query, fields(row))
  );

  /*
   * Whether the card's open detail is still one of the rows kept. Reported
   * from an effect, because the card acts on it by setting state; both
   * dependencies are primitives, so it runs when the answer changes.
   */
  const detailShown =
    detailKey === null || keyOf === undefined || kept.some((row) => keyOf(row) === detailKey);
  useEffect(() => {
    if (!detailShown) onDetailHidden?.();
  }, [detailShown, onDetailHidden]);

  return {
    query,
    setQuery,
    kept,
    counts,
    // A chip for a facet nothing is in could only ever hide nothing.
    present: facets.filter((facet) => (counts.get(facet.id) ?? 0) > 0),
    muted,
    count: narrowed(kept.length, rows.length),
    showAll: () => {
      setQuery('');
      for (const id of facetIds) if (muted.has(id)) muted.toggle(id);
    }
  };
}

/** The tools row: what to draw of it is the card's, by its size. */
export function ListTools<Row>({
  filter,
  find,
  finding,
  chips,
  findOpen,
  onFindDismiss,
  returnFocus
}: {
  filter: ListFilter<Row>;
  find: string | undefined;
  finding: boolean;
  chips: boolean;
  findOpen?: boolean;
  onFindDismiss?(): void;
  returnFocus?(): void;
}): React.JSX.Element | null {
  const { query, setQuery, present, muted, counts, count, showAll } = filter;
  if (!(finding || chips || count !== null)) return null;
  return (
    <div className="table-tools">
      {finding && find !== undefined && (
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

      {chips && (
        <div className="table-facets">
          {present.map((facet) => (
            <button
              aria-pressed={!muted.has(facet.id)}
              className="chip toggle"
              data-facet={facet.id}
              data-level={facet.level}
              data-on={muted.has(facet.id) ? 'false' : 'true'}
              key={facet.id}
              onClick={() => muted.toggle(facet.id)}
              // Clicked, never typed into: the caret stays with the game.
              onMouseDown={keepFocus}
              title={
                muted.has(facet.id)
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
  );
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
  /**
   * Inside a surface that owns its own Escape, the settings panel: a press that
   * clears stops here, and a press on an empty field is the surface's.
   */
  nested?: boolean;
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
  autoFocus,
  nested
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
            if (nested === true) {
              if (query === '') return;
              event.stopPropagation();
            }
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
