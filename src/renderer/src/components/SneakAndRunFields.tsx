import { CheckField } from './FormField';
import ChoiceFields from './ChoiceFields';
import { t } from '../lib/i18n';
import { movementChoices, type MovementChoices } from '@shared/walkChoices';

/** The two switches for getting past monsters on the way. */
export interface SneakAndRun {
  sneak: boolean;
  runBetweenRounds: boolean;
}

export interface SneakAndRunFieldsProps {
  value: SneakAndRun;
  onChange(patch: Partial<SneakAndRun>): void;
  /** How many refused sneaks in a row stop the asking (todo 118). */
  choices: MovementChoices;
  onChoice(patch: Partial<MovementChoices>): void;
  /** Put before each field's name, so the two pages' fields keep apart. */
  namePrefix: string;
}

/**
 * Sneaking and running between rounds, drawn by both settings forms into the
 * fieldset they sit in: a fragment, so each switch stays a cell of its grid.
 */
export default function SneakAndRunFields({
  value,
  onChange,
  choices,
  onChoice,
  namePrefix
}: SneakAndRunFieldsProps): React.JSX.Element {
  return (
    <>
      <div className="settings-inline">
        <CheckField
          checked={value.sneak}
          hint={t('settings.movement.sneakHint')}
          label={t('settings.movement.sneak')}
          name={`${namePrefix}sneak`}
          setting="automation.movement.sneak"
          onChange={(checked) => onChange({ sneak: checked })}
        />
        {value.sneak && (
          <ChoiceFields
            bare
            namePrefix={namePrefix}
            onChange={onChoice}
            read={movementChoices}
            rows={[
              {
                field: 'sneakGiveUp',
                name: 'sneak-give-up',
                setting: 'automation.movement.sneakGiveUp',
                label: t('settings.movement.sneakGiveUp'),
                hint: t('settings.movement.sneakGiveUpHint')
              }
            ]}
            values={choices}
          />
        )}
      </div>
      <CheckField
        checked={value.runBetweenRounds}
        hint={t('settings.movement.runBetweenRoundsHint')}
        label={t('settings.movement.runBetweenRounds')}
        name={`${namePrefix}run-between-rounds`}
        setting="automation.movement.runBetweenRounds"
        onChange={(checked) => onChange({ runBetweenRounds: checked })}
      />
    </>
  );
}
