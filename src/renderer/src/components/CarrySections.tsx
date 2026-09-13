import FormField, { CheckField, NumberField, SelectField, TextField } from './FormField';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { GRADE_OPTIONS, joinNames, splitNames } from '../lib/form';
import { DENOMINATIONS } from '@shared/character';
import type {
  BankingConfig,
  DropConfig,
  EncumbranceGate,
  LootConfig,
  SearchConfig
} from '@shared/config';

/**
 * What the character picks up, puts back down, searches for and banks.
 *
 * Four fieldsets and one component, for two reasons that point the same way.
 *
 * **They are one subject.** Every one of them is a decision about the pack and
 * the purse — bend down for this, shed that, look for what the room did not
 * print, put the rest in the bank — and the Movement section is where they
 * belong because what they cost is *commands out of the budget the walking is
 * done from*.
 *
 * **And they are edited from two pages.** The Global page has had them since
 * they were built; the character page had none of them (todo 03, 2026-09-12,
 * reported as *"i do not see auto collect or discard cash on the players ui"*)
 * even though `resolveProfile` has always overlaid whatever `automation:` a
 * profile states, so a character could hold its own answers and nothing could
 * write them. Porting the markup would have been two copies of two hundred
 * lines, and the settled rule is that one setting has one wording on every
 * page: a second copy is a second place for the words to drift.
 *
 * The caller supplies the id prefix, because the two forms spell their control
 * names differently (`global-loot-coins` against `loot-coins`) and a `name` is
 * what `aria-describedby` is built from.
 */
export interface CarrySectionsProps {
  loot: LootConfig;
  drop: DropConfig;
  search: SearchConfig;
  banking: BankingConfig;
  /** Prefix for every control name on these four fieldsets. */
  idPrefix: string;
  /** One block at a time, merged by the caller into whatever it holds them in. */
  onChange(patch: {
    loot?: LootConfig;
    drop?: DropConfig;
    search?: SearchConfig;
    banking?: BankingConfig;
  }): void;
}

