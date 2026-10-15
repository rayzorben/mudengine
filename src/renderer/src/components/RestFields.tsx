/**
 * The rest and meditate settings, one set of fields for the character form
 * and the options page (todo 825): rest below and to, rest before traps,
 * rest below and to for mana, then the switches: resting next door to a
 * lair, resting for mana with `med`, and meditating before resting; then the
 * spell cast before a rest (todo 60). Each value is as the page holds it; the
 * page turns a change back into its own draft. Where a maximum is known the
 * figure it means is drawn beside the field, and on the character page a
 * sentence says which way Use Meditate goes for this character.
 */
import { CheckField, NumberField } from './FormField';
import SpellField from './SpellPicker';
import { barOf, figureOf } from '../lib/form';
import { t } from '../lib/i18n';
import { meditateSays } from '../lib/liveSheet';
import type { VitalThresholds } from '@shared/character';
import type { SpellOption } from '@shared/ipc';
import type { SettingPath } from '@shared/decisionSettings';

export type RestField = 'restBelow' | 'restTo' | 'restBeforeTraps' | 'restBelowMana' | 'restToMana';

export type RestCheck = 'restNextDoor' | 'useMeditate' | 'meditateFirst';

export interface RestFieldsProps {
  /**
   * The figures, the spell cast before a rest (`restSpell`) and how soon a
   * lair refills for Rest Next Door (`restNextDoorMinutes`).
   */
  values: Readonly<
    Record<RestField | 'restNextDoorMinutes', number | string> & { restSpell: string }
  >;
  onChange(field: RestField | 'restSpell' | 'restNextDoorMinutes', value: string): void;
  checks: Readonly<Record<RestCheck, boolean>>;
  onCheck(field: RestCheck, value: boolean): void;
  /** The meter bands the bars are drawn against. */
  bands: { hp: VitalThresholds; mana: VitalThresholds };
  /** The character's maxima, for the figure beside a field; absent on the options page. */
  maxima?: { hpMax: number | null; manaMax: number | null };
  /**
   * Whether an `abil` list shows Meditate, for the sentence under Use
   * Meditate (todo 50); absent on the options page, which has no character.
   */
  meditate?: boolean | null;
  /** Prefixed to each field's name, so the two pages' fields stay apart. */
  namePrefix: string;
  /** The spells offered for the one cast before a rest. */
  spells: readonly SpellOption[];
}

interface Row {
  field: RestField;
  mana: boolean;
  name: string;
  label: string;
  hint: string;
  setting: SettingPath;
}

function rows(): readonly Row[] {
  return [
    {
      field: 'restBelow',
      mana: false,
      name: 'rest-below',
      setting: 'automation.health.restBelow',
      label: t('settings.health.restBelowLabel'),
      hint: t('settings.health.restBelowHint')
    },
    {
      field: 'restTo',
      mana: false,
      name: 'rest-to',
      setting: 'automation.health.restTo',
      label: t('settings.health.restToLabel'),
      hint: t('settings.health.restToHint')
    },
    {
      field: 'restBeforeTraps',
      mana: false,
      name: 'rest-before-traps',
      setting: 'automation.health.restBeforeTraps',
      label: t('settings.health.restBeforeTrapsLabel'),
      hint: t('settings.health.restBeforeTrapsHint')
    },
    {
      field: 'restBelowMana',
      mana: true,
      name: 'rest-mana-below',
      setting: 'automation.health.restBelowMana',
      label: t('settings.health.restBelowManaLabel'),
      hint: t('settings.health.restBelowManaHint')
    },
    {
      field: 'restToMana',
      mana: true,
      name: 'rest-mana-to',
      setting: 'automation.health.restToMana',
      label: t('settings.health.restToManaLabel'),
      hint: t('settings.health.restToManaHint')
    }
  ];
}

function checks(): ReadonlyArray<{
  field: RestCheck;
  name: string;
  label: string;
  hint: string;
  setting: SettingPath;
}> {
  return [
    {
      field: 'restNextDoor',
      name: 'rest-next-door',
      setting: 'automation.health.restNextDoor',
      label: t('settings.health.restNextDoor'),
      hint: t('settings.health.restNextDoorHint')
    },
    {
      field: 'useMeditate',
      name: 'use-meditate',
      setting: 'automation.health.useMeditate',
      label: t('settings.health.useMeditate'),
      hint: t('settings.health.useMeditateHint')
    },
    {
      field: 'meditateFirst',
      name: 'meditate-first',
      setting: 'automation.health.meditateFirst',
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
  meditate,
  namePrefix,
  spells
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
              setting={row.setting}
              bar={barOf(typed, row.mana ? bands.mana : bands.hp)}
              {...(maxima === undefined ? {} : { figure: figureOf(typed, max ?? null) })}
              onChange={(value) => onChange(row.field, value)}
              value={values[row.field]}
            />
          );
        })}
      </div>
      {checks().map((row) => {
        const check = (
          <CheckField
            key={row.field}
            checked={checked[row.field]}
            hint={row.hint}
            label={row.label}
            name={`${namePrefix}${row.name}`}
            setting={row.setting}
            onChange={(value) => onCheck(row.field, value)}
          />
        );
        // Rest Next Door discloses the refill time it is judged on (todo 118).
        if (row.field !== 'restNextDoor' || !checked.restNextDoor) return check;
        return (
          <div className="settings-inline" key={row.field}>
            {check}
            <NumberField
              hint={t('settings.health.restNextDoorMinutesHint')}
              label={t('settings.health.restNextDoorMinutes')}
              name={`${namePrefix}rest-next-door-minutes`}
              setting="automation.health.restNextDoorMinutes"
              onChange={(value) => onChange('restNextDoorMinutes', value)}
              value={values.restNextDoorMinutes}
            />
          </div>
        );
      })}
      {meditate !== undefined && checked.useMeditate && (
        <p className="settings-note">{meditateSays(meditate)}</p>
      )}
      <div className="settings-inline">
        <SpellField
          hint={t('settings.health.restSpellHint')}
          label={t('settings.health.restSpell')}
          name={`${namePrefix}rest-spell`}
          setting="automation.health.restSpell"
          onChange={(value) => onChange('restSpell', value)}
          spells={spells}
          value={values.restSpell}
        />
      </div>
    </>
  );
}
