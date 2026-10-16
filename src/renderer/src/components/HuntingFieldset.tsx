/**
 * Going hunting on its own, one fieldset for the character form and the
 * options page (todos 64, 118): the switch, how far to look, the copper an
 * hour the hunt should earn, and the hunt's own figures (`HuntChoices`) for
 * when a spot is worth the move and which rooms the survey leaves out. Each
 * figure of the first three is the text the page holds; the page turns a
 * change back into its own draft.
 */
import ChoiceFields, { type ChoiceRow } from './ChoiceFields';
import { CheckField, NumberField } from './FormField';
import { t } from '../lib/i18n';
import { huntChoices, type HuntChoices } from '@shared/huntChoices';

export interface HuntingFieldsetProps {
  enabled: boolean;
  /** How far to look, as text; '' is everywhere the exits reach. */
  radius: string;
  /** Copper an hour, as text; '' is exp alone. */
  cash: string;
  onChange(change: { enabled?: boolean; radius?: string; cash?: string }): void;
  choices: HuntChoices;
  onChoices(choices: HuntChoices): void;
  /** Prefixed to each field's name, so the two pages' fields stay apart. */
  namePrefix: string;
}

function rows(): ReadonlyArray<ChoiceRow<keyof HuntChoices>> {
  return [
    {
      field: 'moveMargin',
      name: 'hunt-move-margin',
      setting: 'automation.hunting.moveMargin',
      label: t('settings.hunting.moveMargin'),
      hint: t('settings.hunting.moveMarginHint'),
      share: true
    },
    {
      field: 'cashExpShare',
      name: 'hunt-cash-exp',
      setting: 'automation.hunting.cashExpShare',
      label: t('settings.hunting.cashExpShare'),
      hint: t('settings.hunting.cashExpShareHint'),
      share: true
    },
    {
      field: 'betterSpotRadius',
      name: 'hunt-better-radius',
      setting: 'automation.hunting.betterSpotRadius',
      label: t('settings.hunting.betterSpotRadius'),
      hint: t('settings.hunting.betterSpotRadiusHint')
    },
    {
      field: 'maxDamageShare',
      name: 'hunt-max-damage',
      setting: 'automation.hunting.maxDamageShare',
      label: t('settings.hunting.maxDamageShare'),
      hint: t('settings.hunting.maxDamageShareHint'),
      share: true
    },
    {
      field: 'trivialLevelMargin',
      name: 'hunt-trivial-margin',
      setting: 'automation.hunting.trivialLevelMargin',
      label: t('settings.hunting.trivialLevelMargin'),
      hint: t('settings.hunting.trivialLevelMarginHint'),
      share: true
    }
  ];
}

export default function HuntingFieldset({
  enabled,
  radius,
  cash,
  onChange,
  choices,
  onChoices,
  namePrefix
}: HuntingFieldsetProps): React.JSX.Element {
  return (
    <fieldset className="settings-menus" data-fieldset="hunting">
      <legend>{t('settings.hunting.legend')}</legend>
      <p className="settings-note">{t('settings.hunting.note')}</p>
      <div className="settings-inline">
        <CheckField
          checked={enabled}
          hint={t('settings.hunting.autoHint')}
          label={t('settings.hunting.auto')}
          name={`${namePrefix}hunt-auto`}
          setting="automation.hunting.enabled"
          onChange={(value) => onChange({ enabled: value })}
        />
        {enabled && (
          <>
            <NumberField
              hint={t('settings.hunting.radiusHint')}
              label={t('settings.hunting.radius')}
              name={`${namePrefix}hunt-radius`}
              setting="automation.hunting.radius"
              onChange={(value) => onChange({ radius: value })}
              value={radius}
            />
            <NumberField
              hint={t('settings.hunting.cashHint')}
              label={t('settings.hunting.cash')}
              name={`${namePrefix}hunt-cash`}
              setting="automation.hunting.cashPerHour"
              onChange={(value) => onChange({ cash: value })}
              value={cash}
            />
          </>
        )}
      </div>
      {/* Drawn with Auto-Hunt off too: the Hunting card and the low-exp stop read them. */}
      <ChoiceFields
        namePrefix={namePrefix}
        onChange={(next) => onChoices({ ...choices, ...next })}
        read={huntChoices}
        rows={rows()}
        values={choices}
      />
    </fieldset>
  );
}
