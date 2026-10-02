/**
 * The heal, one set of fields for the character form and the options page:
 * *Auto Choose Best Heal* (todo 05), the self heal and its thresholds, the
 * heal's own mana floor, and the party heal. Each value is as the page holds
 * it, a percent for a threshold; the page turns a change back into its own
 * draft. The two spell fields offer
 * different halves of the book because the realm marks who each spell may be
 * cast on: `way of the swan` reaches the caster alone, so offering it for the
 * party heal would arm `swan <name>` once a round for a refusal printed in the
 * room. Both predicates say yes to a spell whose targeting this build cannot
 * read, so a derivative realm loses no options.
 */
import { useMemo } from 'react';
import type { VitalsUiConfig } from '@shared/config';
import type { SpellOption } from '@shared/ipc';
import { castsOnOthers, castsOnSelf } from '@shared/spellcraft';
import { CheckField, NumberField } from './FormField';
import SpellField, { castableOn, refusesTarget } from './SpellPicker';
import { barOf, figureOf } from '../lib/form';
import { t } from '../lib/i18n';

export type HealText = 'heal' | 'healPartyWith';
export type HealThreshold = 'healBelow' | 'healBelowInCombat' | 'healTo';
export type HealSwitch = 'autoChooseHeal' | 'healParty';
export type HealFloor = 'healMinMana';
export type HealField = HealText | HealThreshold | HealFloor;

export interface HealFieldsProps {
  values: Readonly<
    Record<HealText, string> &
      Record<HealThreshold | HealFloor, number | string> &
      Record<HealSwitch, boolean>
  >;
  onChange(field: HealField, value: string): void;
  onToggle(field: HealSwitch, value: boolean): void;
  /** The spells the pickers choose from: the character's book, or the realm's. */
  spells: readonly SpellOption[];
  /** The bands the bars are drawn against: health for a threshold, mana for the floor. */
  bands: VitalsUiConfig;
  /** The character's maxima, for the figure beside each field; absent on the options page. */
  maxima?: { hpMax: number | null; manaMax: number | null };
  /** Prefixed to each field's name, so the two pages' fields stay apart. */
  namePrefix: string;
}

export default function HealFields({
  values,
  onChange,
  onToggle,
  spells,
  bands,
  maxima,
  namePrefix
}: HealFieldsProps): React.JSX.Element {
  const selfHeals = useMemo(() => castableOn(spells, castsOnSelf), [spells]);
  const partyHeals = useMemo(() => castableOn(spells, castsOnOthers), [spells]);
  const threshold = (
    field: HealThreshold | HealFloor,
    name: string,
    label: string,
    hint?: string
  ) => {
    const typed = Number.parseInt(String(values[field]), 10) || 0;
    // The floor is a share of mana; every other threshold is a share of health.
    const vital = field === 'healMinMana' ? 'mana' : 'hp';
    const max = vital === 'mana' ? maxima?.manaMax : maxima?.hpMax;
    return (
      <NumberField
        {...(hint === undefined ? {} : { hint })}
        label={label}
        name={`${namePrefix}${name}`}
        bar={barOf(typed, bands[vital])}
        {...(max === undefined ? {} : { figure: figureOf(typed, max) })}
        onChange={(value) => onChange(field, value)}
        value={values[field]}
      />
    );
  };
  return (
    <>
      <CheckField
        checked={values.autoChooseHeal}
        hint={t('settings.spells.autoChooseHealHint')}
        label={t('settings.spells.autoChooseHeal')}
        name={`${namePrefix}heal-auto-choose`}
        onChange={(value) => onToggle('autoChooseHeal', value)}
      />
      <div className="settings-inline">
        <SpellField
          hint={t('settings.spells.healHint')}
          label={t('settings.spells.healLabel')}
          name={`${namePrefix}heal`}
          onChange={(value) => onChange('heal', value)}
          spells={selfHeals}
          value={values.heal}
          warning={
            refusesTarget(spells, castsOnSelf, values.heal)
              ? t('settings.spells.healNoSelfCast')
              : undefined
          }
        />
        {threshold('healBelow', 'heal-below', t('settings.spells.healBelowLabel'))}
        {threshold(
          'healBelowInCombat',
          'heal-below-combat',
          t('settings.spells.healBelowInCombatLabel'),
          t('settings.spells.healBelowInCombatHint')
        )}
        {threshold(
          'healTo',
          'heal-to',
          t('settings.spells.healToLabel'),
          t('settings.spells.healToHint')
        )}
        {threshold(
          'healMinMana',
          'heal-min-mana',
          t('settings.spells.healMinManaLabel'),
          t('settings.spells.healMinManaHint')
        )}
      </div>
      <CheckField
        checked={values.healParty}
        hint={t('settings.spells.healPartyHint')}
        label={t('settings.spells.healParty')}
        name={`${namePrefix}heal-party`}
        onChange={(value) => onToggle('healParty', value)}
      />
      <SpellField
        hint={t('settings.spells.healPartyWithHint')}
        label={t('settings.spells.healPartyWithLabel')}
        name={`${namePrefix}heal-party-with`}
        onChange={(value) => onChange('healPartyWith', value)}
        spells={partyHeals}
        value={values.healPartyWith}
        warning={
          refusesTarget(spells, castsOnOthers, values.healPartyWith)
            ? t('settings.spells.healNoPartyCast')
            : undefined
        }
      />
    </>
  );
}
