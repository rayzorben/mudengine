/**
 * The blessings, one set of fields for the character form and the options
 * page: the *Auto-Bless* switch, *Auto Choose Blessings* beside it (todo 10),
 * the list, and telling a caster when their bless ends. Each value is as the
 * page holds it; the page turns a change back into its own draft. With *Auto
 * Choose Blessings* on, the list's self rows are candidates the choice may
 * drop, and its party rows are cast as they are.
 */
import BlessingList from './BlessingList';
import { CheckField } from './FormField';
import { t } from '../lib/i18n';
import type { BlessingDraft } from '@shared/drafts';
import type { SpellOption } from '@shared/ipc';

export type BlessingSwitch = 'autoBless' | 'autoChooseBlessings' | 'notifyPartyOnWearOff';

export interface BlessingFieldsProps {
  values: Readonly<Record<BlessingSwitch, boolean> & { blessings: readonly BlessingDraft[] }>;
  onToggle(field: BlessingSwitch, value: boolean): void;
  onBlessings(blessings: BlessingDraft[]): void;
  /** The spells the list offers: the character's book, or the realm's. */
  spells: readonly SpellOption[];
  /** Prefixed to each field's name, so the two pages' fields stay apart. */
  namePrefix: string;
}

export default function BlessingFields({
  values,
  onToggle,
  onBlessings,
  spells,
  namePrefix
}: BlessingFieldsProps): React.JSX.Element {
  return (
    <>
      <div className="settings-inline">
        <CheckField
          checked={values.autoBless}
          hint={t('settings.spells.autoBlessHint')}
          label={t('settings.spells.autoBlessLabel')}
          name={`${namePrefix}auto-bless`}
          onChange={(value) => onToggle('autoBless', value)}
        />
        <CheckField
          checked={values.autoChooseBlessings}
          hint={t('settings.spells.autoChooseBlessingsHint')}
          label={t('settings.spells.autoChooseBlessingsLabel')}
          name={`${namePrefix}auto-choose-blessings`}
          onChange={(value) => onToggle('autoChooseBlessings', value)}
        />
      </div>
      <BlessingList
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
        onChange={(value) => onToggle('notifyPartyOnWearOff', value)}
      />
    </>
  );
}
