/**
 * Going hunting on its own, one set of fields for the character form and the
 * options page (todo 64): the switch, how far to look and the copper an hour
 * the hunt should earn. Each figure is the text the page holds; the page turns
 * a change back into its own draft.
 */
import { CheckField, NumberField } from './FormField';
import { t } from '../lib/i18n';

export interface HuntingFieldsProps {
  enabled: boolean;
  /** How far to look, as text; '' is everywhere the exits reach. */
  radius: string;
  /** Copper an hour, as text; '' is exp alone. */
  cash: string;
  onChange(change: { enabled?: boolean; radius?: string; cash?: string }): void;
  /** Prefixed to each field's name, so the two pages' fields stay apart. */
  namePrefix: string;
}

export default function HuntingFields({
  enabled,
  radius,
  cash,
  onChange,
  namePrefix
}: HuntingFieldsProps): React.JSX.Element {
  return (
    <div className="settings-inline">
      <CheckField
        checked={enabled}
        hint={t('settings.hunting.autoHint')}
        label={t('settings.hunting.auto')}
        name={`${namePrefix}hunt-auto`}
        onChange={(value) => onChange({ enabled: value })}
      />
      {enabled && (
        <>
          <NumberField
            hint={t('settings.hunting.radiusHint')}
            label={t('settings.hunting.radius')}
            name={`${namePrefix}hunt-radius`}
            onChange={(value) => onChange({ radius: value })}
            value={radius}
          />
          <NumberField
            hint={t('settings.hunting.cashHint')}
            label={t('settings.hunting.cash')}
            name={`${namePrefix}hunt-cash`}
            onChange={(value) => onChange({ cash: value })}
            value={cash}
          />
        </>
      )}
    </div>
  );
}
