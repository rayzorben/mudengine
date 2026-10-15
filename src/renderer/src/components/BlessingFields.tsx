/**
 * The blessings, one set of fields for the character form and the options
 * page: the *Auto-Bless* switch, *Auto Choose Blessings* beside it (todo 10),
 * the list, and telling a caster when their bless ends. Each value is as the
 * page holds it; the page turns a change back into its own draft. With *Auto
 * Choose Blessings* on, the list's self rows are candidates the choice may
 * drop, and its party rows are cast as they are; the least gain, the heals
 * kept back and the swap budget it chooses by are drawn beside it (todo 118),
 * the gain a percent as the page holds it.
 */
import BlessingList from './BlessingList';
import { CheckField, NumberField } from './FormField';
import { t } from '../lib/i18n';
import type { BlessingDraft } from '@shared/drafts';
import type { SpellOption } from '@shared/ipc';
import type { SettingPath } from '@shared/decisionSettings';

export type BlessingSwitch = 'autoBless' | 'autoChooseBlessings' | 'notifyPartyOnWearOff';
/** What Auto Choose Blessings weighs by: a share (the gain) and two counts. */
export type BlessingWeight = 'blessMinGain' | 'blessHealReserve' | 'blessSwapCommandsPerHour';

export interface BlessingFieldsProps {
  values: Readonly<
    Record<BlessingSwitch, boolean> &
      Record<BlessingWeight, number | string> & { blessings: readonly BlessingDraft[] }
  >;
  onToggle(field: BlessingSwitch, value: boolean): void;
  onChange(field: BlessingWeight, typed: string): void;
  onBlessings(blessings: BlessingDraft[]): void;
  /** The spells the list offers: the character's book, or the realm's. */
  spells: readonly SpellOption[];
  /** Prefixed to each field's name, so the two pages' fields stay apart. */
  namePrefix: string;
}

export default function BlessingFields({
  values,
  onToggle,
  onChange,
  onBlessings,
  spells,
  namePrefix
}: BlessingFieldsProps): React.JSX.Element {
  const weight = ({
    field,
    name,
    label,
    hint,
    setting
  }: {
    field: BlessingWeight;
    name: string;
    label: string;
    hint: string;
    setting: SettingPath;
  }) => (
    <NumberField
      hint={hint}
      label={label}
      name={`${namePrefix}${name}`}
      setting={setting}
      onChange={(typed) => onChange(field, typed)}
      value={String(values[field])}
    />
  );
  return (
    <>
      <div className="settings-inline">
        <CheckField
          checked={values.autoBless}
          hint={t('settings.spells.autoBlessHint')}
          label={t('settings.spells.autoBlessLabel')}
          name={`${namePrefix}auto-bless`}
          setting="automation.spells.autoBless"
          onChange={(value) => onToggle('autoBless', value)}
        />
        <CheckField
          checked={values.autoChooseBlessings}
          hint={t('settings.spells.autoChooseBlessingsHint')}
          label={t('settings.spells.autoChooseBlessingsLabel')}
          name={`${namePrefix}auto-choose-blessings`}
          setting="automation.spells.autoChooseBlessings"
          onChange={(value) => onToggle('autoChooseBlessings', value)}
        />
      </div>
      {values.autoChooseBlessings && (
        <div className="settings-inline">
          {weight({
            field: 'blessMinGain',
            name: 'bless-min-gain',
            label: t('settings.spells.blessMinGainLabel'),
            hint: t('settings.spells.blessMinGainHint'),
            setting: 'automation.spells.blessMinGain'
          })}
          {weight({
            field: 'blessHealReserve',
            name: 'bless-heal-reserve',
            label: t('settings.spells.blessHealReserveLabel'),
            hint: t('settings.spells.blessHealReserveHint'),
            setting: 'automation.spells.blessHealReserve'
          })}
          {weight({
            field: 'blessSwapCommandsPerHour',
            name: 'bless-swap-commands',
            label: t('settings.spells.blessSwapCommandsLabel'),
            hint: t('settings.spells.blessSwapCommandsHint'),
            setting: 'automation.spells.blessSwapCommandsPerHour'
          })}
        </div>
      )}
      <BlessingList
        setting="automation.spells.blessings"
        blessings={values.blessings}
        namePrefix={`${namePrefix}blessing`}
        onChange={onBlessings}
        spells={spells}
      />
      <CheckField
        checked={values.notifyPartyOnWearOff}
        hint={t('settings.spells.notifyWearOffHint')}
        label={t('settings.spells.notifyWearOffLabel')}
        name={`${namePrefix}notify-wear-off`}
        setting="automation.spells.notifyPartyOnWearOff"
        onChange={(value) => onToggle('notifyPartyOnWearOff', value)}
      />
    </>
  );
}
