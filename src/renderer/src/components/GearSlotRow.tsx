import { memo } from 'react';

import GearToggle from './GearToggle';
import Icon from './Icon';
import { t } from '../lib/i18n';
import { keepFocus } from '../lib/focus';
import { declineKey, priceWords, type SlotState } from '../lib/gearPicks';
import type { GearChoice, GearSlot } from '@shared/upgrades';

/**
 * One slot of the Gear card on one line, where the card is too small for a
 * tile a slot: the glyph tinted by the slot's state, the slot's name, and the
 * suggestion as its toggle, or what the slot is doing in its place. The name
 * opens the slot into its whole tile, where the other choices are.
 */
function GearSlotRow({
  slot,
  state,
  suggested,
  declined,
  onDecline,
  onOpen
}: {
  slot: GearSlot;
  state: SlotState;
  suggested: readonly GearChoice[];
  declined: ReadonlySet<string>;
  onDecline(slot: string, item: number): void;
  onOpen(slot: string): void;
}) {
  const best = slot.items[0];
  return (
    <li className="gear-slot gear-row tile" data-slot={slot.slot} data-state={state}>
      <span className="gear-slot-glyph" aria-hidden="true">
        <Icon name={slot.ranking === 'weapon' ? 'sword' : 'shield'} />
      </span>
      <button
        aria-expanded={false}
        className="gear-slot-name gear-fold"
        onClick={() => onOpen(slot.slot)}
        onMouseDown={keepFocus}
        title={t('cards.gear.unfold')}
        type="button"
      >
        {slot.slot}
      </button>
      <span className="gear-row-what">
        {state === 'best' ? (
          <span className="gear-row-note" title={slot.worn ?? undefined}>
            <Icon name="check" /> {t('cards.gear.bestWorn')}
          </span>
        ) : state === 'reach' ? (
          <span className="gear-row-note" title={t('cards.gear.outOfReach')}>
            {best?.name}
            {best?.sold === null || best === undefined ? null : (
              <span className="gear-price">{priceWords(best.charged)}</span>
            )}
          </span>
        ) : (
          suggested.map((item) => (
            <GearToggle
              buy={!declined.has(declineKey(slot.slot, item.item))}
              compact
              item={item}
              key={item.item}
              onDecline={onDecline}
              slot={slot.slot}
            />
          ))
        )}
      </span>
    </li>
  );
}

export default memo(GearSlotRow);
