import { CheckField, NumberField } from './FormField';
import { t } from '../lib/i18n';

/** When the client dials a character by itself, and when it asks first. */
export interface DialSwitches {
  autoConnect: boolean;
  autoReconnect: boolean;
  /** As typed; the model reads a blank as the default, never as 0, which never asks. */
  lowLives: string;
}

export interface DialFieldsProps {
  value: DialSwitches;
  onChange(patch: Partial<DialSwitches>): void;
}

/**
 * Connect on Start, Reconnect, and the lives at which the client asks before
 * any login (todo 07), Connect included. Together because the third holds back
 * the other two. A fragment, so each stays a cell of the form's grid.
 */
export default function DialFields({ value, onChange }: DialFieldsProps): React.JSX.Element {
  return (
    <>
      <CheckField
        checked={value.autoConnect}
        label={t('settings.profile.autoConnectLabel')}
        name="auto-connect"
        onChange={(checked) => onChange({ autoConnect: checked })}
      />
      <CheckField
        checked={value.autoReconnect}
        hint={t('settings.profile.autoReconnectHint')}
        label={t('settings.profile.autoReconnectLabel')}
        name="auto-reconnect"
        onChange={(checked) => onChange({ autoReconnect: checked })}
      />
      <NumberField
        hint={t('settings.profile.lowLivesHint')}
        label={t('settings.profile.lowLivesLabel')}
        name="low-lives"
        onChange={(typed) => onChange({ lowLives: typed })}
        value={value.lowLives}
      />
    </>
  );
}
