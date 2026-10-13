import { NumberField, TextField } from './FormField';

import { t } from '../lib/i18n';

export interface OffRoundFieldsProps {
  item: string;
  /** Every how many rounds, as the field holds it. */
  every: string;
  /** Prefix for every control name, as each page spells it (`gear`, `global-gear`). */
  namePrefix: string;
  onItem(item: string): void;
  onEvery(every: string): void;
}

/**
 * The off-round invocation (`automation.gear.offRound`): its own fieldset in
 * the Gear section of both pages, since it is another verb (`use`) and the
 * only gear control that spends a round.
 */
export default function OffRoundFields({
  item,
  every,
  namePrefix,
  onItem,
  onEvery
}: OffRoundFieldsProps): React.JSX.Element {
  return (
    <fieldset className="settings-menus" data-fieldset="gear-offround">
      <legend>{t('settings.gear.offRoundLegend')}</legend>
      <p className="settings-note">{t('settings.gear.offRoundNote')}</p>
      <div className="settings-inline">
        <TextField
          hint={t('settings.gear.offRoundItemHint')}
          label={t('settings.gear.offRoundItem')}
          name={`${namePrefix}-offround-item`}
          onChange={onItem}
          value={item}
        />
        <NumberField
          hint={t('settings.gear.offRoundEveryHint')}
          label={t('settings.gear.offRoundEvery')}
          name={`${namePrefix}-offround-every`}
          onChange={onEvery}
          value={every}
        />
      </div>
    </fieldset>
  );
}
