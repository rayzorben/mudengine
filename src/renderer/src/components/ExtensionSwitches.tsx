/**
 * `extensions:` (todo 118) on the MudEngine page: a switch per extension
 * installed in the home, absent meaning on. Extensions are loaded once when
 * the client starts, so a switch says what the next start does, and a row
 * whose switch differs from this launch says so.
 */
import { CheckField } from './FormField';

import { useInstalledExtensions } from '../hooks/useExtensions';
import { t } from '../lib/i18n';
import { extensionOn, type ExtensionSwitches as Switches } from '@shared/extensionSwitches';

export interface ExtensionSwitchesProps {
  switches: Switches;
  onChange(switches: Switches): void;
}

export default function ExtensionSwitches({ switches, onChange }: ExtensionSwitchesProps) {
  const installed = useInstalledExtensions();
  return (
    <fieldset className="settings-menus" data-fieldset="extensions">
      <legend>{t('settings.extensions.legend')}</legend>
      <p className="settings-warn">{t('settings.extensions.warning')}</p>
      <p className="settings-note">{t('settings.extensions.note')}</p>
      {installed.length === 0 && <p className="settings-note">{t('settings.extensions.none')}</p>}
      <div className="settings-inline">
        {installed.map(({ name, title, loaded }) => {
          const on = extensionOn(switches, name);
          return (
            <CheckField
              checked={on}
              hint={on === loaded ? undefined : t('settings.extensions.atNextStart')}
              key={name}
              label={title}
              name={`extension-${name}`}
              setting="extensions"
              onChange={(value) => onChange({ ...switches, [name]: value })}
            />
          );
        })}
      </div>
    </fieldset>
  );
}
