/**
 * The Monsters fieldset, one set of fields for the character form and the
 * options page: the health and exp caps, the monsters that cost alignment, the
 * weapon swap for a monster the hand cannot hurt, and how long a monster run
 * from is left alone (todo 118). The caps are read back through `combatCaps`,
 * the rest through `combatChoiceFields`.
 */
import { CheckField } from './FormField';
import ChoiceFields, { type ChoiceRow } from './ChoiceFields';
import { t } from '../lib/i18n';
import {
  combatCaps,
  combatChoiceFields,
  type CombatCaps,
  type CombatChoices
} from '@shared/config';
import type { SettingPath } from '@shared/decisionSettings';

type MonsterSwitch = 'attackCostly' | 'swapWeapons';

interface MonsterToggle {
  field: MonsterSwitch;
  name: string;
  label: string;
  hint: string;
  setting: SettingPath;
}

export interface MonsterFieldsProps {
  caps: CombatCaps;
  onCaps(next: CombatCaps): void;
  choices: CombatChoices;
  onChoices(next: CombatChoices): void;
  /** Prefixed to each field's name, so the two pages' fields stay apart. */
  namePrefix: string;
}

function capRows(): ReadonlyArray<ChoiceRow<keyof CombatCaps>> {
  return [
    {
      field: 'maxTargetHealth',
      name: 'max-target-health',
      setting: 'automation.combat.maxTargetHealth',
      label: t('settings.combat.maxTargetHealthLabel'),
      hint: t('settings.combat.maxTargetHealthHint')
    },
    {
      field: 'maxMonsterExperience',
      name: 'max-monster-exp',
      setting: 'automation.combat.maxMonsterExperience',
      label: t('settings.combat.maxMonsterExpLabel'),
      hint: t('settings.combat.maxMonsterExpHint')
    }
  ];
}

function fledRows(): ReadonlyArray<ChoiceRow<'fledLevels' | 'fledForgetMinutes'>> {
  return [
    {
      field: 'fledLevels',
      name: 'fled-levels',
      setting: 'automation.combat.fledLevels',
      label: t('settings.combat.fledLevelsLabel'),
      hint: t('settings.combat.fledLevelsHint')
    },
    {
      field: 'fledForgetMinutes',
      name: 'fled-minutes',
      setting: 'automation.combat.fledForgetMinutes',
      label: t('settings.combat.fledMinutesLabel'),
      hint: t('settings.combat.fledMinutesHint')
    }
  ];
}

export default function MonsterFields({
  caps,
  onCaps,
  choices,
  onChoices,
  namePrefix
}: MonsterFieldsProps): React.JSX.Element {
  const toggle = ({ field, name, label, hint, setting }: MonsterToggle) => (
    <CheckField
      checked={choices[field]}
      hint={hint}
      label={label}
      name={`${namePrefix}${name}`}
      onChange={(value) => onChoices({ ...choices, [field]: value })}
      setting={setting}
    />
  );
  return (
    <fieldset className="settings-menus" data-fieldset="combat-monsters">
      <legend>{t('settings.combat.monstersLegend')}</legend>
      <ChoiceFields
        namePrefix={namePrefix}
        onChange={(next) => onCaps({ ...caps, ...next })}
        read={combatCaps}
        rows={capRows()}
        values={caps}
      />
      <div className="settings-inline">
        {toggle({
          field: 'attackCostly',
          name: 'attack-costly',
          label: t('settings.combat.attackCostlyLabel'),
          hint: t('settings.combat.attackCostlyHint'),
          setting: 'automation.combat.attackCostly'
        })}
        {toggle({
          field: 'swapWeapons',
          name: 'swap-weapons',
          label: t('settings.combat.swapWeaponsLabel'),
          hint: t('settings.combat.swapWeaponsHint'),
          setting: 'automation.combat.swapWeapons'
        })}
      </div>
      <ChoiceFields
        namePrefix={namePrefix}
        onChange={(next) => onChoices({ ...choices, ...next })}
        read={combatChoiceFields}
        rows={fledRows()}
        values={choices}
      />
    </fieldset>
  );
}
