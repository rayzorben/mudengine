import FormField, { CheckField, NumberField, SelectField, TextField } from './FormField';

import ChoiceFields, { type ChoiceRow } from './ChoiceFields';
import SupplyRows from './SupplyRows';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { GRADE_OPTIONS, joinNames, splitNames } from '../lib/form';
import { DENOMINATIONS } from '@shared/character';
import type { BankChoice } from '@shared/world';
import { areaBounds } from '@shared/config';
import {
  type BankingConfig,
  type EncumbranceGate,
  type LootConfig,
  type SearchConfig
} from '@shared/config';
import {
  outgrownChoices,
  type DropConfig,
  type OutgrownChoices,
  type OutgrownConfig,
  type SuppliesConfig
} from '@shared/packConfig';

/** Outgrown gear's price bands, in copper as the bank's are, and the cash run's detour. */
function outgrownRows(): ReadonlyArray<ChoiceRow<keyof Omit<OutgrownChoices, 'keepRare'>>> {
  return [
    {
      field: 'stashFromCopper',
      name: 'outgrown-stash-from',
      setting: 'automation.outgrown.stashFromCopper',
      label: t('settings.movement.outgrownStashFrom'),
      hint: t('settings.movement.outgrownStashFromHint')
    },
    {
      field: 'sellFromCopper',
      name: 'outgrown-sell-from',
      setting: 'automation.outgrown.sellFromCopper',
      label: t('settings.movement.outgrownSellFrom'),
      hint: t('settings.movement.outgrownSellFromHint')
    },
    {
      field: 'sellDetour',
      name: 'outgrown-sell-detour',
      setting: 'automation.outgrown.sellDetour',
      label: t('settings.movement.outgrownSellDetour'),
      hint: t('settings.movement.outgrownSellDetourHint')
    }
  ];
}

/**
 * What the character picks up, puts back down, gets rid of, searches for, banks
 * and keeps in stock.
 *
 * Six fieldsets and one component, for two reasons that point the same way.
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
/** The blocks these fieldsets edit, as both forms hold them. */
export interface CarryBlocks {
  loot: LootConfig;
  drop: DropConfig;
  outgrown: OutgrownConfig;
  search: SearchConfig;
  banking: BankingConfig;
  supplies: SuppliesConfig;
}

export interface CarrySectionsProps {
  blocks: CarryBlocks;
  /**
   * The bank counters this realm places, for the *which vault* picker — null
   * while the answer has not arrived, and on the Global page, which has no
   * realm to ask (todo 00). Null draws no picker at all: a list of one entry
   * reading *whichever counter* is a control that does nothing.
   */
  banks?: readonly BankChoice[] | null;
  /** Prefix for every control name on these six fieldsets. */
  idPrefix: string;
  /** One block at a time, merged by the caller into whatever it holds them in. */
  onChange(patch: Partial<CarryBlocks>): void;
}

