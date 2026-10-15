/**
 * The attack spell, one set of fields for the character form and the options
 * page, as `HealFields` is for the heal: *Auto Choose Best Spell*, the round
 * spell with its fallback, cap and mana floor, and the room spell with its
 * crowd, floor and cap, and how sure a kill Auto Choose wants (todo 118).
 * Each value is as the page holds it, a percent for a floor or a share; the
 * page turns a change back into its own draft by `ATTACK_KIND`.
 */
import type { VitalThresholds } from '@shared/character';
import type { SpellOption } from '@shared/ipc';
import type { SettingPath } from '@shared/decisionSettings';
import { CheckField, NumberField } from './FormField';
import SpellField from './SpellPicker';
import { barOf, figureOf } from '../lib/form';
import { t } from '../lib/i18n';

export type AttackText = 'attack' | 'attackFallback' | 'areaAttack';
export type AttackCount = 'attackCasts' | 'areaMinMobs' | 'areaCasts';
export type AttackFloor = 'minMana' | 'areaMinMana';
export type AttackShare = 'killConfidence';
export type AttackField = AttackText | AttackCount | AttackFloor | AttackShare;

/** What each field holds, so a page can turn the typed text back into its draft. */
export const ATTACK_KIND = {
  attack: 'text',
  attackFallback: 'text',
  areaAttack: 'text',
  attackCasts: 'count',
  areaMinMobs: 'count',
  areaCasts: 'count',
  minMana: 'floor',
  areaMinMana: 'floor',
  killConfidence: 'share'
} as const satisfies Record<AttackField, 'text' | 'count' | 'floor' | 'share'>;

/** One field of the row: its key, its name after the page's prefix, its words, its setting. */
interface AttackRow<F extends AttackField> {
  field: F;
  name: string;
  label: string;
  hint: string;
  setting: SettingPath;
}

export interface AttackFieldsProps {
  values: Readonly<
    Record<AttackText, string> &
      Record<AttackCount | AttackFloor | AttackShare, number | string> & { autoChoose: boolean }
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
  const spell = ({ field, name, label, hint, setting }: AttackRow<AttackText>) => (
    <SpellField
      hint={hint}
      label={label}
      name={`${namePrefix}${name}`}
      setting={setting}
      onChange={(value) => onChange(field, value)}
      spells={spells}
      value={values[field]}
    />
  );
  const count = ({ field, name, label, hint, setting }: AttackRow<AttackCount>) => (
    <NumberField
      hint={hint}
      label={label}
      name={`${namePrefix}${name}`}
      setting={setting}
      onChange={(value) => onChange(field, value)}
      value={String(values[field])}
    />
  );
  const floor = ({ field, name, label, hint, setting }: AttackRow<AttackFloor>) => {
    const typed = Number.parseInt(String(values[field]), 10) || 0;
    return (
      <NumberField
        hint={hint}
        label={label}
        name={`${namePrefix}${name}`}
        setting={setting}
        bar={barOf(typed, bands)}
        {...(manaMax === undefined ? {} : { figure: figureOf(typed, manaMax) })}
        onChange={(value) => onChange(field, value)}
        value={values[field]}
      />
    );
  };
  return (
    <>
      <div className="settings-inline">
        <CheckField
          checked={values.autoChoose}
          hint={t('settings.spells.autoChooseHint')}
          label={t('settings.spells.autoChoose')}
          name={`${namePrefix}spell-auto-choose`}
          setting="automation.spells.autoChoose"
          onChange={(value) => onToggle('autoChoose', value)}
        />
        {values.autoChoose && (
          <NumberField
            hint={t('settings.spells.killConfidenceHint')}
            label={t('settings.spells.killConfidenceLabel')}
            name={`${namePrefix}kill-confidence`}
            setting="automation.spells.killConfidence"
            onChange={(value) => onChange('killConfidence', value)}
            value={String(values.killConfidence)}
          />
        )}
      </div>
      <div className="settings-inline">
        {spell({
          field: 'attack',
          name: 'spell',
          label: t('settings.spells.castLabel'),
          hint: t('settings.spells.castHint'),
          setting: 'automation.spells.attack'
        })}
        {spell({
          field: 'attackFallback',
          name: 'spell-fallback',
          label: t('settings.spells.fallbackCastLabel'),
          hint: t('settings.spells.fallbackCastHint'),
          setting: 'automation.spells.attackFallback'
        })}
        {count({
          field: 'attackCasts',
          name: 'attack-casts',
          label: t('settings.spells.attackCastsLabel'),
          hint: t('settings.spells.attackCastsHint'),
          setting: 'automation.spells.attackCasts'
        })}
        {floor({
          field: 'minMana',
          name: 'min-mana',
          label: t('settings.spells.minManaLabel'),
          hint: t('settings.spells.minManaHint'),
          setting: 'automation.spells.minMana'
        })}
      </div>
      <div className="settings-inline">
        {spell({
          field: 'areaAttack',
          name: 'area-spell',
          label: t('settings.spells.areaCastLabel'),
          hint: t('settings.spells.areaCastHint'),
          setting: 'automation.spells.areaAttack'
        })}
        {count({
          field: 'areaMinMobs',
          name: 'area-min-mobs',
          label: t('settings.spells.areaMinMobsLabel'),
          hint: t('settings.spells.areaMinMobsHint'),
          setting: 'automation.spells.areaMinMobs'
        })}
        {floor({
          field: 'areaMinMana',
          name: 'area-min-mana',
          label: t('settings.spells.areaMinManaLabel'),
          hint: t('settings.spells.areaMinManaHint'),
          setting: 'automation.spells.areaMinMana'
        })}
        {count({
          field: 'areaCasts',
          name: 'area-casts',
          label: t('settings.spells.areaCastsLabel'),
          hint: t('settings.spells.areaCastsHint'),
          setting: 'automation.spells.areaCasts'
        })}
      </div>
    </>
  );
}
