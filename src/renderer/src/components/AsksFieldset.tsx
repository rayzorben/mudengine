/**
 * What the client asks the realm on its own (`automation.asks`, todo 118), one
 * fieldset for the character form and the options page: how often `i`, `st`,
 * `exp` and `who` are asked again, and the switches for `abil`, the spell
 * list, `st` when a buff ends, `stat a` and a look at a charged item. Said in
 * the open: a fact never asked stays unknown on the cards.
 */
import ChoiceFields, { type ChoiceRow } from './ChoiceFields';
import { CheckField } from './FormField';
import { t } from '../lib/i18n';
import { normalizeAsks, type AsksConfig } from '@shared/asks';
import type { SettingPath } from '@shared/decisionSettings';

export interface AsksFieldsetProps {
  asks: AsksConfig;
  onChange(asks: AsksConfig): void;
  /** Put before each field's name, so the two pages' fields keep apart. */
  namePrefix: string;
}

type Period = 'inventoryMinutes' | 'statsMinutes' | 'expMinutes' | 'whoMinutes';
type Switch = 'abilities' | 'spellbook' | 'statsOnBuffEnding' | 'statAll' | 'itemUses';

function periods(): ReadonlyArray<ChoiceRow<Period>> {
  return [
    {
      field: 'inventoryMinutes',
      name: 'asks-inventory',
      setting: 'automation.asks.inventoryMinutes',
      label: t('settings.asks.inventory'),
      hint: t('settings.asks.inventoryHint')
    },
    {
      field: 'statsMinutes',
      name: 'asks-stats',
      setting: 'automation.asks.statsMinutes',
      label: t('settings.asks.stats'),
      hint: t('settings.asks.statsHint')
    },
    {
      field: 'expMinutes',
      name: 'asks-exp',
      setting: 'automation.asks.expMinutes',
      label: t('settings.asks.exp'),
      hint: t('settings.asks.expHint')
    },
    {
      field: 'whoMinutes',
      name: 'asks-who',
      setting: 'automation.asks.whoMinutes',
      label: t('settings.asks.who'),
      hint: t('settings.asks.whoHint')
    }
  ];
}

function switches(): ReadonlyArray<{
  field: Switch;
  name: string;
  setting: SettingPath;
  label: string;
  hint: string;
}> {
  return [
    {
      field: 'abilities',
      name: 'asks-abilities',
      setting: 'automation.asks.abilities',
      label: t('settings.asks.abilities'),
      hint: t('settings.asks.abilitiesHint')
    },
    {
      field: 'spellbook',
      name: 'asks-spellbook',
      setting: 'automation.asks.spellbook',
      label: t('settings.asks.spellbook'),
      hint: t('settings.asks.spellbookHint')
    },
    {
      field: 'statsOnBuffEnding',
      name: 'asks-buff-ending',
      setting: 'automation.asks.statsOnBuffEnding',
      label: t('settings.asks.statsOnBuffEnding'),
      hint: t('settings.asks.statsOnBuffEndingHint')
    },
    {
      field: 'statAll',
      name: 'asks-stat-all',
      setting: 'automation.asks.statAll',
      label: t('settings.asks.statAll'),
      hint: t('settings.asks.statAllHint')
    },
    {
      field: 'itemUses',
      name: 'asks-item-uses',
      setting: 'automation.asks.itemUses',
      label: t('settings.asks.itemUses'),
      hint: t('settings.asks.itemUsesHint')
    }
  ];
}

export default function AsksFieldset({
  asks,
  onChange,
  namePrefix
}: AsksFieldsetProps): React.JSX.Element {
  return (
    <fieldset className="settings-menus" data-fieldset="rewrites-asks">
      <legend>{t('settings.asks.legend')}</legend>
      <p className="settings-warn">{t('settings.asks.warning')}</p>
      <ChoiceFields
        namePrefix={namePrefix}
        onChange={(next) => onChange({ ...asks, ...next })}
        read={normalizeAsks}
        rows={periods()}
        values={asks}
      />
      <div className="settings-inline">
        {switches().map((row) => (
          <CheckField
            checked={asks[row.field]}
            hint={row.hint}
            key={row.field}
            label={row.label}
            name={`${namePrefix}${row.name}`}
            setting={row.setting}
            onChange={(value) => onChange({ ...asks, [row.field]: value })}
          />
        ))}
      </div>
    </fieldset>
  );
}
