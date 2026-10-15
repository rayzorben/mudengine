import { CheckField, NumberField } from './FormField';
import { t } from '../lib/i18n';

export interface GearSwitchesProps {
  /** `automation.gear.enabled`: the player's own sets. */
  enabled: boolean;
  /** `automation.gear.resists`: the armour the room calls for (todo 69). */
  resists: boolean;
  /** `automation.gear.resistMinSaved`, as the page holds it (todo 118). */
  minSaved: number | string;
  /** Distinguishes the two forms' controls for the harnesses and for labels. */
  namePrefix: string;
  onEnabled(value: boolean): void;
  onResists(value: boolean): void;
  onMinSaved(typed: string): void;
}

/**
 * The two switches over the equipment sets, and the damage a resist swap must
 * save beside its switch, the same on the character and Global pages.
 */
export default function GearSwitches({
  enabled,
  resists,
  minSaved,
  namePrefix,
  onEnabled,
  onResists,
  onMinSaved
}: GearSwitchesProps) {
  return (
    <div className="settings-inline">
      <CheckField
        checked={enabled}
        hint={t('settings.gear.enabledHint')}
        label={t('settings.gear.enabled')}
        name={`${namePrefix}-enabled`}
        setting="automation.gear.enabled"
        onChange={onEnabled}
      />
      <CheckField
        checked={resists}
        hint={t('settings.gear.resistsHint')}
        label={t('settings.gear.resists')}
        name={`${namePrefix}-resists`}
        setting="automation.gear.resists"
        onChange={onResists}
      />
      {resists && (
        <NumberField
          hint={t('settings.gear.resistMinSavedHint')}
          label={t('settings.gear.resistMinSavedLabel')}
          name={`${namePrefix}-resist-min-saved`}
          setting="automation.gear.resistMinSaved"
          onChange={onMinSaved}
          value={String(minSaved)}
        />
      )}
    </div>
  );
}
