/**
 * The Shops card's counters as a row of tiles, drawn from large: each shop's
 * name, how many lines its list had, and how long ago it was read, newest
 * first. Two rows of tiles at most; more scroll inside the strip, so a realm
 * of thirty shops never takes the lines' room. A tile plans a route to its shop where the
 * card can (`goToRoom`).
 */
import { memo, useMemo } from 'react';

import type { Shelf } from '@shared/shops';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { ago } from '../lib/players';

function ShelfStrip({
  shelves,
  now,
  goToRoom
}: {
  shelves: readonly Shelf[];
  now: number;
  goToRoom: ((room: string) => void) | null;
}) {
  const newest = useMemo(() => [...shelves].sort((a, b) => b.at - a.at), [shelves]);
  if (newest.length === 0) return null;
  return (
    <ul aria-label={t('cards.shops.stripAria')} className="shelf-strip from-large">
      {newest.map((shelf) => {
        const body = (
          <>
            <b>{shelf.shopName}</b>
            <span>
              {shelf.items.length === 1
                ? t('cards.shops.tileLines.one')
                : t('cards.shops.tileLines.many', { count: shelf.items.length })}
              {' · '}
              {ago(shelf.at, now)}
            </span>
          </>
        );
        return (
          <li key={shelf.room}>
            {goToRoom === null ? (
              <div className="shelf-tile">{body}</div>
            ) : (
              <button
                className="shelf-tile"
                onClick={() => goToRoom(shelf.room)}
                onMouseDown={keepFocus}
                title={t('cards.shops.goToTooltip', { room: shelf.room })}
                type="button"
              >
                {body}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default memo(ShelfStrip);
