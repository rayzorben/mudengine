/**
 * The rest and meditate thresholds, one set of fields for the character form
 * and the options page (todo 825): rest below and to, rest before traps,
 * meditate below and to. Each value is the percent as the page holds it; the
 * page turns a change back into its own draft. Where a maximum is known the
 * figure it means is drawn beside the field.
 */
import { NumberField } from './FormField';
import { barOf, figureOf } from '../lib/form';
import { t } from '../lib/i18n';
import type { VitalThresholds } from '@shared/character';

export type RestField = 'restBelow' | 'restTo' | 'restBeforeTraps' | 'meditateBelow' | 'meditateTo';

export interface RestFieldsProps {
  values: Readonly<Record<RestField, number | string>>;
  onChange(field: RestField, value: string): void;
  /** The meter bands the bars are drawn against. */
  bands: { hp: VitalThresholds; mana: VitalThresholds };
  /** The character's maxima, for the figure beside a field; absent on the options page. */
  maxima?: { hpMax: number | null; manaMax: number | null };
  /** Prefixed to each field's name, so the two pages' fields stay apart. */
  namePrefix: string;
}

interface Row {
  field: RestField;
  mana: boolean;
  name: string;
  label: string;
  hint: string;
}

function rows(): readonly Row[] {
  return [
    {
      field: 'restBelow',
      mana: false,
      name: 'rest-below',
      label: t('settings.health.restBelowLabel'),
      hint: t('settings.health.restBelowHint')
    },
    {
      field: 'restTo',
      mana: false,
      name: 'rest-to',
      label: t('settings.health.restToLabel'),
      hint: t('settings.health.restToHint')
    },
    {
      field: 'restBeforeTraps',
      mana: false,
      name: 'rest-before-traps',
      label: t('settings.health.restBeforeTrapsLabel'),
      hint: t('settings.health.restBeforeTrapsHint')
    },
    {
      field: 'meditateBelow',
      mana: true,
      name: 'med-below',
      label: t('settings.health.meditateBelowLabel'),
      hint: t('settings.health.meditateBelowHint')
    },
    {
      field: 'meditateTo',
      mana: true,
      name: 'med-to',
      label: t('settings.health.meditateToLabel'),
      hint: t('settings.health.meditateToHint')
    }
  ];
}

export default function RestFields({
  values,
  onChange,
  bands,
  maxima,
  namePrefix
}: RestFieldsProps): React.JSX.Element {
  return (
    <>
      {rows().map((row) => {
        const typed = Number.parseInt(String(values[row.field]), 10) || 0;
        const max = row.mana ? maxima?.manaMax : maxima?.hpMax;
        return (
          <NumberField
            key={row.field}
            hint={row.hint}
            label={row.label}
            name={`${namePrefix}${row.name}`}
            bar={barOf(typed, row.mana ? bands.mana : bands.hp)}
            {...(maxima === undefined ? {} : { figure: figureOf(typed, max ?? null) })}
            onChange={(value) => onChange(row.field, value)}
            value={values[row.field]}
          />
        );
      })}
    </>
  );
}