export default function CarrySections({
  loot,
  drop,
  search,
  banking,
  idPrefix,
  onChange
}: CarrySectionsProps): React.JSX.Element {
  const id = (suffix: string): string => `${idPrefix}${suffix}`;
  const setLoot = (patch: Partial<LootConfig>): void => onChange({ loot: { ...loot, ...patch } });
  const setDrop = (patch: Partial<DropConfig>): void => onChange({ drop: { ...drop, ...patch } });

  return (
    <>
      <fieldset className="settings-menus">
        <legend>{t('settings.movement.lootLegend')}</legend>
        <CheckField
          checked={loot.coins}
          label={t('settings.movement.lootCoins')}
          name={id('loot-coins')}
          onChange={(value) => setLoot({ coins: value })}
        />
        {/*
          Which coins, as a row of chips rather than five checkboxes: the
          question is "which of these five", and five boxes down a column
          reads as five unrelated settings.

          Two rows, and the pair is the setting. Turning a coin on in one
          row takes it out of the other, because a coin on both would be
          picked up and dropped for ever — the rule `normalizeLoot` keeps
          on disk, made unreachable here rather than reported after the
          fact. A coin on neither row is *kept*, which is the answer the
          pair exists to express and the reason this is not one tri-state
          chip: "collect", "shed" and "leave alone" are three decisions
          about the same coin, and a control that cycled them would make
          the shipped answer a click away from throwing money out.
        */}
        <FormField
          hint={t('settings.movement.lootCoinKindsHint')}
          label={t('settings.movement.lootCoinKindsLabel')}
          name={id('loot-coin-kinds')}
          wide
        >
          {() => (
            <div className="chip-row">
              {DENOMINATIONS.map((coin) => {
                const on = loot.coinKinds.includes(coin);
                return (
                  <button
                    aria-pressed={on}
                    className="chip pick"
                    key={coin}
                    onClick={() =>
                      setLoot({
                        coinKinds: on
                          ? loot.coinKinds.filter((k) => k !== coin)
                          : DENOMINATIONS.filter((k) => k === coin || loot.coinKinds.includes(k)),
                        // Off the other row, if it was on it.
                        discardKinds: on
                          ? loot.discardKinds
                          : loot.discardKinds.filter((k) => k !== coin)
                      })
                    }
                    onMouseDown={keepFocus}
                    type="button"
                  >
                    {coin}
                  </button>
                );
              })}
            </div>
          )}
        </FormField>
        <FormField
          hint={t('settings.movement.lootDiscardKindsHint')}
          label={t('settings.movement.lootDiscardKindsLabel')}
          name={id('loot-discard-kinds')}
          wide
        >
          {() => (
            <div className="chip-row">
              {DENOMINATIONS.map((coin) => {
                const on = loot.discardKinds.includes(coin);
                return (
                  <button
                    aria-pressed={on}
                    className="chip pick"
                    key={coin}
                    onClick={() =>
                      setLoot({
                        discardKinds: on
                          ? loot.discardKinds.filter((k) => k !== coin)
                          : DENOMINATIONS.filter(
                              (k) => k === coin || loot.discardKinds.includes(k)
                            ),
                        coinKinds: on ? loot.coinKinds : loot.coinKinds.filter((k) => k !== coin)
                      })
                    }
                    onMouseDown={keepFocus}
                    type="button"
                  >
                    {coin}
                  </button>
                );
              })}
            </div>
          )}
        </FormField>
        <SelectField
          hint={t('settings.movement.lootStopAtGradeHint')}
          label={t('settings.movement.lootStopAtGradeLabel')}
          name={id('loot-stop-grade')}
          onChange={(value) => setLoot({ stopAtGrade: value as EncumbranceGate })}
          options={GRADE_OPTIONS()}
          value={loot.stopAtGrade}
        />
        <div className="settings-inline">
          <TextField
            hint={t('settings.movement.lootConvertWithHint')}
            label={t('settings.movement.lootConvertWithLabel')}
            name={id('loot-convert')}
            onChange={(value) => setLoot({ convertWith: value })}
            value={loot.convertWith}
          />
          <SelectField
            label={t('settings.movement.lootConvertAtLabel')}
            name={id('loot-convert-at')}
            onChange={(value) => setLoot({ convertAt: value as EncumbranceGate })}
            options={GRADE_OPTIONS()}
            value={loot.convertAt}
          />
        </div>
        <TextField
          hint={t('settings.movement.lootItemsHint')}
          label={t('settings.movement.lootItemsLabel')}
          name={id('loot')}
          onChange={(value) => setLoot({ items: splitNames(value) })}
          placeholder={t('settings.movement.lootItemsPlaceholder')}
          value={joinNames(loot.items)}
          wide
        />
        <div className="settings-inline">
          <NumberField
            hint={t('settings.movement.lootMinPriceHint')}
            label={t('settings.movement.lootMinPriceLabel')}
            name={id('loot-min-price')}
            onChange={(value) =>
              setLoot({ minPrice: Math.max(0, Number.parseInt(value, 10) || 0) })
            }
            value={String(loot.minPrice)}
          />
          <NumberField
            hint={t('settings.movement.lootMaxEncumbranceHint')}
            label={t('settings.movement.lootMaxEncumbranceLabel')}
            name={id('loot-max-weight')}
            onChange={(value) =>
              setLoot({ maxEncumbrance: Math.max(0, Number.parseInt(value, 10) || 0) })
            }
            value={String(loot.maxEncumbrance)}
          />
        </div>
      </fieldset>

      <fieldset className="settings-menus">
        <legend>{t('settings.movement.dropLegend')}</legend>
        <CheckField
          checked={drop.enabled}
          hint={t('settings.movement.dropEnabledHint')}
          label={t('settings.movement.dropEnabledLabel')}
          name={id('drop-enabled')}
          onChange={(value) => setDrop({ enabled: value })}
        />
        <TextField
          hint={t('settings.movement.dropItemsHint')}
          label={t('settings.movement.dropItemsLabel')}
          name={id('drop')}
          onChange={(value) => setDrop({ items: splitNames(value) })}
          placeholder={t('settings.movement.dropItemsPlaceholder')}
          value={joinNames(drop.items)}
          wide
        />
        <CheckField
          checked={drop.whenEncumbered}
          hint={t('settings.movement.dropWhenEncumberedHint')}
          label={t('settings.movement.dropWhenEncumberedLabel')}
          name={id('drop-encumbered')}
          onChange={(value) => setDrop({ whenEncumbered: value })}
        />
        <CheckField
          checked={drop.worthless}
          hint={t('settings.movement.dropWorthlessHint')}
          label={t('settings.movement.dropWorthlessLabel')}
          name={id('drop-worthless')}
          onChange={(value) => setDrop({ worthless: value })}
        />
      </fieldset>

      {/*
        Searching every room, which is a *movement* setting rather than a
        combat one: what it finds is a way through, and the section it sits
        in is the one that already holds opening, picking and bashing the
        other kinds of blocked exit.
      */}
      <fieldset className="settings-menus">
        <legend>{t('settings.movement.searchLegend')}</legend>
        <CheckField
          checked={search.enabled}
          hint={t('settings.movement.searchEnabledHint')}
          label={t('settings.movement.searchEnabledLabel')}
          name={id('search-enabled')}
          onChange={(value) => onChange({ search: { ...search, enabled: value } })}
        />
        <NumberField
          hint={t('settings.movement.searchTriesHint')}
          label={t('settings.movement.searchTriesLabel')}
          name={id('search-tries')}
          onChange={(value) =>
            onChange({ search: { ...search, tries: Number.parseInt(value, 10) || 1 } })
          }
          value={search.tries}
        />
      </fieldset>

      <fieldset className="settings-menus">
        <legend>{t('settings.movement.bankLegend')}</legend>
        {/*
          The switch and the two figures it spends are one row: a threshold
          and a float mean nothing without the switch that acts on them, and
          a check alone on a band wastes a row saying so.
        */}
        <div className="settings-inline">
          <CheckField
            checked={banking.autoDeposit}
            hint={t('settings.movement.bankDepositHint')}
            label={t('settings.movement.bankDepositLabel')}
            name={id('bank-deposit')}
            onChange={(value) => onChange({ banking: { ...banking, autoDeposit: value } })}
          />
          <NumberField
            hint={t('settings.movement.bankThresholdHint')}
            label={t('settings.movement.bankThresholdLabel')}
            name={id('bank-threshold')}
            onChange={(value) =>
              onChange({
                banking: {
                  ...banking,
                  depositThresholdCopper: Math.max(0, Number.parseInt(value, 10) || 0)
                }
              })
            }
            value={String(banking.depositThresholdCopper)}
          />
          <NumberField
            hint={t('settings.movement.bankKeepHint')}
            label={t('settings.movement.bankKeepLabel')}
            name={id('bank-keep')}
            onChange={(value) =>
              onChange({
                banking: { ...banking, keepCopper: Math.max(0, Number.parseInt(value, 10) || 0) }
              })
            }
            value={String(banking.keepCopper)}
          />
        </div>
      </fieldset>
    </>
  );
}
