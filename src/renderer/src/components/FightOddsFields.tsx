/**
 * Where a fight's odds read as safe and as risky (todo 118), one fieldset for
 * the character form and the options page, typed as percents and read back
 * through `combatChoiceFields`; the draft holds the risky line under the safe one.
 * Drawn whether or not auto-combat is on: the Combat card, the map's lairs,
 * the hunting grounds, routes and Auto Choose Blessings read these too.
 */
import ChoiceFields, { type ChoiceRow } from './ChoiceFields';
import { t } from '../lib/i18n';
import { combatChoiceFields, type CombatChoices } from '@shared/config';

export interface FightOddsFieldsProps {
  choices: CombatChoices;
  onChoices(next: CombatChoices): void;
  /** Prefixed to each field's name, so the two pages' fields stay apart. */
  namePrefix: string;
}

function rows(): ReadonlyArray<ChoiceRow<'safeOddsAbove' | 'riskyOddsAbove'>> {
  return [
    {
      field: 'safeOddsAbove',
      name: 'safe-odds',
      setting: 'automation.combat.safeOddsAbove',
      label: t('settings.combat.safeOddsLabel'),
      hint: t('settings.combat.safeOddsHint'),
      share: true
    },
    {
      field: 'riskyOddsAbove',
      name: 'risky-odds',
      label: t('settings.combat.riskyOddsLabel'),
      hint: t('settings.combat.riskyOddsHint'),
      share: true
    }
  ];
}

export default function FightOddsFields({
  choices,
  onChoices,
  namePrefix
}: FightOddsFieldsProps): React.JSX.Element {
  return (
    <fieldset className="settings-menus" data-fieldset="combat-odds">
      <legend>{t('settings.combat.oddsLegend')}</legend>
      <ChoiceFields
        namePrefix={namePrefix}
        onChange={(next) => onChoices({ ...choices, ...next })}
        read={combatChoiceFields}
        rows={rows()}
        values={choices}
      />
    </fieldset>
  );
}
