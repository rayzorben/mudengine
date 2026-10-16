/**
 * One of the Room card's two floor rows, what the room shows or what a search
 * turned up: the coins, then each thing with its lookup, the mark saying
 * whether this character may use it (`canUse`, the console rewrite's verdict,
 * todo 146), and its worth or the `fixed` chip.
 */
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { canUse } from '@shared/canUse';
import type { ItemEntity } from '@shared/entities';
import type { Wearer } from '@shared/gear';
import { countedLabel } from '@shared/items';
import { USE_MARK } from '@shared/rewrites';

export interface FloorItemsProps {
  items: readonly ItemEntity[];
  /** The coins in the card's purse words, or '' where none lie here. */
  coins: string;
  wearer: Wearer;
  inspect?(name: string, anchor: HTMLElement): void;
}

export default function FloorItems({ items, coins, wearer, inspect }: FloorItemsProps) {
  return (
    <dd className="floor">
      {/*
        The coins first: a search that turns up only cash (`You notice 4
        copper farthings here.`) has no items, and the row still has to say
        so. They are not `ItemEntity`s and are not lookups.
      */}
      {coins.length > 0 && (
        <span className="coins">
          {coins}
          {items.length > 0 && ', '}
        </span>
      )}
      {items.map((item, index) => {
        const use = canUse(item, wearer, t);
        const said = use.state === 'usable' ? t('cards.room.usableTitle') : use.label;
        return (
          <span key={`${item.name}-${index}`}>
            <span
              aria-label={said}
              className="use-mark"
              data-use={use.state}
              role="img"
              title={said}
            >
              {USE_MARK[use.state]}
            </span>{' '}
            {inspect ? (
              <button
                className="lookup"
                onClick={(event) => inspect(item.name, event.currentTarget)}
                onMouseDown={keepFocus}
                title={t('cards.room.itemLookupTooltip')}
                type="button"
              >
                {countedLabel(item)}
              </button>
            ) : (
              countedLabel(item)
            )}
            {/*
              What the realm says it is worth, absent for a name it cannot
              place and for the many things it says are worth nothing. Not for
              a thing nobody may pick up: the realm's own furniture is named
              (format 42), and *worth taking* has no answer there.
            */}
            {item.gettable === false ? (
              <>
                {' '}
                <span className="chip quiet" title={t('cards.room.fixedTitle')}>
                  {t('cards.room.fixedChip')}
                </span>
              </>
            ) : (
              item.price !== undefined && <span className="price"> {item.price}</span>
            )}
            {index < items.length - 1 && ', '}
          </span>
        );
      })}
    </dd>
  );
}
