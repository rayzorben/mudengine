import { CheckField } from './FormField';
import { t } from '../lib/i18n';
import { CONDITION_WAIT_KEYS, type ConditionWaits } from '@shared/walk';

export interface ConditionWaitFieldsProps {
  value: ConditionWaits;
  onChange(patch: Partial<ConditionWaits>): void;
  /** Put before each field's name, so the two pages' fields keep apart. */
  namePrefix: string;
}

/** One switch per stated condition a walk waits out; paralysis has none. */
const WAITS: Record<keyof ConditionWaits, { name: string; label: string; hint: string }> = {
  walkWhileBlind: {
    name: 'walk-while-blind',
    label: t('settings.movement.walkWhileBlind'),
    hint: t('settings.movement.walkWhileBlindHint')
  },
  walkWhilePoisoned: {
    name: 'walk-while-poisoned',
    label: t('settings.movement.walkWhilePoisoned'),
    hint: t('settings.movement.walkWhilePoisonedHint')
  },
  walkWhileConfused: {
    name: 'walk-while-confused',
    label: t('settings.movement.walkWhileConfused'),
    hint: t('settings.movement.walkWhileConfusedHint')
  }
};

/**
 * The condition waits, drawn by both settings forms into the fieldset they
 * sit in: a fragment, so each switch stays a cell of that fieldset's grid.
 */
export default function ConditionWaitFields({
  value,
  onChange,
  namePrefix
}: ConditionWaitFieldsProps): React.JSX.Element {
  return (
    <>
      {CONDITION_WAIT_KEYS.map((key) => (
        <CheckField
          checked={value[key]}
          hint={WAITS[key].hint}
          key={key}
          label={WAITS[key].label}
          name={`${namePrefix}${WAITS[key].name}`}
          onChange={(checked) => onChange({ [key]: checked })}
        />
      ))}
    </>
  );
}
