import { memo, useState } from 'react';

import Icon from './Icon';
import { t } from '../lib/i18n';
import { keepFocus } from '../lib/focus';
import GearToggle from './GearToggle';
import EntityName, { type Inspect } from './EntityName';
import { declineKey, gainWords, priceWords, slotState, sourceWords } from '../lib/gearPicks';
import type { GearChoice, GearSlot } from '@shared/upgrades';

/**
 * One slot of the Gear card, as a tile: what is worn, the best the character
 * can wear there from anywhere and where it comes from, and the suggestion the
 * cash reaches, which is the tile's one control: green is bought, a click
 * turns it red, declined, and back. A slot with nothing better at this level
 * says the best is on; one whose better items the cash does not reach says
 * so, with the price of the best. *Other choices* opens every better item to
 * choose another in place of the suggestion.
 */
export interface GearSlotTileProps {
  slot: GearSlot;
  /** What the budget suggests here, the player's own choice included. */
  suggested: readonly GearChoice[];
  declined: ReadonlySet<string>;
  /** Whether the suggestion is the player's own choice rather than the budget's. */
  chosen: boolean;
  budget: number;
  inspect: Inspect | undefined;
  onDecline(slot: string, item: number): void;
  onChoose(slot: GearSlot, item: number): void;
  onReset(slot: string): void;
  /** Folds the tile back into its row, where the card draws slots as rows; absent where it does not. */
  onFold?(slot: string): void;
}

function GearSlotTile({
  slot,
  suggested,
  declined,
  chosen,
  budget,
  inspect,
  onDecline,
  onChoose,
  onReset,
  onFold
}: GearSlotTileProps) {
  const [open, setOpen] = useState(false);
  const best = slot.items[0];
  const state = slotState(slot, suggested, declined);
  const others = slot.items.length - (best === undefined ? 0 : 1);
  return (
    <li className="gear-slot tile" data-state={state} data-slot={slot.slot}>
      <header className="gear-slot-head">
        <span className="gear-slot-glyph" aria-hidden="true">
          <Icon name={slot.ranking === 'weapon' ? 'sword' : 'shield'} />
        </span>
        {onFold === undefined ? (
          <span className="gear-slot-name">{slot.slot}</span>
        ) : (
          <button
            aria-expanded
            className="gear-slot-name gear-fold"
            onClick={() => onFold(slot.slot)}
            onMouseDown={keepFocus}
            title={t('cards.gear.fold')}
            type="button"
          >
            {slot.slot}
          </button>
        )}
        {state === 'best' ? (
          <span className="chip on cased">
            <Icon name="check" /> {t('cards.gear.bestWorn')}
          </span>
        ) : best !== undefined && suggested.some((item) => item.item === best.item) ? (
          <span className="chip info cased">{t('cards.gear.bestInSlot')}</span>
        ) : null}
      </header>

      <dl className="gear-lines">
        <dt>{t('cards.gear.worn')}</dt>
        <dd className={slot.worn === null ? 'gear-empty' : 'gear-worn'}>
          {slot.worn === null ? (
            t('cards.gear.nothingWorn')
          ) : (
            <EntityName inspect={inspect} name={slot.worn} />
          )}
        </dd>
        {best === undefined ? null : (
          <>
            <dt>{t('cards.gear.best')}</dt>
            <dd className="gear-best">
              <EntityName className="gear-item-name" inspect={inspect} name={best.name} />
              <span className="gear-meta">
                {sourceWords(best)}
                {best.sold === null ? null : (
                  <span
                    className={
                      best.charged !== null && best.charged > budget
                        ? 'chip warn cased'
                        : 'chip quiet cased'
                    }
                  >
                    {priceWords(best.charged)}
                  </span>
                )}
              </span>
            </dd>
          </>
        )}
      </dl>

      {state === 'best' ? null : state === 'reach' ? (
        <p className="gear-reach">{t('cards.gear.outOfReach')}</p>
      ) : (
        <div className="gear-suggest">
          {suggested.map((item) => (
            <GearToggle
              buy={!declined.has(declineKey(slot.slot, item.item))}
              item={item}
              key={item.item}
              onDecline={onDecline}
              slot={slot.slot}
            />
          ))}
        </div>
      )}

      {others <= 0 && !chosen ? null : (
        <div className="gear-slot-foot">
          {others <= 0 ? null : (
            <button
              aria-expanded={open}
              className="gear-link"
              onClick={() => setOpen(!open)}
              onMouseDown={keepFocus}
              type="button"
            >
              {open
                ? t('cards.gear.hideChoices')
                : others === 1
                  ? t('cards.gear.otherChoices.one')
                  : t('cards.gear.otherChoices.many', { count: others })}
            </button>
          )}
          {chosen ? (
            <button
              className="gear-link"
              onClick={() => onReset(slot.slot)}
              onMouseDown={keepFocus}
              type="button"
            >
              {t('cards.gear.backToSuggestion')}
            </button>
          ) : null}
        </div>
      )}

      {open ? (
        <ul className="gear-options">
          {slot.items.map((item) => {
            const on = suggested.some((each) => each.item === item.item);
            const gain = gainWords(item.gain);
            return (
              <li key={item.item}>
                <button
                  aria-pressed={on}
                  className="gear-option"
                  disabled={item.sold === null}
                  onClick={() => onChoose(slot, item.item)}
                  onMouseDown={keepFocus}
                  type="button"
                >
                  <span className="gear-option-name">
                    {item.name}
                    {item.minLevel === null ? null : (
                      <span className="gear-meta">
                        {t('cards.gear.level', { level: item.minLevel })}
                      </span>
                    )}
                  </span>
                  {gain === '' ? null : <span className="gear-gain">{gain}</span>}
                  <span className="gear-price">
                    {item.sold === null ? '' : priceWords(item.charged)}
                  </span>
                  <span className="gear-meta">{sourceWords(item)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

export default memo(GearSlotTile);
