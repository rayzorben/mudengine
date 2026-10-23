import { fieldHintId } from './FormField';
import { Hint } from './Hint';
import Icon from './Icon';
import InheritedMobRules from './InheritedMobRules';
import NameCombo from './NameCombo';
import { SpellCombo } from './SpellPicker';
import { fractionOf, percentOf } from '../lib/form';
import { t } from '../lib/i18n';
import { TREATMENT_WORD } from '../lib/mobRuleWords';
import {
  isBanded,
  MOB_CAST_MOST,
  MOB_TREATMENTS,
  treated,
  type BandedRule,
  type MobRule,
  type MobRuleScope,
  type MobTreatment
} from '@shared/mobRules';
import { int } from '@shared/values';
import type { SpellOption } from '@shared/ipc';
import type { SettingPath } from '@shared/decisionSettings';

export interface MobRuleListProps {
  /** The setting the list edits whole, for a console line's gear (todo 119). */
  setting?: SettingPath;
  rows: readonly MobRule[];
  /**
   * The monsters the realm names, as suggestions rather than options
   * (`WorldGraph.mobNames`).
   *
   * Empty for a client with no realm loaded, and the field stays typable
   * either way — the same rule the potion picker follows. A derivative realm
   * names monsters the shipped data does not, and refusing to let somebody
   * write a rule for one would be the client overruling the player about their
   * own realm.
   */
  known: readonly string[];
  /** The spells a row's own attack spell is picked from; empty offers none, and typing works. */
  spells: readonly SpellOption[];
  /** Distinguishes the two forms' controls for the harnesses and for labels. */
  namePrefix: string;
  /** Whose list this is, and the realm beneath a character's: the rows it inherits are drawn under it (todo 817). */
  inherits: { scope: MobRuleScope; realm: string };
  onChange(rows: MobRule[]): void;
}

/**
 * *Leave that one alone; fight this one first* — the monster list, row by row.
 *
 * MegaMUD's **Attack Priority List** and its *avoid* list, as one control: a
 * monster, and one answer to *how is this treated*. It was two — a flat
 * comma-separated `avoid` field beside a five-band ranking — which asked the
 * player to hold one monster's settings in two places that merged by different
 * rules, the ranking per monster and the refusal wholesale (todo 104).
 *
 * **A band replaces the weighing rather than ranking against it.** Where a
 * listed monster is in the room the realm's arithmetic is not consulted at
 * all — see `CombatConfig.mobRules`. That is said in the open above the list
 * rather than behind a hint, because it is the one thing about this control
 * somebody could otherwise get wrong for a whole evening.
 *
 * A monster no row names is in `default`, which is why the list is a place to
 * add one row rather than a ranking of the realm. Every refusal still applies
 * before any band: a band says which of the monsters worth attacking to
 * attack, never that one is worth attacking.
 *
 * A banded row may also say how its monster is fought (todo 816): the spell
 * that opens on it and how many times it is cast, and no backstab; and that
 * it does not attack first (todo 818), which the Room and Reference cards
 * show beside the realm's disposition. A stance (`never`, `friend`, `escape`,
 * `hangup`) carries none of that, so choosing one takes them off (`treated`).
 */
