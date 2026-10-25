import ChoiceFields, { type ChoiceRow } from './ChoiceFields';
import Icon from './Icon';
import { CheckField } from './FormField';
import { wholeOf } from '../lib/form';
import { t } from '../lib/i18n';
import {
  BOUGHT_ROW,
  SUPPLY_COUNT_MAX,
  supplyChoices,
  type SuppliesConfig,
  type SupplyChoices,
  type SupplyItem
} from '@shared/packConfig';

export interface SupplyRowsProps {
  supplies: SuppliesConfig;
  /** Prefix for every control name, as `CarrySections` hands it. */
  idPrefix: string;
  onChange(supplies: SuppliesConfig): void;
}

/** A typed count, bounded as `normalizeSupplies` bounds it. */
function count(typed: string): number {
  return Math.min(SUPPLY_COUNT_MAX, wholeOf(typed));
}

/** The copper drawn over a shortfall, and what a dearer counter is worth in steps (todo 118). */
function rows(): ReadonlyArray<ChoiceRow<keyof SupplyChoices>> {
  return [
    {
      field: 'cashBuffer',
      name: 'supplies-cash-buffer',
      setting: 'automation.supplies.cashBuffer',
      label: t('settings.movement.suppliesCashBuffer'),
      hint: t('settings.movement.suppliesCashBufferHint')
    },
    {
      field: 'dearerSteps',
      name: 'supplies-dearer-steps',
      setting: 'automation.supplies.dearerSteps',
      label: t('settings.movement.suppliesDearerSteps'),
      hint: t('settings.movement.suppliesDearerStepsHint')
    }
  ];
}

/**
 * Auto-Buy Supplies and the list it keeps, on the settings page (todo 118).
 *
 * The Self card's Supplies face and the item panel edit the same list with the
 * realm's shops beside each row; this is the list where a player looks for a
 * setting, in `PotionList`'s row idiom. A row's shop is shown as the file
 * states it and chosen on the item panel, where the realm's counters are.
 */
export default function SupplyRows({ supplies, idPrefix, onChange }: SupplyRowsProps) {
  const { items } = supplies;
  const setItems = (next: SupplyItem[]): void => onChange({ ...supplies, items: next });
  const update = (index: number, change: Partial<SupplyItem>): void =>
    setItems(items.map((row, at) => (at === index ? { ...row, ...change } : row)));

  return (
    <fieldset className="settings-menus">
      <legend>{t('settings.movement.suppliesLegend')}</legend>
      <CheckField
        checked={supplies.enabled}
        hint={t('settings.movement.suppliesEnabledHint')}
        label={t('toolbar.supplies')}
        name={`${idPrefix}supplies-enabled`}
        setting="automation.supplies.enabled"
        onChange={(enabled) => onChange({ ...supplies, enabled })}
      />
      <ChoiceFields
        namePrefix={idPrefix}
        onChange={(next) => onChange({ ...supplies, ...next })}
        read={supplyChoices}
        rows={rows()}
        values={supplies}
      />
      {items.length > 0 && (
        <ul className="settings-steps settings-potions" data-setting="automation.supplies.items">
          {items.map((row, index) => (
            <li key={index}>
              <div className="blessing-line">
                <input
                  aria-label={t('settings.movement.suppliesNameAria', { number: index + 1 })}
                  name={`${idPrefix}supplies-${index}-name`}
                  onChange={(event) => update(index, { name: event.target.value })}
                  placeholder={t('settings.movement.suppliesNamePlaceholder')}
                  value={row.name}
                />
                {/* A row collected only where it is found has no minimum (todo 20261024-1810-01). */}
                {row.buy && (
                  <label>
                    <span>{t('cards.self.supplies.min')}</span>
                    <input
                      aria-label={t('settings.movement.suppliesMinAria', { number: index + 1 })}
                      className="number"
                      inputMode="numeric"
                      name={`${idPrefix}supplies-${index}-min`}
                      onChange={(event) => update(index, { min: count(event.target.value) })}
                      value={row.min}
                    />
                  </label>
                )}
                <label>
                  <span>{t('cards.self.supplies.max')}</span>
                  <input
                    aria-label={t('settings.movement.suppliesMaxAria', { number: index + 1 })}
                    className="number"
                    inputMode="numeric"
                    name={`${idPrefix}supplies-${index}-max`}
                    onChange={(event) => update(index, { max: count(event.target.value) })}
                    value={row.max}
                  />
                </label>
                <label title={t('cards.self.supplies.buyTooltip')}>
                  <input
                    checked={row.buy}
                    name={`${idPrefix}supplies-${index}-buy`}
                    onChange={(event) => update(index, { buy: event.target.checked })}
                    type="checkbox"
                  />
                  <span>{t('cards.self.supplies.buy')}</span>
                </label>
                <label title={t('cards.self.supplies.doneOnFoundTooltip')}>
                  <input
                    checked={row.doneOnFound}
                    name={`${idPrefix}supplies-${index}-done`}
                    onChange={(event) => update(index, { doneOnFound: event.target.checked })}
                    type="checkbox"
                  />
                  <span>{t('cards.self.supplies.doneOnFound')}</span>
                </label>
                <span>
                  {!row.buy
                    ? t('cards.self.supplies.collectOnly')
                    : row.shop.length > 0
                      ? row.shop
                      : t('cards.self.supplies.noShop')}
                </span>
                <button
                  aria-label={t('cards.self.supplies.removeTooltip', { item: row.name })}
                  className="quiet"
                  onClick={() => setItems(items.filter((_, at) => at !== index))}
                  title={t('cards.self.supplies.removeTooltip', { item: row.name })}
                  type="button"
                >
                  <Icon name="close" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <button
        className="quiet add-step"
        onClick={() =>
          setItems([...items, { name: '', min: 1, max: 1, shop: '', at: null, ...BOUGHT_ROW }])
        }
        type="button"
      >
        <Icon name="plus" />
        {t('settings.movement.suppliesAdd')}
      </button>
    </fieldset>
  );
}
