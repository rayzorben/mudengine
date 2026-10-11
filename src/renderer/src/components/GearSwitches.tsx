import { CheckField } from './FormField';
import { t } from '../lib/i18n';

export interface GearSwitchesProps {
  /** `automation.gear.enabled`: the player's own sets. */
  enabled: boolean;
  /** `automation.gear.resists`: the armour the room calls for (todo 69). */
  resists: boolean;
  /** Distinguishes the two forms' controls for the harnesses and for labels. */
  namePrefix: string;
  onEnabled(value: boolean): void;
  onResists(value: boolean): void;
}

/** The two switches over the equipment sets, the same on the character and Global pages. */
export default function GearSwitches({
  enabled,
  resists,
  namePrefix,
  onEnabled,
  onResists
}: GearSwitchesProps) {
  return (
    <div className="settings-inline">
      <CheckField
        checked={enabled}
        hint={t('settings.gear.enabledHint')}
        label={t('settings.gear.enabled')}
        name={`${namePrefix}-enabled`}
        onChange={onEnabled}
      />
      <CheckField
        checked={resists}
        hint={t('settings.gear.resistsHint')}
        label={t('settings.gear.resists')}
        name={`${namePrefix}-resists`}
        onChange={onResists}
      />
    </div>
  );
}