export default function MobRuleList({
  setting,
  rows,
  known,
  spells,
  namePrefix,
  inherits,
  onChange
}: MobRuleListProps): React.JSX.Element {
  const replace = (index: number, row: MobRule) =>
    onChange(rows.map((entry, at) => (at === index ? row : entry)));

  /**
   * Whether an earlier row already names this monster.
   *
   * Unlike the potion rules, two rows for one monster are never deliberate: a
   * monster is treated exactly one way, so the second row is dead and the
   * normalizer drops it. Said here rather than silently discarded, because a
   * row that vanishes on the next load looks like the client losing an edit.
   */
  const duplicated = (index: number): boolean => {
    const row = rows[index]!;
    const name = row.mob.trim().toLowerCase();
    if (name.length === 0) return false;
    return rows.some((earlier, at) => at < index && earlier.mob.trim().toLowerCase() === name);
  };

  return (
    <div className="settings-list" data-setting={setting}>
      {rows.length > 0 && (
        <ul className="settings-steps settings-mob-rules">
          {rows.map((row, index) => (
            <li key={index}>
              <div className="mob-rule-line">
                <NameCombo
                  ariaLabel={t('settings.combat.mobRuleNameAria', { number: index + 1 })}
                  name={`${namePrefix}-${index}-mob`}
                  onChange={(value) => replace(index, { ...row, mob: value })}
                  options={known}
                  placeholder={t('settings.combat.mobRuleNamePlaceholder')}
                  value={row.mob}
                />
                <select
                  aria-label={t('settings.combat.mobRuleTreatAria', { number: index + 1 })}
                  name={`${namePrefix}-${index}-treat`}
                  onChange={(event) =>
                    replace(index, treated(row, event.target.value as MobTreatment))
                  }
                  value={row.treat}
                >
                  {MOB_TREATMENTS.map((treat) => (
                    <option key={treat} value={treat}>
                      {TREATMENT_WORD[treat]()}
                    </option>
                  ))}
                </select>
                <button
                  aria-label={t('settings.combat.mobRuleRemoveAria', { number: index + 1 })}
                  className="quiet"
                  onClick={() => onChange(rows.filter((_, at) => at !== index))}
                  title={t('settings.combat.mobRuleRemoveTitle')}
                  type="button"
                >
                  <Icon name="close" />
                </button>
              </div>
              {duplicated(index) && (
                <p className="settings-warn blessing-duplicate">
                  {t('settings.combat.mobRuleDuplicate')}
                </p>
              )}
              {isBanded(row) && (
                <div className="mob-rule-detail">
                  <SpellCombo
                    ariaLabel={t('settings.combat.mobRuleSpellAria', { number: index + 1 })}
                    name={`${namePrefix}-${index}-spell`}
                    onChange={(spell) =>
                      replace(index, { ...row, cast: { spell, times: row.cast?.times ?? 0 } })
                    }
                    placeholder={t('settings.combat.mobRuleSpellPlaceholder')}
                    spells={spells}
                    value={row.cast?.spell ?? ''}
                  />
                  <label>
                    <span>{t('settings.combat.mobRuleTimes')}</span>
                    <input
                      aria-label={t('settings.combat.mobRuleTimesAria', { number: index + 1 })}
                      className="number"
                      disabled={(row.cast?.spell ?? '').trim().length === 0}
                      inputMode="numeric"
                      name={`${namePrefix}-${index}-times`}
                      onChange={(event) =>
                        replace(index, {
                          ...row,
                          cast: {
                            spell: row.cast?.spell ?? '',
                            times: int(event.target.value, 0, 0, MOB_CAST_MOST)
                          }
                        })
                      }
                      value={row.cast?.times ?? 0}
                    />
                  </label>
                  <label className="blessing-check">
                    <input
                      checked={row.noBackstab === true}
                      name={`${namePrefix}-${index}-no-backstab`}
                      onChange={(event) =>
                        replace(index, { ...row, noBackstab: event.target.checked })
                      }
                      type="checkbox"
                    />
                    <span>{t('settings.combat.mobRuleNoBackstab')}</span>
                  </label>
                  <label className="blessing-check">
                    <input
                      aria-describedby={fieldHintId(`${namePrefix}-${index}-not-hostile`)}
                      checked={row.notHostile === true}
                      name={`${namePrefix}-${index}-not-hostile`}
                      onChange={(event) =>
                        replace(index, { ...row, notHostile: event.target.checked })
                      }
                      type="checkbox"
                    />
                    <span>{t('settings.combat.mobRuleNotHostile')}</span>
                    <Hint id={fieldHintId(`${namePrefix}-${index}-not-hostile`)}>
                      {t('settings.combat.mobRuleNotHostileHint')}
                    </Hint>
                  </label>
                  <label className="blessing-check">
                    <input
                      aria-describedby={fieldHintId(`${namePrefix}-${index}-stop-to-kill`)}
                      checked={row.stopToKill === true}
                      name={`${namePrefix}-${index}-stop-to-kill`}
                      onChange={(event) =>
                        replace(index, { ...row, stopToKill: event.target.checked })
                      }
                      type="checkbox"
                    />
                    <span>{t('settings.combat.mobRuleStopToKill')}</span>
                    <Hint id={fieldHintId(`${namePrefix}-${index}-stop-to-kill`)}>
                      {t('settings.combat.mobRuleStopToKillHint')}
                    </Hint>
                  </label>
                  <WaitField
                    field="waitHealth"
                    label={t('settings.combat.mobRuleWaitHealth')}
                    aria={t('settings.combat.mobRuleWaitHealthAria', { number: index + 1 })}
                    name={`${namePrefix}-${index}-wait-health`}
                    row={row}
                    onChange={(next) => replace(index, next)}
                  />
                  <WaitField
                    field="waitMana"
                    label={t('settings.combat.mobRuleWaitMana')}
                    aria={t('settings.combat.mobRuleWaitManaAria', { number: index + 1 })}
                    name={`${namePrefix}-${index}-wait-mana`}
                    row={row}
                    onChange={(next) => replace(index, next)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <button
        className="quiet add-step"
        onClick={() => onChange([...rows, { mob: '', treat: 'never' }])}
        type="button"
      >
        <Icon name="plus" />
        {t('settings.combat.mobRuleAdd')}
      </button>
      <InheritedMobRules
        namePrefix={namePrefix}
        onOverride={(row) => onChange([...rows, row])}
        own={rows}
        realm={inherits.realm}
        scope={inherits.scope}
      />
    </div>
  );
}

/**
 * A row's wait before its monster is opened on, as the whole percent a person
 * types (`waitHealth`, `waitMana`); 0 waits for nothing and drops the key.
 */
function WaitField({
  field,
  label,
  aria,
  name,
  row,
  onChange
}: {
  field: 'waitHealth' | 'waitMana';
  label: string;
  aria: string;
  name: string;
  row: BandedRule;
  onChange(row: BandedRule): void;
}): React.JSX.Element {
  return (
    <label>
      <span>{label}</span>
      <input
        aria-describedby={fieldHintId(name)}
        aria-label={aria}
        className="number"
        inputMode="numeric"
        name={name}
        onChange={(event) => {
          const share = fractionOf(event.target.value);
          const { [field]: _, ...rest } = row;
          onChange(share > 0 ? { ...rest, [field]: share } : rest);
        }}
        value={percentOf(row[field] ?? 0)}
      />
      <Hint id={fieldHintId(name)}>{t('settings.combat.mobRuleWaitHint')}</Hint>
    </label>
  );
}
