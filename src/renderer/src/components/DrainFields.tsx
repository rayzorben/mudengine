/**
 * Drain when hurt (todo 841), one set of fields for the character form and the
 * options page, as `HealFields` is: the single-target and room drain spells
 * and the pair of health figures that start and stop them. Each value is as
 * the page holds it, a percent for a threshold. The pickers offer only the
 * spells the realm says drain (`drainsIn`).
 */
import { useMemo } from 'react';
import type { VitalThresholds } from '@shared/character';
import type { SpellOption } from '@shared/ipc';
import { NumberField } from './FormField';
import SpellField, { drainsIn } from './SpellPicker';
import { barOf, figureOf } from '../lib/form';
import { t } from '../lib/i18n';

export type DrainText = 'drain' | 'areaDrain';
export type DrainThreshold = 'drainBelow' | 'drainTo';
export type DrainField = DrainText | DrainThreshold;

export interface DrainFieldsProps {
  values: Readonly<Record<DrainText, string> & Record<DrainThreshold, number | string>>;
  onChange(field: DrainField, value: string): void;
  /** The spells the pickers choose from: the character's book, or the realm's. */
  spells: readonly SpellOption[];
  /** The health bands the thresholds' bars are drawn against. */
  bands: VitalThresholds;
  /** The character's maximum, for the figure beside a threshold; absent on the options page. */
  hpMax?: number | null;
  /** Prefixed to each field's name, so the two pages' fields stay apart. */
  namePrefix: string;
}

/** Whether a field holds a spell name, where the others hold a share of health. */
export function isDrainText(field: DrainField): field is DrainText {
  return field === 'drain' || field === 'areaDrain';
}

export default function DrainFields({
  values,
  onChange,
  spells,
  bands,
  hpMax,
  namePrefix
}: DrainFieldsProps): React.JSX.Element {
  const drains = useMemo(() => drainsIn(spells), [spells]);
  const threshold = (field: DrainThreshold, name: string, label: string, hint: string) => {
    const typed = Number.parseInt(String(values[field]), 10) || 0;
    return (
      <NumberField
        hint={hint}
        label={label}
        name={`${namePrefix}${name}`}
        bar={barOf(typed, bands)}
        {...(hpMax === undefined ? {} : { figure: figureOf(typed, hpMax) })}
        onChange={(value) => onChange(field, value)}
        value={values[field]}
      />
    );
  };
  return (
    <>
      <p className="settings-note">{t('settings.spells.drainNote')}</p>
      <div className="settings-inline">
        <SpellField
          hint={t('settings.spells.drainHint')}
          label={t('settings.spells.drainLabel')}
          name={`${namePrefix}drain`}
          onChange={(value) => onChange('drain', value)}
          spells={drains}
          value={values.drain}
        />
        <SpellField
          hint={t('settings.spells.areaDrainHint')}
          label={t('settings.spells.areaDrainLabel')}
          name={`${namePrefix}area-drain`}
          onChange={(value) => onChange('areaDrain', value)}
          spells={drains}
          value={values.areaDrain}
        />
        {threshold(
          'drainBelow',
          'drain-below',
          t('settings.spells.drainBelowLabel'),
          t('settings.spells.drainBelowHint')
        )}
        {threshold(
          'drainTo',
          'drain-to',
          t('settings.spells.drainToLabel'),
          t('settings.spells.drainToHint')
        )}
      </div>
    </>
  );
}
