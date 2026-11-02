/**
 * Where this client has seen an item in the realm played, one place per line
 * and newest first: a floor, a shop's last list, a search. Each room opens the
 * route panel, as a shop in `Sold by` does. See `mudengine-world` ›
 * `parts/lore.md` › *What lies on a floor is kept per realm*.
 */
import { useState } from 'react';
import { t } from '../lib/i18n';
import { ago } from '../lib/players';
import { tuning } from '../lib/tuning';
import type { ItemSeen } from '@shared/itemSeen';
import { asRoomReference } from '@shared/world';

function where(seen: ItemSeen): string {
  switch (seen.where) {
    case 'floor':
      return t('cards.reference.item.seen.floor');
    case 'shop':
      return seen.quantity === null
        ? t('cards.reference.item.seen.shop', { price: seen.price })
        : t('cards.reference.item.seen.shopLeft', { price: seen.price, count: seen.quantity });
    case 'search':
      return seen.seen === 1
        ? t('cards.reference.item.seen.search.one')
        : t('cards.reference.item.seen.search.many', { count: seen.seen });
    default: {
      const never: never = seen;
      return never;
    }
  }
}

export function SeenIn({
  seen,
  onRoom,
  onResize
}: {
  seen: readonly ItemSeen[];
  onRoom: ((map: number, room: number) => void) | null;
  onResize: (() => void) | null;
}) {
  const [all, setAll] = useState(false);
  // Ages read against the moment the panel opened; the panel does not tick.
  const [now] = useState(() => Date.now());
  const rows = tuning().itemSeenRows;
  const shown = all ? seen : seen.slice(0, rows);
  return (
    <dd className="item-seen">
      {shown.map((row, index) => {
        const at = asRoomReference(row.room);
        return (
          <span
            // Two spellings the index settles to one row can share a room.
            key={`${row.where}-${row.room}-${index}`}
            title={
              row.where === 'floor'
                ? t('cards.reference.item.seen.firstTitle', { ago: ago(row.first, now) })
                : undefined
            }
          >
            {at !== null && onRoom !== null ? (
              <button
                className="lookup"
                onClick={() => onRoom(at.map, at.room)}
                title={t('cards.reference.item.shopRouteTitle', { room: row.roomName })}
                type="button"
              >
                {row.roomName}
              </button>
            ) : (
              row.roomName
            )}{' '}
            {where(row)}
            <span className="quiet">
              {t('cards.reference.item.seen.ago', { ago: ago(row.at, now) })}
            </span>
          </span>
        );
      })}
      {seen.length > rows && (
        <button
          aria-expanded={all}
          className="lookup"
          onClick={() => {
            setAll(!all);
            // The slide-out is placed against its measured size; see `PlacesIn`.
            onResize?.();
          }}
          type="button"
        >
          {all
            ? t('cards.reference.item.seen.showFewer')
            : t('cards.reference.item.seen.showAll', { count: seen.length })}
        </button>
      )}
    </dd>
  );
}