export default function CarrySections({
  blocks,
  banks = null,
  idPrefix,
  onChange
}: CarrySectionsProps): React.JSX.Element {
  const { loot, drop, outgrown, search, banking, supplies } = blocks;
  const id = (suffix: string): string => `${idPrefix}${suffix}`;
  const setLoot = (patch: Partial<LootConfig>): void => onChange({ loot: { ...loot, ...patch } });
  const setDrop = (patch: Partial<DropConfig>): void => onChange({ drop: { ...drop, ...patch } });
  const setOutgrown = (patch: Partial<OutgrownConfig>): void =>
    onChange({ outgrown: { ...outgrown, ...patch } });

  return (
    <>
      <fieldset className="settings-menus">
        <legend>{t('settings.movement.lootLegend')}</legend>
        <CheckField
          checked={loot.coins}
          label={t('settings.movement.lootCoins')}
          name={id('loot-coins')}
          setting="automation.loot.coins"
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
          setting="automation.loot.coinKinds"
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
          setting="automation.loot.discardKinds"
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
          setting="automation.loot.stopAtGrade"
          onChange={(value) => setLoot({ stopAtGrade: value as EncumbranceGate })}
          options={GRADE_OPTIONS()}
          value={loot.stopAtGrade}
        />
        <div className="settings-inline">
          <TextField
            hint={t('settings.movement.lootConvertWithHint')}
            label={t('settings.movement.lootConvertWithLabel')}
            name={id('loot-convert')}
            setting="automation.loot.convertWith"
            onChange={(value) => setLoot({ convertWith: value })}
            value={loot.convertWith}
          />
          <SelectField
            label={t('settings.movement.lootConvertAtLabel')}
            name={id('loot-convert-at')}
            setting="automation.loot.convertAt"
            onChange={(value) => setLoot({ convertAt: value as EncumbranceGate })}
            options={GRADE_OPTIONS()}
            value={loot.convertAt}
          />
        </div>
        <TextField
          hint={t('settings.movement.lootItemsHint')}
          label={t('settings.movement.lootItemsLabel')}
          name={id('loot')}
          setting="automation.loot.items"
          onChange={(value) => setLoot({ items: splitNames(value) })}
          placeholder={t('settings.movement.lootItemsPlaceholder')}
          value={joinNames(loot.items)}
          wide
        />
        {/* Picking up only to a count is a supplies row, below (todo 20261024-1810-01). */}
        <p className="settings-note">{t('settings.movement.lootCollectNote')}</p>
        <div className="settings-inline">
          <NumberField
            hint={t('settings.movement.lootMinPriceHint')}
            label={t('settings.movement.lootMinPriceLabel')}
            name={id('loot-min-price')}
            setting="automation.loot.minPrice"
            onChange={(value) =>
              setLoot({ minPrice: Math.max(0, Number.parseInt(value, 10) || 0) })
            }
            value={String(loot.minPrice)}
          />
          <NumberField
            hint={t('settings.movement.lootMaxEncumbranceHint')}
            label={t('settings.movement.lootMaxEncumbranceLabel')}
            name={id('loot-max-weight')}
            setting="automation.loot.maxEncumbrance"
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
          setting="automation.drop.enabled"
          onChange={(value) => setDrop({ enabled: value })}
        />
        <TextField
          hint={t('settings.movement.dropItemsHint')}
          label={t('settings.movement.dropItemsLabel')}
          name={id('drop')}
          setting="automation.drop.items"
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
          setting="automation.drop.whenEncumbered"
          onChange={(value) => setDrop({ whenEncumbered: value })}
        />
        <CheckField
          checked={drop.worthless}
          hint={t('settings.movement.dropWorthlessHint')}
          label={t('settings.movement.dropWorthlessLabel')}
          name={id('drop-worthless')}
          setting="automation.drop.worthless"
          onChange={(value) => setDrop({ worthless: value })}
        />
        <CheckField
          checked={drop.keepQuestItems}
          hint={t('settings.movement.dropKeepQuestItemsHint')}
          label={t('settings.movement.dropKeepQuestItemsLabel')}
          name={id('drop-keep-quest')}
          setting="automation.drop.keepQuestItems"
          onChange={(value) => setDrop({ keepQuestItems: value })}
        />
      </fieldset>

      {/* Outgrown gear, beside the junk: both are what the pack puts down (todo 12). */}
      <fieldset className="settings-menus">
        <legend>{t('settings.movement.outgrownLegend')}</legend>
        <CheckField
          checked={outgrown.enabled}
          hint={t('settings.movement.outgrownEnabledHint')}
          label={t('settings.movement.outgrownEnabledLabel')}
          name={id('outgrown-enabled')}
          setting="automation.outgrown.enabled"
          onChange={(value) => setOutgrown({ enabled: value })}
        />
        <TextField
          hint={t('settings.movement.outgrownRoomHint')}
          label={t('settings.movement.outgrownRoomLabel')}
          name={id('outgrown-room')}
          setting="automation.outgrown.ganghouseRoom"
          onChange={(value) => setOutgrown({ ganghouseRoom: value })}
          placeholder={t('settings.movement.outgrownRoomPlaceholder')}
          value={outgrown.ganghouseRoom}
          wide
        />
        <CheckField
          checked={outgrown.keepRare}
          hint={t('settings.movement.outgrownKeepRareHint')}
          label={t('settings.movement.outgrownKeepRareLabel')}
          name={id('outgrown-keep-rare')}
          setting="automation.outgrown.keepRare"
          onChange={(value) => setOutgrown({ keepRare: value })}
        />
        <ChoiceFields
          namePrefix={idPrefix}
          onChange={setOutgrown}
          read={outgrownChoices}
          rows={outgrownRows()}
          values={outgrown}
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
          setting="automation.search.enabled"
          onChange={(value) => onChange({ search: { ...search, enabled: value } })}
        />
        <NumberField
          hint={t('settings.movement.searchTriesHint')}
          label={t('settings.movement.searchTriesLabel')}
          name={id('search-tries')}
          setting="automation.search.tries"
          onChange={(value) =>
            onChange({ search: { ...search, tries: Number.parseInt(value, 10) || 1 } })
          }
          value={search.tries}
        />
        {/* Search the area's bounds (todo 118), read through the file's own reader. */}
        <NumberField
          hint={t('settings.movement.areaMaxStepsHint')}
          label={t('settings.movement.areaMaxSteps')}
          name={id('area-max-steps')}
          setting="automation.search.areaMaxSteps"
          onChange={(value) =>
            onChange({ search: { ...search, ...areaBounds({ ...search, areaMaxSteps: value }) } })
          }
          value={search.areaMaxSteps}
        />
        <NumberField
          hint={t('settings.movement.areaMaxSearchesHint')}
          label={t('settings.movement.areaMaxSearches')}
          name={id('area-max-searches')}
          setting="automation.search.areaMaxSearches"
          onChange={(value) =>
            onChange({
              search: { ...search, ...areaBounds({ ...search, areaMaxSearches: value }) }
            })
          }
          value={search.areaMaxSearches}
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
            setting="automation.banking.autoDeposit"
            onChange={(value) => onChange({ banking: { ...banking, autoDeposit: value } })}
          />
          <NumberField
            hint={t('settings.movement.bankThresholdHint')}
            label={t('settings.movement.bankThresholdLabel')}
            name={id('bank-threshold')}
            setting="automation.banking.depositThresholdCopper"
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
            setting="automation.banking.keepCopper"
            onChange={(value) =>
              onChange({
                banking: { ...banking, keepCopper: Math.max(0, Number.parseInt(value, 10) || 0) }
              })
            }
            value={String(banking.keepCopper)}
          />
        </div>
        {/*
          Which vault, when the realm places more than one (todo 00). A
          balance is per counter and the realm states each separately, so a
          character that deposits at whichever bank it walks past ends up with
          four figures nobody can add up.

          Only where a realm has answered: the Global page is every realm at
          once, and a row id means nothing across two of them.
        */}
        {banking.autoDeposit && banks !== null && banks.length > 0 && (
          <>
            <SelectField
              hint={t('settings.movement.bankWhichHint')}
              label={t('settings.movement.bankWhichLabel')}
              name={id('bank-which')}
              setting="automation.banking.bank"
              onChange={(value) =>
                onChange({ banking: { ...banking, bank: Number.parseInt(value, 10) || 0 } })
              }
              options={[
                { value: '0', label: t('settings.movement.bankWhichAny') },
                ...banks.map((entry) => ({
                  value: String(entry.shop),
                  label: t('settings.movement.bankWhichOption', {
                    name: entry.name,
                    room: entry.roomName
                  })
                }))
              ]}
              value={String(banking.bank)}
            />
            {/*
              A stated counter this realm does not place banks nowhere and
              says so, rather than quietly banking at the nearest one — which
              would be the client choosing the vault the setting exists to let
              the player choose.
            */}
            {banking.bank > 0 && !banks.some((entry) => entry.shop === banking.bank) && (
              <p className="settings-warn">{t('settings.movement.bankWhichStale')}</p>
            )}
          </>
        )}
      </fieldset>

      <SupplyRows
        idPrefix={idPrefix}
        onChange={(next) => onChange({ supplies: next })}
        supplies={supplies}
      />
    </>
  );
}
