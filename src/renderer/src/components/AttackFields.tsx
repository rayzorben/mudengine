/**
 * The attack spell, one set of fields for the character form and the options
 * page, as `HealFields` is for the heal: *Auto Choose Best Spell*, the round
 * spell with its fallback, cap and mana floor, and the room spell with its
 * crowd, floor and cap. Each value is as the page holds it, a percent for a
 * floor; the page turns a change back into its own draft by `ATTACK_KIND`.
 */
import type { VitalThresholds } from '@shared/character';
import type { SpellOption } from '@shared/ipc';
import { CheckField, NumberField } from './FormField';
import SpellField from './SpellPicker';
import { barOf, figureOf } from '../lib/form';
import { t } from '../lib/i18n';

export type AttackText = 'attack' | 'attackFallback' | 'areaAttack';
export type AttackCount = 'attackCasts' | 'areaMinMobs' | 'areaCasts';
export type AttackFloor = 'minMana' | 'areaMinMana';
export type AttackField = AttackText | AttackCount | AttackFloor;

/** What each field holds, so a page can turn the typed text back into its draft. */
export const ATTACK_KIND = {
  attack: 'text',
  attackFallback: 'text',
  areaAttack: 'text',
  attackCasts: 'count',
  areaMinMobs: 'count',
  areaCasts: 'count',
  minMana: 'floor',
  areaMinMana: 'floor'
} as const satisfies Record<AttackField, 'text' | 'count' | 'floor'>;

export interface AttackFieldsProps {
  values: Readonly<
    Record<AttackText, string> &
      Record<AttackCount | AttackFloor, number | string> & { autoChoose: boolean }
  >;
  onChange(field: AttackField, value: string): void;
  onToggle(field: 'autoChoose', value: boolean): void;
  /** The spells the pickers choose from: the character's book, or the realm's. */
  spells: readonly SpellOption[];
  /** The mana bands the floors' bars are drawn against. */
  bands: VitalThresholds;
  /** The character's maximum, for the figure beside a floor; absent on the options page. */
  manaMax?: number | null;
  /** Prefixed to each field's name, so the two pages' fields stay apart. */
  namePrefix: string;
}

export default function AttackFields({
  values,
  onChange,
  onToggle,
  spells,
  bands,
  manaMax,
  namePrefix
}: AttackFieldsProps): React.JSX.Element {
  const spell = (field: AttackText, name: string, label: string, hint: string) => (
    <SpellField
      hint={hint}
      label={label}
      name={`${namePrefix}${name}`}
      onChange={(value) => onChange(field, value)}
      spells={spells}
      value={values[field]}
    />
  );
  const count = (field: AttackCount, name: string, label: string, hint: string) => (
    <NumberField
      hint={hint}
      label={label}
      name={`${namePrefix}${name}`}
      onChange={(value) => onChange(field, value)}
      value={String(values[field])}
    />
  );
  const floor = (field: AttackFloor, name: string, label: string, hint: string) => {
    const typed = Number.parseInt(String(values[field]), 10) || 0;
    return (
      <NumberField
        hint={hint}
        label={label}
        name={`${namePrefix}${name}`}
        bar={barOf(typed, bands)}
        {...(manaMax === undefined ? {} : { figure: figureOf(typed, manaMax) })}
        onChange={(value) => onChange(field, value)}
        value={values[field]}
      />
    );
  };
  return (
    <>
      <CheckField
        checked={values.autoChoose}
        hint={t('settings.spells.autoChooseHint')}
        label={t('settings.spells.autoChoose')}
        name={`${namePrefix}spell-auto-choose`}
        onChange={(value) => onToggle('autoChoose', value)}
      />
      <div className="settings-inline">
        {spell('attack', 'spell', t('settings.spells.castLabel'), t('settings.spells.castHint'))}
        {spell(
          'attackFallback',
          'spell-fallback',
          t('settings.spells.fallbackCastLabel'),
          t('settings.spells.fallbackCastHint')
        )}
        {count(
          'attackCasts',
          'attack-casts',
          t('settings.spells.attackCastsLabel'),
          t('settings.spells.attackCastsHint')
        )}
        {floor(
          'minMana',
          'min-mana',
          t('settings.spells.minManaLabel'),
          t('settings.spells.minManaHint')
        )}
      </div>
      <div className="settings-inline">
        {spell(
          'areaAttack',
          'area-spell',
          t('settings.spells.areaCastLabel'),
          t('settings.spells.areaCastHint')
        )}
        {count(
          'areaMinMobs',
          'area-min-mobs',
          t('settings.spells.areaMinMobsLabel'),
          t('settings.spells.areaMinMobsHint')
        )}
        {floor(
          'areaMinMana',
          'area-min-mana',
          t('settings.spells.areaMinManaLabel'),
          t('settings.spells.areaMinManaHint')
        )}
        {count(
          'areaCasts',
          'area-casts',
          t('settings.spells.areaCastsLabel'),
          t('settings.spells.areaCastsHint')
        )}
      </div>
    </>
  );
}
