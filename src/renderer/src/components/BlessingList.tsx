import Icon from './Icon';
import { SpellCombo } from './SpellPicker';
import { t } from '../lib/i18n';
import type { BlessingDraft } from '@shared/drafts';
import type { SpellOption } from '@shared/ipc';

export interface BlessingListProps {
  blessings: readonly BlessingDraft[];
  /** What the spell picker offers — the character's book, or the realm's list on the Global page. */
  spells: readonly SpellOption[];
  /** Distinguishes the two forms' controls for the harnesses and for labels. */
  namePrefix: string;
  onChange(blessings: BlessingDraft[]): void;
}

/**
 * The blessings a character keeps up, as a list somebody edits row by row.
 *
 * Written once and drawn by both settings forms, for the reason the `@`
 * permission grid is: a list that read one way on the Global page and another
 * on a character's is one somebody sets in whichever place happens to be
 * wrong. The row idiom is the login-steps editor's — a row per entry, a
 * remove glyph on each, one add button under the lot — with two lines per
 * row, because a blessing carries more than a menu answer does.
 *
 * **One field names the spell, and it is the row.** The first version had a
 * display-name box beside a spell box, and the first person to use it typed
 * the spell into the name box, read the spell box's placeholder as content,
 * and lost the row to the silent no-spell filter on save. Two words for one
 * thing is a form that invites exactly that.
 *
 * **The order is the priority**: when several blessings are down, the top
 * one is recast first, which is why each row carries the up and down arrows
 * the login steps do not need. Percentages on screen, fractions in the
 * draft, like every threshold field. The recast clock is drawn only on a
 * party row — a self blessing recasts on the wear-off frame, with a watchdog
 * measured from earlier casts, and a field for a number the client refuses
 * to use would be a control that does nothing.
 */
