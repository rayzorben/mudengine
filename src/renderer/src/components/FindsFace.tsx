import { useMemo } from 'react';

import CardTable, { type Column, type Facet } from './CardTable';
import Icon from './Icon';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { coinText } from '../lib/coins';
import { copperSpread } from '@shared/coins';
import { ago } from '../lib/players';
import { findRate, isCash, within, type Find } from '@shared/finds';
import type { SessionId } from '@shared/ipc';

/*
 * Money or a thing, the one line `Find.copper` already draws: a room searched
 * every lap for its farthings buries the one scroll it turned up once. Both
 * are listed whatever the log holds, because the remembered mute is checked
 * against this list.
 */
const KINDS: readonly Facet[] = [
  { id: 'item', label: t('cards.room.finds.facet.item') },
  { id: 'cash', label: t('cards.room.finds.facet.cash') }
];

function kindOf(find: Find): string {
  return isCash(find) ? 'cash' : 'item';
}

export interface FindsFaceProps {
  session: SessionId;
  /** The realm's whole log, oldest first. The window is applied here. */
  finds: readonly Find[];
  /**
   * How many days back to show, `0` for all.
   *
   * A window on the record, never a purge of it: `FindBook` keeps what it kept,
   * so turning this up brings rows back. See `CardSettings.findDays`.
   */
  days: number;
  /** Opens the route panel at a room. Null on a pinned float, which cannot. */
  goToRoom: ((room: string) => void) | null;
  /** Strikes a row out, because the person reading it says it is wrong. */
  forget?(find: Pick<Find, 'room' | 'name'>): void;
  returnFocus?(): void;
}

/**
 * What searching has turned up in this realm, rarest first (`byRarest`): the
 * card's own order, so a heading's third click comes back to it.
 *
 * A **log**, and the only one on this card: every other face says something
 * about the room the character is standing in, and this one says what the realm
 * has been hiding, wherever. That is deliberate rather than a compromise — a
 * find is worth writing down precisely because the room will not mention it
 * again (a bare Enter after a search reprints the room with no `You notice`
 * line at all), so a face scoped to *here* would be empty in the moment anybody
 * wanted it and would never answer "where did I see one of those".
 *
 * A table rather than a list, by the standing test: its length is the realm's
 * and not the player's, and `Where` is worth cutting it by.
 *
 * **Every room is a control.** A row names a place, and a place in this client
 * is something you can be sent to — the route panel opens with the plan drawn,
 * because a click that walked a character would be the easiest possible way to
 * send one somewhere by accident.
 */
export default function FindsFace({
  session,
  finds,
  days,
  goToRoom,
  forget,
  returnFocus
}: FindsFaceProps): React.JSX.Element {
  /*
   * The window and the sort in one pass, and `Date.now()` read once per render
   * rather than per row: a table of two hundred rows each asking the clock is
   * two hundred different "now"s, and the relative times would disagree with
   * each other down the column.
   */
  const now = Date.now();
  const rows = useMemo(() => within(finds, days, now), [finds, days, now]);

  const columns = useMemo<ReadonlyArray<Column<Find>>>(
    () => [
      {
        id: 'what',
        label: t('cards.room.finds.what'),
        wide: true,
        value: (find) => find.name
      },
      {
        id: 'many',
        label: t('cards.room.finds.many'),
        numeric: true,
        /*
         * Blank where the server did not count, which is most things: `Find.
         * quantity` is null rather than one for exactly this cell, and a
         * column of `1`s would be the card asserting a number the wire never
         * sent. Cash shows what it is worth instead, which is the question
         * anybody asks of found money.
         */
        value: (find) => find.copper ?? find.quantity,
        cell: (find) =>
          find.copper !== null
            ? coinText(copperSpread(find.copper), 1)
            : (find.quantity?.toString() ?? '')
      },
      {
        id: 'where',
        label: t('cards.room.finds.where'),
        value: (find) => find.roomName,
        cell: (find) =>
          goToRoom === null ? (
            find.roomName
          ) : (
            <button
              className="lookup"
              onClick={() => goToRoom(find.room)}
              onMouseDown={keepFocus}
              title={t('cards.room.finds.goToTooltip', { room: find.room })}
              type="button"
            >
              {find.roomName}
            </button>
          )
      },
      {
        id: 'when',
        label: t('cards.room.finds.when'),
        // Sorted on the stamp and drawn in words: `2 hours ago` sorts as text
        // in the wrong order entirely, and the number nobody wants to read.
        value: (find) => find.at,
        cell: (find) => ago(find.at, now),
        numeric: true
      },
      {
        id: 'seen',
        label: t('cards.room.finds.seen'),
        numeric: true,
        value: (find) => find.seen
      },
      {
        id: 'chance',
        label: t('cards.room.finds.chance'),
        numeric: true,
        // A fraction is nothing anybody types, and `0` would match every row.
        unsearchable: true,
        // Blank, never `0%`, before the room's first counted search: a row
        // written before searches were counted has no rate yet, not a low one.
        value: (find) => findRate(find),
        cell: (find) => {
          const rate = findRate(find);
          return rate === null ? (
            ''
          ) : (
            <span
              title={t('cards.room.finds.chanceTooltip', {
                hits: find.hits,
                searched: find.searched
              })}
            >
              {percentText(rate)}
            </span>
          );
        }
      },
      ...(forget === undefined
        ? []
        : [
            {
              id: 'forget',
              label: t('cards.room.finds.forget'),
              control: true,
              unsearchable: true,
              unsortable: true,
              value: () => null,
              cell: (find: Find) => (
                <button
                  aria-label={t('cards.room.finds.forgetAria', {
                    what: find.name,
                    room: find.roomName
                  })}
                  className="quiet row-action"
                  onClick={() => forget({ room: find.room, name: find.name })}
                  onMouseDown={keepFocus}
                  title={t('cards.room.finds.forgetTooltip')}
                  type="button"
                >
                  <Icon name="close" />
                </button>
              )
            } satisfies Column<Find>
          ])
    ],
    [forget, goToRoom, now]
  );

  return (
    <CardTable
      caption={t('cards.room.finds.caption')}
      className="finds-table"
      columns={columns}
      empty={t('cards.room.finds.empty')}
      facetOf={kindOf}
      facets={KINDS}
      find={t('cards.room.finds.findPlaceholder')}
      keyOf={(find) => `${find.room}|${find.name}`}
      name="finds"
      returnFocus={returnFocus}
      rows={rows}
      session={session}
    />
  );
}

/**
 * A rate as a percentage, a decimal place below ten so one find in three
 * hundred searches does not read as never.
 */
function percentText(rate: number): string {
  const percent = rate * 100;
  return `${percent > 0 && percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

/** The face's own clipboard text: the table as it reads, rarest first. */
export function findsCopyText(finds: readonly Find[], days: number, now: number): string {
  const rows = within(finds, days, now);
  if (rows.length === 0) return t('cards.room.finds.empty');
  return rows
    .map((find) => {
      const many =
        find.copper !== null
          ? coinText(copperSpread(find.copper), 1)
          : find.quantity === null
            ? ''
            : `${find.quantity} `;
      const rate = findRate(find);
      const chance = rate === null ? '' : `, ${percentText(rate)}`;
      return `${many}${find.name} — ${find.roomName} ${find.room}, ${ago(find.at, now)} (${find.seen}${chance})`;
    })
    .join('\n');
}
