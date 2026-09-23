import Icon from './Icon';
import NameCombo from './NameCombo';
import { t } from '../lib/i18n';
import { MOB_TREATMENTS, type MobRule, type MobTreatment } from '@shared/config';

export interface MobRuleListProps {
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
  /** Distinguishes the two forms' controls for the harnesses and for labels. */
  namePrefix: string;
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
 */
export default function MobRuleList({
  rows,
  known,
  namePrefix,
  onChange
}: MobRuleListProps): React.JSX.Element {
  const update = (index: number, change: Partial<MobRule>) =>
    onChange(rows.map((entry, at) => (at === index ? { ...entry, ...change } : entry)));

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
    <>
      {rows.length > 0 && (
        <ul className="settings-steps settings-mob-rules">
          {rows.map((row, index) => (
            <li key={index}>
              <div className="mob-rule-line">
                <NameCombo
                  ariaLabel={t('settings.combat.mobRuleNameAria', { number: index + 1 })}
                  name={`${namePrefix}-${index}-mob`}
                  onChange={(value) => update(index, { mob: value })}
                  options={known}
                  placeholder={t('settings.combat.mobRuleNamePlaceholder')}
                  value={row.mob}
                />
                <select
                  aria-label={t('settings.combat.mobRuleTreatAria', { number: index + 1 })}
                  name={`${namePrefix}-${index}-treat`}
                  onChange={(event) => update(index, { treat: event.target.value as MobTreatment })}
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
    </>
  );
}

/**
 * One literal `t()` per treatment, never a key built from the value:
 * `i18n-coverage.test.ts` reads only the literal after `t(`, so a dynamic key
 * would be an unexempted dynamic call and six keys nothing is seen to read.
 */
const TREATMENT_WORD: Record<MobTreatment, () => string> = {
  never: () => t('settings.combat.mobRuleNever'),
  first: () => t('settings.combat.mobRuleFirst'),
  high: () => t('settings.combat.mobRuleHigh'),
  default: () => t('settings.combat.mobRuleDefault'),
  low: () => t('settings.combat.mobRuleLow'),
  last: () => t('settings.combat.mobRuleLast')
};
