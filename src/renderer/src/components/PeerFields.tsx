import { CheckField, TextField } from './FormField';
import { t } from '../lib/i18n';
import type { PeersConfig } from '@shared/peersConfig';

export interface PeerFieldsProps {
  value: PeersConfig;
  onChange(patch: Partial<PeersConfig>): void;
}

/**
 * The sharing fieldset on the Global page (todo 20261031-1156-01): the switch
 * that lets any share reach the gateway, off by default, and the gateway's
 * address. Like the art server's, no new realm or character copies it.
 */
export default function PeerFields({ value, onChange }: PeerFieldsProps): React.JSX.Element {
  return (
    <fieldset data-fieldset="realm-sharing">
      <legend>{t('settings.global.peers.legend')}</legend>
      <div className="settings-inline">
        <CheckField
          checked={value.enabled}
          hint={t('settings.global.peers.enabledHint')}
          label={t('settings.global.peers.enabled')}
          name="global-peers-enabled"
          onChange={(checked) => onChange({ enabled: checked })}
        />
      </div>
      {value.enabled && (
        <TextField
          hint={t('settings.global.peers.serverHint')}
          label={t('settings.global.peers.server')}
          name="global-peers-server"
          onChange={(server) => onChange({ server })}
          spellCheck={false}
          value={value.server}
          wide
        />
      )}
    </fieldset>
  );
}
