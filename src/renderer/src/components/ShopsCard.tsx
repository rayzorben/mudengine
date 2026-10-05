import { memo, useMemo } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import CardTable, { type Column } from './CardTable';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { ago, isOwnName } from '../lib/players';
import { shelfLines, type Shelf, type ShelfLine } from '@shared/shops';
import type { SessionId } from '@shared/ipc';

export interface ShopsCardProps extends CardChrome {
  /** Every counter's last `list` in this realm. */
  shelves: readonly Shelf[];
  /** Which character is reading, so its filters and sort are remembered per character. */
  session: SessionId;
  /** This character's name: a `You can't use` note is shown only on its own listings. */
  self: string | null;
  /** Opens the route panel at a room. Null on a pinned float, which cannot. */
  goToRoom: ((room: string) => void) | null;
  /** Opens the Reference card on an item. */
  inspect?(name: string, anchor: HTMLElement): void;
}

/**
 * Every line of every shop anybody has typed `list` in, in this realm: what is
 * for sale, at what price, how many are left and where.
 *
 * One row per item, because the card is opened to ask where an item is sold: type the item and every shop selling
 * it is listed cheapest first, with its age beside it, since a shelf seen last
 * week may have sold out. The shop is a control that plans a route there.
 */
function ShopsCard({
  shelves,
  session,
  self,
  goToRoom,
  inspect,
  ...chrome
}: ShopsCardProps): React.JSX.Element {
  const lines = useMemo(() => shelfLines(shelves), [shelves]);
  // Once per render, so two rows listed in the same second print the same age.
  const now = Date.now();

  const columns = useMemo<ReadonlyArray<Column<ShelfLine>>>(
    () => [
      {
        id: 'item',
        label: t('cards.shops.column.item'),
        wide: true,
        value: (line) => line.item.name,
        cell: (line) => (
          <>
            {inspect ? (
              <button
                className="what lookup"
                onClick={(event) => inspect(line.item.name, event.currentTarget)}
                onMouseDown={keepFocus}
                title={t('cards.room.itemLookupTooltip')}
                type="button"
              >
                {line.item.name}
              </button>
            ) : (
              <span className="what">{line.item.name}</span>
            )}
            {/* The counter's judgment about whoever listed it, so only this character's own. */}
            {line.item.note !== null && line.shelf.by !== null && isOwnName(self, line.shelf.by) ? (
              <>
                {' '}
                <span className="chip warn">{t('cards.room.shop.cantUseChip')}</span>
              </>
            ) : null}
          </>
        )
      },
      {
        id: 'quantity',
        label: t('cards.shops.column.quantity'),
        numeric: true,
        // Blank where the counter printed no figure, never `0`.
        value: (line) => line.item.quantity,
        cell: (line) => line.item.quantity?.toString() ?? ''
      },
      {
        id: 'price',
        label: t('cards.shops.column.price'),
        numeric: true,
        // Sorted in copper, drawn as the counter quoted it (`coins.ts`).
        unsearchable: true,
        value: (line) => line.copper,
        cell: (line) => line.item.price
      },
      {
        id: 'shop',
        label: t('cards.shops.column.shop'),
        value: (line) => line.shelf.shopName,
        cell: (line) =>
          goToRoom === null ? (
            line.shelf.shopName
          ) : (
            <button
              className="lookup"
              onClick={() => goToRoom(line.shelf.room)}
              onMouseDown={keepFocus}
              title={t('cards.shops.goToTooltip', { room: line.shelf.room })}
              type="button"
            >
              {line.shelf.shopName}
            </button>
          )
      },
      {
        id: 'listed',
        label: t('cards.shops.column.listed'),
        numeric: true,
        unsearchable: true,
        value: (line) => line.shelf.at,
        cell: (line) => (
          <span
            title={
              line.shelf.by === null
                ? undefined
                : t('cards.shops.listedBy', { name: line.shelf.by })
            }
          >
            {ago(line.shelf.at, now)}
          </span>
        )
      }
    ],
    [goToRoom, inspect, now, self]
  );

  return (
    <BentoCard
      {...chrome}
      badge={
        shelves.length === 0 ? undefined : (
          <span className="chip">{t('cards.shops.badge', { count: shelves.length })}</span>
        )
      }
      className="shops-card"
      copyText={() => shopsCopyText(lines, now)}
      paned
      title={t('cards.shops.title')}
    >
      <CardTable
        caption={t('cards.shops.caption')}
        className="shops-table"
        columns={columns}
        empty={t('cards.shops.empty')}
        find={t('cards.shops.findPlaceholder')}
        keyOf={(line, index) => `${line.shelf.room}|${line.item.name}|${index}`}
        name="shops"
        returnFocus={chrome.returnFocus}
        rows={lines}
        session={session}
      />
    </BentoCard>
  );
}

/** The card's clipboard text: one line per item, in the card's own order. */
export function shopsCopyText(lines: readonly ShelfLine[], now: number): string {
  if (lines.length === 0) return t('cards.shops.empty');
  return lines
    .map((line) =>
      t('cards.shops.copyRow', {
        item: line.item.name,
        price: line.item.price,
        quantity: line.item.quantity ?? '?',
        shop: line.shelf.shopName,
        age: ago(line.shelf.at, now)
      })
    )
    .join('\n');
}

export default memo(ShopsCard);
