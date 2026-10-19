import { CheckField, TextField } from './FormField';
import { t } from '../lib/i18n';
import type { ArtConfig } from '@shared/artConfig';

export interface ArtFieldsProps {
  value: ArtConfig;
  onChange(patch: Partial<ArtConfig>): void;
}

/**
 * The art server's fieldset on the Global page (todo 20261019-0931-01): the
 * switch for portraits and the server's address, the one setting on the page
 * that no new realm or character copies, which its hint says.
 */
export default function ArtFields({ value, onChange }: ArtFieldsProps): React.JSX.Element {
  return (
    <fieldset data-fieldset="realm-portraits">
      <legend>{t('settings.global.art.legend')}</legend>
      <div className="settings-inline">
        <CheckField
          checked={value.enabled}
          hint={t('settings.global.art.enabledHint')}
          label={t('settings.global.art.enabled')}
          name="global-art-enabled"
          setting="art.enabled"
          onChange={(checked) => onChange({ enabled: checked })}
        />
      </div>
      {value.enabled && (
        <TextField
          hint={t('settings.global.art.serverHint')}
          label={t('settings.global.art.server')}
          name="global-art-server"
          onChange={(server) => onChange({ server })}
          spellCheck={false}
          value={value.server}
          wide
        />
      )}
    </fieldset>
  );
}
