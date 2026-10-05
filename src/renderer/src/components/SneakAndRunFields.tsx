import { CheckField } from './FormField';
import { t } from '../lib/i18n';

/** The two switches for getting past monsters on the way. */
export interface SneakAndRun {
  sneak: boolean;
  runBetweenRounds: boolean;
}

export interface SneakAndRunFieldsProps {
  value: SneakAndRun;
  onChange(patch: Partial<SneakAndRun>): void;
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
  namePrefix
}: SneakAndRunFieldsProps): React.JSX.Element {
  return (
    <>
      <CheckField
        checked={value.sneak}
        hint={t('settings.movement.sneakHint')}
        label={t('settings.movement.sneak')}
        name={`${namePrefix}sneak`}
        onChange={(checked) => onChange({ sneak: checked })}
      />
      <CheckField
        checked={value.runBetweenRounds}
        hint={t('settings.movement.runBetweenRoundsHint')}
        label={t('settings.movement.runBetweenRounds')}
        name={`${namePrefix}run-between-rounds`}
        onChange={(checked) => onChange({ runBetweenRounds: checked })}
      />
    </>
  );
}
