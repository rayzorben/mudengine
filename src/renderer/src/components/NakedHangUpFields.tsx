/**
 * Hang Up Naked After a Death and the margin it keeps above a stated charge
 * (todo 118), drawn in the Auto-Hangup fieldset by both settings forms. Outside
 * the Auto-Hangup switch, because that switch does not govern it.
 */
import { CheckField, NumberField } from './FormField';
import { t } from '../lib/i18n';

export interface NakedHangUpFieldsProps {
  whenNaked: boolean;
  /** The margin as a percentage, as typed. */
  margin: string;
  onWhenNaked(value: boolean): void;
  onMargin(typed: string): void;
  namePrefix?: string;
}

export default function NakedHangUpFields({
  whenNaked,
  margin,
  onWhenNaked,
  onMargin,
  namePrefix = ''
}: NakedHangUpFieldsProps): React.JSX.Element {
  return (
    <div className="settings-inline">
      <CheckField
        checked={whenNaked}
        hint={t('settings.health.hangUpNakedHint')}
        label={t('settings.health.hangUpNakedLabel')}
        name={`${namePrefix}hangup-naked`}
        setting="automation.safety.hangUp.whenNaked"
        onChange={onWhenNaked}
      />
      {whenNaked && (
        <NumberField
          hint={t('settings.health.hangUpNakedMarginHint')}
          label={t('settings.health.hangUpNakedMarginLabel')}
          name={`${namePrefix}hangup-naked-margin`}
          setting="automation.safety.hangUp.nakedMargin"
          onChange={onMargin}
          value={margin}
        />
      )}
    </div>
  );
}
