import { CheckField, NumberField } from './FormField';
import { t } from '../lib/i18n';

/** What the character does about its gear after a death, as the form holds it. */
export interface RecoverSwitches {
  recoverGear: boolean;
  recoverGearFloor: string;
  recoverGearTries: string;
  reequipOnRecover: boolean;
}

export interface RecoverFieldsProps {
  value: RecoverSwitches;
  onChange(patch: Partial<RecoverSwitches>): void;
}

/**
 * The gear after a death: the walk back for it, its two bounds, and putting it
 * on after `recover corpse`. A fragment, so each field stays a cell of the
 * fieldset's grid.
 */
export default function RecoverFields({ value, onChange }: RecoverFieldsProps): React.JSX.Element {
  return (
    <>
      <CheckField
        checked={value.recoverGear}
        hint={t('settings.movement.recoverGearHint')}
        label={t('settings.movement.recoverGear')}
        name="recover-gear"
        onChange={(checked) => onChange({ recoverGear: checked })}
      />
      {/*
        The bounds, drawn only where the switch is on: two numbers limiting a
        feature nobody has turned on are two controls that do nothing (todo 21).
      */}
      {value.recoverGear && (
        <div className="settings-inline">
          <NumberField
            hint={t('settings.movement.recoverGearFloorHint')}
            label={t('settings.movement.recoverGearFloorLabel')}
            name="recover-gear-floor"
            onChange={(floor) => onChange({ recoverGearFloor: floor })}
            value={value.recoverGearFloor}
          />
          <NumberField
            hint={t('settings.movement.recoverGearTriesHint')}
            label={t('settings.movement.recoverGearTriesLabel')}
            name="recover-gear-tries"
            onChange={(tries) => onChange({ recoverGearTries: tries })}
            value={value.recoverGearTries}
          />
        </div>
      )}
      <CheckField
        checked={value.reequipOnRecover}
        hint={t('settings.movement.reequipOnRecoverHint')}
        label={t('settings.movement.reequipOnRecover')}
        name="reequip-on-recover"
        onChange={(checked) => onChange({ reequipOnRecover: checked })}
      />
    </>
  );
}
