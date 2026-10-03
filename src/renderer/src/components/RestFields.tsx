/**
 * The rest and meditate settings, one set of fields for the character form
 * and the options page (todo 825): rest below and to, rest before traps,
 * rest below and to for mana, then the switches: resting next door to a
 * lair, resting for mana with `med`, and meditating before resting. Each value is as the page holds it; the
 * page turns a change back into its own draft. Where a maximum is known the
 * figure it means is drawn beside the field.
 */
import { CheckField, NumberField } from './FormField';
import { barOf, figureOf } from '../lib/form';
import { t } from '../lib/i18n';
import type { VitalThresholds } from '@shared/character';

export type RestField = 'restBelow' | 'restTo' | 'restBeforeTraps' | 'restBelowMana' | 'restToMana';

export type RestCheck = 'restNextDoor' | 'useMeditate' | 'meditateFirst';

export interface RestFieldsProps {
  values: Readonly<Record<RestField, number | string>>;
  onChange(field: RestField, value: string): void;
  checks: Readonly<Record<RestCheck, boolean>>;
  onCheck(field: RestCheck, value: boolean): void;
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
      field: 'restBelowMana',
      mana: true,
      name: 'rest-mana-below',
      label: t('settings.health.restBelowManaLabel'),
      hint: t('settings.health.restBelowManaHint')
    },
    {
      field: 'restToMana',
      mana: true,
      name: 'rest-mana-to',
      label: t('settings.health.restToManaLabel'),
      hint: t('settings.health.restToManaHint')
    }
  ];
}

function checks(): ReadonlyArray<{ field: RestCheck; name: string; label: string; hint: string }> {
  return [
    {
      field: 'restNextDoor',
      name: 'rest-next-door',
      label: t('settings.health.restNextDoor'),
      hint: t('settings.health.restNextDoorHint')
    },
    {
      field: 'useMeditate',
      name: 'use-meditate',
      label: t('settings.health.useMeditate'),
      hint: t('settings.health.useMeditateHint')
    },
    {
      field: 'meditateFirst',
      name: 'meditate-first',
      label: t('settings.health.meditateFirst'),
      hint: t('settings.health.meditateFirstHint')
    }
  ];
}

export default function RestFields({
  values,
  onChange,
  checks: checked,
  onCheck,
  bands,
  maxima,
  namePrefix
}: RestFieldsProps): React.JSX.Element {
  return (
    <>
      <div className="settings-inline">
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
      </div>
      {checks().map((row) => (
        <CheckField
          key={row.field}
          checked={checked[row.field]}
          hint={row.hint}
          label={row.label}
          name={`${namePrefix}${row.name}`}
          onChange={(value) => onCheck(row.field, value)}
        />
      ))}
    </>
  );
}
