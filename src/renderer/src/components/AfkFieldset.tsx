/**
 * Away From Keyboard (`automation.afk`), one fieldset for the character form
 * and the options page: the auto-reply switch, the minutes before a character
 * counts as away, and the reply. Beside the alerts, because both are about a
 * player who is not looking: alerts are what they hear about the character,
 * and this is what the character says for them. Each page turns a change back
 * into its own draft.
 */
import { CheckField, NumberField, TextField } from './FormField';
import { t } from '../lib/i18n';

export interface AfkFieldsetProps {
  enabled: boolean;
  /** Minutes, as the page holds them. */
  after: string;
  reply: string;
  onEnabled(value: boolean): void;
  onAfter(typed: string): void;
  onReply(value: string): void;
  /** Put before each field's name, so the two pages' fields keep apart. */
  namePrefix: string;
}

export default function AfkFieldset(props: AfkFieldsetProps): React.JSX.Element {
  return (
    <fieldset className="settings-menus" data-fieldset="alerts-afk">
      <legend>{t('settings.afk.legend')}</legend>
      <div className="settings-inline">
        <CheckField
          checked={props.enabled}
          hint={t('settings.afk.enabledHint')}
          label={t('settings.afk.enabled')}
          name={`${props.namePrefix}afk-enabled`}
          setting="automation.afk.enabled"
          onChange={props.onEnabled}
        />
        <NumberField
          hint={t('settings.afk.afterHint')}
          label={t('settings.afk.afterLabel')}
          name={`${props.namePrefix}afk-after`}
          setting="automation.afk.afterMinutes"
          onChange={props.onAfter}
          value={props.after}
        />
        <TextField
          hint={t('settings.afk.replyHint')}
          label={t('settings.afk.replyLabel')}
          name={`${props.namePrefix}afk-reply`}
          setting="automation.afk.reply"
          onChange={props.onReply}
          value={props.reply}
        />
      </div>
    </fieldset>
  );
}
