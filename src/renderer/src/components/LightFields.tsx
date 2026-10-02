import { CheckField } from './FormField';
import { t } from '../lib/i18n';

/** The light switches, as both settings forms hold them. */
export interface LightSwitches {
  provideLight: boolean;
  lightDimRooms: boolean;
  extinguishInLight: boolean;
  buyLight: boolean;
}

export interface LightFieldsProps {
  value: LightSwitches;
  onChange(patch: Partial<LightSwitches>): void;
  /** Put before each field's name, so the two pages' fields keep apart. */
  namePrefix: string;
}

/**
 * The light fieldset's switches, drawn by both settings forms: the three that
 * depend on readying a light are disclosed behind that switch on every page
 * that shows it, one setting, one shape. A fragment, so each switch stays a
 * cell of the fieldset's grid.
 */
export default function LightFields({
  value,
  onChange,
  namePrefix
}: LightFieldsProps): React.JSX.Element {
  return (
    <>
      <CheckField
        checked={value.provideLight}
        hint={t('settings.movement.provideLightHint')}
        label={t('settings.movement.provideLight')}
        name={`${namePrefix}provide-light`}
        onChange={(checked) => onChange({ provideLight: checked })}
      />
      {value.provideLight && (
        <>
          <CheckField
            checked={value.lightDimRooms}
            hint={t('settings.movement.lightDimRoomsHint')}
            label={t('settings.movement.lightDimRooms')}
            name={`${namePrefix}light-dim-rooms`}
            onChange={(checked) => onChange({ lightDimRooms: checked })}
          />
          <CheckField
            checked={value.extinguishInLight}
            hint={t('settings.movement.extinguishInLightHint')}
            label={t('settings.movement.extinguishInLight')}
            name={`${namePrefix}extinguish-in-light`}
            onChange={(checked) => onChange({ extinguishInLight: checked })}
          />
          <CheckField
            checked={value.buyLight}
            hint={t('settings.movement.buyLightHint')}
            label={t('settings.movement.buyLight')}
            name={`${namePrefix}buy-light`}
            onChange={(checked) => onChange({ buyLight: checked })}
          />
        </>
      )}
    </>
  );
}