export default function BlessingList({
  blessings,
  spells,
  namePrefix,
  onChange
}: BlessingListProps) {
  const update = (index: number, change: Partial<BlessingDraft>) =>
    onChange(blessings.map((entry, at) => (at === index ? { ...entry, ...change } : entry)));

  /**
   * Whether an earlier row already says this spell at this target. The parse
   * keeps only the first such row, and a silent drop at save is precisely
   * the failure this list's first shipped form had — so the duplicate says
   * so where it is being typed, not on the next launch.
   */
  const duplicated = (index: number): boolean => {
    const row = blessings[index]!;
    if (row.spell.trim().length === 0) return false;
    return blessings.some(
      (earlier, at) =>
        at < index &&
        earlier.target === row.target &&
        earlier.spell.trim().toLowerCase() === row.spell.trim().toLowerCase()
    );
  };

  const move = (index: number, delta: -1 | 1) => {
    const to = index + delta;
    if (to < 0 || to >= blessings.length) return;
    const next = [...blessings];
    const [row] = next.splice(index, 1);
    next.splice(to, 0, row!);
    onChange(next);
  };

  return (
    <>
      {blessings.length > 0 && (
        <ul className="settings-steps settings-blessings">
          {blessings.map((blessing, index) => (
            <li key={index}>
              <div className="blessing-line">
                <span className="blessing-order">
                  <button
                    aria-label={t('settings.spells.blessingUpAria', { number: index + 1 })}
                    className="quiet"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    title={t('settings.spells.blessingUpTitle')}
                    type="button"
                  >
                    <Icon name="chevronUp" />
                  </button>
                  <button
                    aria-label={t('settings.spells.blessingDownAria', { number: index + 1 })}
                    className="quiet"
                    disabled={index === blessings.length - 1}
                    onClick={() => move(index, 1)}
                    title={t('settings.spells.blessingDownTitle')}
                    type="button"
                  >
                    <Icon name="chevronDown" />
                  </button>
                </span>
                <SpellCombo
                  ariaLabel={t('settings.spells.blessingSpellAria', { number: index + 1 })}
                  name={`${namePrefix}-${index}-spell`}
                  onChange={(spell) => update(index, { spell })}
                  placeholder={t('settings.spells.pickerPlaceholder')}
                  spells={spells}
                  value={blessing.spell}
                />
                <select
                  aria-label={t('settings.spells.blessingTargetAria', { number: index + 1 })}
                  name={`${namePrefix}-${index}-target`}
                  onChange={(event) => {
                    const party = event.target.value === 'party';
                    update(index, {
                      target: party ? 'party' : 'self',
                      // The default follows the target, as it does in the
                      // options file: flipping to party must not silently keep
                      // a mid-fight cast on somebody else's round — and a row
                      // becoming a party one needs the clock a self row does
                      // not carry.
                      inCombat: !party,
                      fallbackSeconds: party ? (blessing.fallbackSeconds ?? 300) : undefined
                    });
                  }}
                  value={blessing.target}
                >
                  <option value="self">{t('settings.spells.blessingTargetSelf')}</option>
                  <option value="party">{t('settings.spells.blessingTargetParty')}</option>
                </select>
                <button
                  aria-label={t('settings.spells.removeBlessingAria', { number: index + 1 })}
                  className="quiet"
                  onClick={() => onChange(blessings.filter((_, at) => at !== index))}
                  title={t('settings.spells.removeBlessingTitle')}
                  type="button"
                >
                  <Icon name="close" />
                </button>
              </div>
              {duplicated(index) && (
                <p className="settings-warn blessing-duplicate">
                  {t('settings.spells.blessingDuplicate')}
                </p>
              )}
              <div className="blessing-line blessing-detail">
                <label>
                  <span>{t('settings.spells.blessingMinMana')}</span>
                  <input
                    aria-label={t('settings.spells.blessingMinManaAria', { number: index + 1 })}
                    className="number"
                    inputMode="numeric"
                    name={`${namePrefix}-${index}-mana`}
                    onChange={(event) =>
                      update(index, {
                        minMana: Math.min(
                          1,
                          Math.max(0, (Number.parseInt(event.target.value, 10) || 0) / 100)
                        )
                      })
                    }
                    value={Math.round(blessing.minMana * 100)}
                  />
                </label>
                {blessing.target === 'party' && (
                  <label>
                    <span>{t('settings.spells.blessingFallback')}</span>
                    <input
                      aria-label={t('settings.spells.blessingFallbackAria', {
                        number: index + 1
                      })}
                      className="number"
                      inputMode="numeric"
                      name={`${namePrefix}-${index}-fallback`}
                      onChange={(event) =>
                        update(index, {
                          fallbackSeconds: Number.parseInt(event.target.value, 10) || 0
                        })
                      }
                      value={blessing.fallbackSeconds || ''}
                    />
                  </label>
                )}
                <label className="blessing-check">
                  <input
                    checked={blessing.inCombat}
                    name={`${namePrefix}-${index}-in-combat`}
                    onChange={(event) => update(index, { inCombat: event.target.checked })}
                    type="checkbox"
                  />
                  <span>{t('settings.spells.blessingInCombat')}</span>
                </label>
                <label className="blessing-check">
                  <input
                    checked={blessing.prioritizeOverHeal}
                    name={`${namePrefix}-${index}-over-heal`}
                    onChange={(event) =>
                      update(index, { prioritizeOverHeal: event.target.checked })
                    }
                    type="checkbox"
                  />
                  <span>{t('settings.spells.blessingOverHeal')}</span>
                </label>
              </div>
            </li>
          ))}
        </ul>
      )}
      <button
        className="quiet add-step"
        onClick={() =>
          onChange([
            ...blessings,
            {
              spell: '',
              target: 'self',
              minMana: 0,
              prioritizeOverHeal: false,
              inCombat: true
            }
          ])
        }
        type="button"
      >
        <Icon name="plus" />
        <span>{t('settings.spells.addBlessing')}</span>
      </button>
    </>
  );
}
