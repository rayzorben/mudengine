import { useMemo } from 'react';

import CardTable, { type Column } from './CardTable';
import type { Facet } from './ListTools';
import Icon from './Icon';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { coinText } from '../lib/coins';
import { ago } from '../lib/players';
import { bandWord, rarityClock } from '../lib/rarityText';
import { findRate, rarityRank, isCash, within, type Find } from '@shared/finds';
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
        cell: howMany
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
        id: 'rarity',
        label: t('cards.room.finds.rarity'),
        numeric: true,
        // The value is a sort rank, and a rank matches nothing anybody types.
        unsearchable: true,
        // Sorted by the realm's rarity, drawn as its band. Blank for cash,
        // which is not an item. Cash and unknown have no value here, so the
        // column sorts them last either way (`sortRows`); the card's own
        // order still ranks them (`byRarest`).
        value: (find) =>
          find.rarity === null || find.rarity.rarity === 'unknown' ? null : rarityRank(find),
        cell: (find) =>
          find.rarity === null ? '' : <span title={rarityTitle(find)}>{bandWord(find.rarity)}</span>
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
 * The rarity cell's hover: the hours to one copy at the realm's quickest
 * source, then how often searching this room has turned it up, which is a
 * fact about the room rather than the item.
 */
function rarityTitle(find: Find): string {
  const parts: string[] = [];
  if (find.rarity?.hours != null) {
    parts.push(t('cards.room.finds.everyTooltip', { clock: rarityClock(find.rarity.hours) }));
  }
  if (findRate(find) !== null) {
    parts.push(t('cards.room.finds.searchedTooltip', { hits: find.hits, searched: find.searched }));
  }
  return parts.join('\n');
}

/**
 * The How many cell: cash as the search counted it (`24323 gold`); blank for
 * a thing nobody counted and for cash kept before the coins were (`Find.coins`).
 */
function howMany(find: Find): string {
  if (isCash(find)) return coinText(find.coins, 1);
  return find.quantity?.toString() ?? '';
}

/** The face's own clipboard text: the table as it reads, rarest first. */
export function findsCopyText(finds: readonly Find[], days: number, now: number): string {
  const rows = within(finds, days, now);
  if (rows.length === 0) return t('cards.room.finds.empty');
  return rows
    .map((find) => {
      const counted = howMany(find);
      const many = counted === '' ? '' : `${counted} `;
      const rarity = find.rarity === null ? '' : `, ${bandWord(find.rarity)}`;
      return `${many}${find.name} — ${find.roomName} ${find.room}, ${ago(find.at, now)} (${find.seen}${rarity})`;
    })
    .join('\n');
}
