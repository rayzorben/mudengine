/**
 * Running a quest's plan (`automation.quests`), one fieldset for the character
 * form and the options page: the switch, and how many times a step that rolls
 * is asked before the run gives up on it (todo 118).
 */
import { CheckField, NumberField } from './FormField';
import { t } from '../lib/i18n';

export interface QuestsFieldsetProps {
  enabled: boolean;
  onEnabled(value: boolean): void;
  /** `rollTries`, as the page holds it. */
  rollTries: string | number;
  onRollTries(typed: string): void;
  /** Put before each field's name, so the two pages' fields keep apart. */
  namePrefix: string;
}

export default function QuestsFieldset({
  enabled,
  onEnabled,
  rollTries,
  onRollTries,
  namePrefix
}: QuestsFieldsetProps): React.JSX.Element {
  return (
    <fieldset className="settings-menus" data-fieldset="quests">
      <legend>{t('settings.quests.legend')}</legend>
      {/*
        In the open, like opening fights unasked: a run has the character for
        as long as a chain takes, and the sentence that says so is not a tooltip.
      */}
      <p className="settings-warn">{t('settings.quests.warning')}</p>
      <div className="settings-inline">
        <CheckField
          checked={enabled}
          hint={t('settings.quests.enabledHint')}
          label={t('settings.quests.enabled')}
          name={`${namePrefix}quests-enabled`}
          setting="automation.quests.enabled"
          onChange={onEnabled}
        />
        <NumberField
          hint={t('settings.quests.rollTriesHint')}
          label={t('settings.quests.rollTries')}
          name={`${namePrefix}quests-roll-tries`}
          setting="automation.quests.rollTries"
          onChange={onRollTries}
          value={rollTries}
        />
      </div>
    </fieldset>
  );
}
