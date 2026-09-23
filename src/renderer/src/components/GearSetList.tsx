import Icon from './Icon';
import NameCombo from './NameCombo';
import { t } from '../lib/i18n';
import { GEAR_WHENS, type GearSet, type GearWhen } from '@shared/gear';

export interface GearSetListProps {
  sets: readonly GearSet[];
  /**
   * The monsters this character's realm names, for the `mob` field on a
   * fighting row. Suggestions rather than options, like every other realm
   * list on this screen: a derivative may hold a monster the shipped data
   * lacks, and the field stays typable.
   */
  mobs: readonly string[];
  /** Distinguishes the two forms' controls for the harnesses and for labels. */
  namePrefix: string;
  onChange(sets: GearSet[]): void;
}

/**
 * The equipment sets — *this kit, in that situation* (todo 00).
 *
 * A row is a kit: what to call it, when it applies, and the items it names.
 * **Partial on purpose**, which is what the list's shape has to make obvious:
 * a set is a few lines about boots, not a second copy of everything the
 * character owns, and what it does not name is left as the `always` set has
 * it. So the items are their own inner list with their own add button rather
 * than one comma-separated field — the same reason the monster rules stopped
 * being a comma field.
 *
 * The `mob` field is drawn **only on a fighting row**, because that is the
 * only place it decides anything: a set that applies while walking cannot be
 * narrowed to a monster, and a control that does nothing is worse than an
 * absent one.
 */
export default function GearSetList({ sets, mobs, namePrefix, onChange }: GearSetListProps) {
  const update = (index: number, change: Partial<GearSet>): void =>
    onChange(sets.map((set, at) => (at === index ? { ...set, ...change } : set)));

  const wearAt = (index: number, at: number, value: string): void => {
    const set = sets[index];
    if (set === undefined) return;
    update(index, { wear: set.wear.map((item, each) => (each === at ? value : item)) });
  };

  /**
   * Whether an earlier row already claims this situation.
   *
   * `overlayFor` takes the first of two equal matches, so a second one is a
   * row that will never apply — said here rather than left to be discovered
   * by a kit that does not change.
   */
  const shadowed = (index: number): boolean => {
    const row = sets[index];
    if (row === undefined) return false;
    return sets.some(
      (earlier, at) =>
        at < index &&
        earlier.when === row.when &&
        earlier.mob.trim().toLowerCase() === row.mob.trim().toLowerCase()
    );
  };

  return (
    <>
      {sets.length > 0 && (
        <ul className="settings-steps gear-sets">
          {sets.map((set, index) => (
            <li key={index}>
              <div className="blessing-line">
                <input
                  aria-label={t('settings.gear.setNameAria', { number: index + 1 })}
                  name={`${namePrefix}-${index}-name`}
                  onChange={(event) => update(index, { name: event.target.value })}
                  placeholder={t('settings.gear.setNamePlaceholder')}
                  value={set.name}
                />
                <select
                  aria-label={t('settings.gear.setWhenAria', { number: index + 1 })}
                  name={`${namePrefix}-${index}-when`}
                  onChange={(event) => {
                    const when = event.target.value as GearWhen;
                    // A monster means nothing off a fighting row, and a stale
                    // one left behind would be read by nothing and written
                    // back on the next save.
                    update(index, { when, mob: when === 'fighting' ? set.mob : '' });
                  }}
                  value={set.when}
                >
                  {GEAR_WHENS.map((when) => (
                    <option key={when} value={when}>
                      {WHEN_WORD[when]()}
                    </option>
                  ))}
                </select>
                {set.when === 'fighting' && (
                  <NameCombo
                    ariaLabel={t('settings.gear.setMobAria', { number: index + 1 })}
                    name={`${namePrefix}-${index}-mob`}
                    onChange={(value) => update(index, { mob: value })}
                    options={mobs}
                    placeholder={t('settings.gear.setMobPlaceholder')}
                    value={set.mob}
                  />
                )}
                <button
                  aria-label={t('settings.gear.setRemoveAria', { number: index + 1 })}
                  className="quiet"
                  onClick={() => onChange(sets.filter((_, at) => at !== index))}
                  title={t('settings.gear.setRemoveTitle')}
                  type="button"
                >
                  <Icon name="close" />
                </button>
              </div>
              {shadowed(index) && (
                <p className="settings-warn blessing-duplicate">{t('settings.gear.setShadowed')}</p>
              )}
              <ul className="settings-steps gear-items">
                {set.wear.map((item, at) => (
                  <li key={at}>
                    <div className="blessing-line">
                      <input
                        aria-label={t('settings.gear.itemAria', {
                          number: index + 1,
                          item: at + 1
                        })}
                        name={`${namePrefix}-${index}-wear-${at}`}
                        onChange={(event) => wearAt(index, at, event.target.value)}
                        placeholder={t('settings.gear.itemPlaceholder')}
                        value={item}
                      />
                      <button
                        aria-label={t('settings.gear.itemRemoveAria', {
                          number: index + 1,
                          item: at + 1
                        })}
                        className="quiet"
                        onClick={() =>
                          update(index, { wear: set.wear.filter((_, each) => each !== at) })
                        }
                        title={t('settings.gear.itemRemoveTitle')}
                        type="button"
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <button
                className="quiet add-step"
                onClick={() => update(index, { wear: [...set.wear, ''] })}
                type="button"
              >
                <Icon name="plus" />
                {t('settings.gear.itemAdd')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        className="quiet add-step"
        onClick={() => onChange([...sets, { name: '', when: 'always', mob: '', wear: [''] }])}
        type="button"
      >
        <Icon name="plus" />
        {t('settings.gear.setAdd')}
      </button>
    </>
  );
}

/**
 * One literal `t()` per situation, never a key built from the value:
 * `i18n-coverage.test.ts` reads only the literal after `t(`, so a dynamic key
 * would be an unexempted dynamic call and three keys nothing is seen to read.
 */
const WHEN_WORD: Record<GearWhen, () => string> = {
  always: () => t('settings.gear.whenAlways'),
  moving: () => t('settings.gear.whenMoving'),
  fighting: () => t('settings.gear.whenFighting')
};
