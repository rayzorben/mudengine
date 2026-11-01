import { useState, type CSSProperties } from 'react';

import { t } from '../lib/i18n';
import { copperWords } from '../lib/gearPicks';
import { widthOf } from '../lib/widths';

/**
 * The Gear card's budget: what to spend, the figure typed in place beside a
 * slider over the cash, and on a large card what there is (the purse and the
 * banks on record, each a chip; the slider's tooltip on a smaller one).
 * Never above the cash where the cash is read; null back to the card is all
 * of it.
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
  // What there is, as chips on a large card and the slider's tooltip on any.
  const held = [
    purse === null
      ? t('cards.gear.purseUnread')
      : t('cards.gear.purse', { copper: copperWords(purse) }),
    banked === null
      ? t('cards.gear.bankUnread')
      : t('cards.gear.bank', { copper: copperWords(banked) })
  ];
  return (
    <section className="gear-budget from-medium" aria-label={t('cards.gear.budget')}>
      <div className="gear-budget-top">
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
          title={held.join(' · ')}
          step={Math.max(1, Math.round(top / 200))}
          style={{ '--fill': widthOf(budget, top) } as CSSProperties}
          type="range"
          value={budget}
        />
      </div>
      <div className="gear-cash from-large">
        {held.map((words) => (
          <span className="chip cased" key={words}>
            {words}
          </span>
        ))}
      </div>
      {cash === null ? <p className="gear-reach">{t('cards.gear.cashUnread')}</p> : null}
    </section>
  );
}
