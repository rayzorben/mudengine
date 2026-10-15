import { TextField } from './FormField';
import { t } from '../lib/i18n';
import { joinNames, splitNames } from '../lib/form';

export interface KeepOutFieldsetProps {
  /** `automation.movement.keepOutOf`: words for the paths and places a route goes round. */
  value: readonly string[];
  onChange(keepOutOf: string[]): void;
  /** Put before the field's name, so the two pages' fields keep apart. */
  namePrefix: string;
}

/** The Avoiding fieldset, one for the character form and the options page. */
export default function KeepOutFieldset({
  value,
  onChange,
  namePrefix
}: KeepOutFieldsetProps): React.JSX.Element {
  return (
    <fieldset className="settings-menus" data-fieldset="movement-keep-out">
      <legend>{t('settings.movement.keepOutLegend')}</legend>
      <TextField
        hint={t('settings.movement.keepOutOfHint')}
        label={t('settings.movement.keepOutOf')}
        name={`${namePrefix}keep-out-of`}
        setting="automation.movement.keepOutOf"
        onChange={(typed) => onChange(splitNames(typed))}
        placeholder={t('settings.movement.keepOutOfPlaceholder')}
        value={joinNames(value)}
        wide
      />
    </fieldset>
  );
}
