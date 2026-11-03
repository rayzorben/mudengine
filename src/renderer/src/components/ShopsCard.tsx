import { memo, useMemo, type CSSProperties } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import CardTable, { type Column } from './CardTable';
import ItemThumb from './ItemThumb';
import ShelfStrip from './ShelfStrip';
import EntityName, { RoomName } from './EntityName';
import { useItemArt } from '../hooks/useItemArt';
import { t } from '../lib/i18n';
import { ago } from '../lib/players';
import { isOwnName } from '@shared/players';
import { shelfLines, type Shelf, type ShelfLine } from '@shared/shops';
import type { SessionId } from '@shared/ipc';

export interface ShopsCardProps extends CardChrome {
  /** Every counter's last `list` in this realm. */
  shelves: readonly Shelf[];
  /** Which character is reading, so its filters and sort are remembered per character. */
  session: SessionId;
  /** This character's name: a `You can't use` note is shown only on its own listings. */
  self: string | null;
  /** The purse in copper (`Inventory.wealth`), each price is drawn against; null while unread. */
  purse: number | null;
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
  purse,
  goToRoom,
  inspect,
  ...chrome
}: ShopsCardProps): React.JSX.Element {
  const lines = useMemo(() => shelfLines(shelves), [shelves]);
  const art = useItemArt();
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
            {/* Large, each line carries the thing's picture. */}
            <ItemThumb art={art} className="from-large" realm={null} thing={line.item} />
            <EntityName className="what" inspect={inspect} name={line.item.name} />
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
        // Small, a line is the item and its price against the purse.
        from: 'medium',
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
        cell: (line) => <Price line={line} purse={purse} />
      },
      {
        id: 'shop',
        label: t('cards.shops.column.shop'),
        from: 'medium',
        value: (line) => line.shelf.shopName,
        cell: (line) => (
          <RoomName open={goToRoom} room={line.shelf.room}>
            {line.shelf.shopName}
          </RoomName>
        )
      },
      {
        id: 'listed',
        label: t('cards.shops.column.listed'),
        from: 'large',
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
    [art, goToRoom, inspect, now, purse, self]
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
      {/* Large, a tile a counter over the lines: where each list was read and how long ago. */}
      <ShelfStrip goToRoom={goToRoom} now={now} shelves={shelves} />
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

/**
 * A price as the counter quoted it, over a hairline drawn to its share of the
 * purse: full and in the danger ink where it costs more than is carried. No
 * hairline where either side is unknown, since a guess at either would read
 * as an answer.
 */
function Price({ line, purse }: { line: ShelfLine; purse: number | null }) {
  // A free line and an unread purse have no share to draw.
  const share =
    line.copper === null || line.copper === 0 || purse === null
      ? null
      : purse <= 0
        ? 1
        : line.copper / purse;
  const over = share !== null && line.copper !== null && purse !== null && line.copper > purse;
  return (
    <span
      className="shop-price"
      data-over={over}
      title={
        share === null
          ? undefined
          : over
            ? t('cards.shops.priceOver')
            : t('cards.shops.priceShare', { share: Math.max(1, Math.round(share * 100)) })
      }
    >
      {line.item.price}
      {share !== null && <i style={{ '--share': Math.min(1, share) } as CSSProperties} />}
    </span>
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
