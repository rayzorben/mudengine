import { memo } from 'react';

import Icon from './Icon';
import { t } from '../lib/i18n';
import { keepFocus } from '../lib/focus';
import { gainWords, priceWords } from '../lib/gearPicks';
import type { GearChoice } from '@shared/upgrades';

/**
 * A suggestion on the Gear card, the one control a slot has: green to buy, a
 * click turns it red, declined, and back. The tile draws it whole; a slot's
 * row draws it `compact`, the name and price without the shop or the gain.
 */
function GearToggle({
  slot,
  item,
  buy,
  compact = false,
  onDecline
}: {
  slot: string;
  item: GearChoice;
  buy: boolean;
  compact?: boolean;
  onDecline(slot: string, item: number): void;
}) {
  const gain = compact ? '' : gainWords(item.gain);
  return (
    <button
      aria-pressed={buy}
      className="gear-toggle"
      data-buy={buy ? 'true' : 'false'}
      data-compact={compact ? 'true' : undefined}
      onClick={() => onDecline(slot, item.item)}
      onMouseDown={keepFocus}
      title={buy ? t('cards.gear.declineTitle') : t('cards.gear.buyTitle')}
      type="button"
    >
      <span className="gear-toggle-mark" aria-hidden="true">
        <Icon name={buy ? 'check' : 'close'} />
      </span>
      <span className="gear-toggle-body">
        <span className="gear-item-name">{item.name}</span>
        {compact ? null : (
          <span className="gear-meta">
            {item.sold === null
              ? buy
                ? t('cards.gear.buying')
                : t('cards.gear.declined')
              : buy
                ? t('cards.gear.buyingAt', { shop: item.sold.shop })
                : t('cards.gear.declinedAt', { shop: item.sold.shop })}
          </span>
        )}
      </span>
      {gain === '' ? null : <span className="gear-gain">{gain}</span>}
      <span className="gear-price">{priceWords(item.charged)}</span>
    </button>
  );
}

export default memo(GearToggle);
