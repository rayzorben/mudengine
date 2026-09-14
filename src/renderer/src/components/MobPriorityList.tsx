import Icon from './Icon';
import NameCombo from './NameCombo';
import { t } from '../lib/i18n';
import { MOB_PRIORITIES, type MobPriority, type MobPriorityBand } from '@shared/config';

export interface MobPriorityListProps {
  rows: readonly MobPriority[];
  /**
   * The monsters the realm names, as suggestions rather than options
   * (`WorldGraph.mobNames`).
   *
   * Empty for a client with no realm loaded, and the field stays typable
   * either way — the same rule the potion picker follows. A derivative realm
   * names monsters the shipped data does not, and refusing to let somebody
   * rank one would be the client overruling the player about their own realm.
   */
  known: readonly string[];
  /** Distinguishes the two forms' controls for the harnesses and for labels. */
  namePrefix: string;
  onChange(rows: MobPriority[]): void;
}

/**
 * *Fight this one first* — the mob priority list, row by row (todo 01).
 *
 * MegaMUD's **Attack Priority List**, which this client had as `combat.prefer`
 * until todo 00 removed it: a flat list a name was either on or not. Five
 * bands instead, because what somebody means by *kill the shamans first* is a
 * rank, and a rank with two positions cannot say *and the rats last*.
 *
 * **The band replaces the weighing rather than ranking against it.** Where a
 * listed monster is in the room the realm's arithmetic is not consulted at
 * all — see `CombatConfig.mobPriority`. That is said in the open above the
 * list rather than behind a hint, because it is the one thing about this
 * control somebody could otherwise get wrong for a whole evening.
 *
 * A monster no row names is in `default`, which is why the list is a place to
 * add one row rather than a ranking of the realm. Every refusal still applies
 * first: this says which of the monsters worth attacking to attack, never
 * that one is worth attacking.
 */
export default function MobPriorityList({
  rows,
  known,
  namePrefix,
  onChange
}: MobPriorityListProps): React.JSX.Element {
  const update = (index: number, change: Partial<MobPriority>) =>
    onChange(rows.map((entry, at) => (at === index ? { ...entry, ...change } : entry)));

  /**
   * Whether an earlier row already ranks this monster.
   *
   * Unlike the potion rules, two rows for one monster are never deliberate:
   * a monster is in exactly one band, so the second row is dead and the
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
        <ul className="settings-steps settings-priorities">
          {rows.map((row, index) => (
            <li key={index}>
              <div className="priority-line">
                <NameCombo
                  ariaLabel={t('settings.combat.priorityNameAria', { number: index + 1 })}
                  name={`${namePrefix}-${index}-mob`}
                  onChange={(value) => update(index, { mob: value })}
                  options={known}
                  placeholder={t('settings.combat.priorityNamePlaceholder')}
                  value={row.mob}
                />
                <select
                  aria-label={t('settings.combat.priorityBandAria', { number: index + 1 })}
                  name={`${namePrefix}-${index}-priority`}
                  onChange={(event) =>
                    update(index, { priority: event.target.value as MobPriorityBand })
                  }
                  value={row.priority}
                >
                  {MOB_PRIORITIES.map((band) => (
                    <option key={band} value={band}>
                      {BAND_WORD[band]()}
                    </option>
                  ))}
                </select>
                <button
                  aria-label={t('settings.combat.priorityRemoveAria', { number: index + 1 })}
                  className="quiet"
                  onClick={() => onChange(rows.filter((_, at) => at !== index))}
                  title={t('settings.combat.priorityRemoveTitle')}
                  type="button"
                >
                  <Icon name="close" />
                </button>
              </div>
              {duplicated(index) && (
                <p className="settings-warn blessing-duplicate">
                  {t('settings.combat.priorityDuplicate')}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <button
        className="quiet add-step"
        onClick={() => onChange([...rows, { mob: '', priority: 'first' }])}
        type="button"
      >
        <Icon name="plus" />
        {t('settings.combat.priorityAdd')}
      </button>
    </>
  );
}

/**
 * One literal `t()` per band, never a key built from the value:
 * `i18n-coverage.test.ts` reads only the literal after `t(`, so a dynamic key
 * would be an unexempted dynamic call and five keys nothing is seen to read.
 */
const BAND_WORD: Record<MobPriorityBand, () => string> = {
  first: () => t('settings.combat.priorityFirst'),
  high: () => t('settings.combat.priorityHigh'),
  default: () => t('settings.combat.priorityDefault'),
  low: () => t('settings.combat.priorityLow'),
  last: () => t('settings.combat.priorityLast')
};
