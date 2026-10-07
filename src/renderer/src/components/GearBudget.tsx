import { useState, type CSSProperties } from 'react';

import { t } from '../lib/i18n';
import { copperWords, widthOf } from '../lib/gearPicks';

/**
 * The Gear card's budget: what there is (the purse and the banks on record,
 * each a chip), and what to spend, a slider over it with the figure beside
 * it, typed or slid. Never above the cash where the cash is read; null back
 * to the card is all of it.
 */
export interface GearBudgetProps {
  budget: number;
  cash: number | null;
  purse: number | null;
  /** What the banks on record hold; null where no bank has been asked. */
  banked: number | null;
  onChange(value: number | null): void;
}

export default function GearBudget({ budget, cash, purse, banked, onChange }: GearBudgetProps) {
  const [typed, setTyped] = useState<string | null>(null);
  const top = Math.max(cash ?? 0, budget);
  return (
    <section className="gear-budget" aria-label={t('cards.gear.budget')}>
      <div className="gear-budget-top">
        <div className="gear-cash">
          <span className="chip cased">
            {purse === null
              ? t('cards.gear.purseUnread')
              : t('cards.gear.purse', { copper: copperWords(purse) })}
          </span>
          <span className="chip cased">
            {banked === null
              ? t('cards.gear.bankUnread')
              : t('cards.gear.bank', { copper: copperWords(banked) })}
          </span>
        </div>
        <label className="gear-budget-figure">
          <span>{t('cards.gear.budget')}</span>
          <input
            inputMode="numeric"
            onBlur={() => setTyped(null)}
            onChange={(event) => {
              setTyped(event.target.value);
              const value = Number(event.target.value.replace(/[^0-9]/g, ''));
              if (!Number.isFinite(value)) return;
              onChange(cash !== null && value >= cash ? null : value);
            }}
            value={typed ?? budget.toLocaleString()}
          />
        </label>
      </div>
      <input
        aria-label={t('cards.gear.budget')}
        className="gear-slider"
        disabled={top === 0}
        max={top}
        min={0}
        onChange={(event) => {
          setTyped(null);
          const value = Number(event.target.value);
          onChange(cash !== null && value >= cash ? null : value);
        }}
        step={Math.max(1, Math.round(top / 200))}
        style={{ '--fill': widthOf(budget, top) } as CSSProperties}
        type="range"
        value={budget}
      />
      {cash === null ? <p className="gear-reach">{t('cards.gear.cashUnread')}</p> : null}
    </section>
  );
}
