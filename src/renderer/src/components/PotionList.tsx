import Icon from './Icon';
import NameCombo from './NameCombo';
import { t } from '../lib/i18n';
import { POTION_VERBS, POTION_WHENS, type PotionRule } from '@shared/config';
import type { WardRule } from '@shared/world';

export interface PotionListProps {
  potions: readonly PotionRule[];
  /**
   * What the name field offers per condition: the items the **realm** says
   * would serve it (`WorldGraph.itemsServing`). Keyed by the condition, so a
   * row set to *poisoned* offers the antidotes and not the healing potions.
   *
   * Empty for a condition the realm names nothing for, and for a client with
   * no realm loaded — and the field stays typable either way, because the
   * realm's list is a help rather than a gate: a derivative realm may hold an
   * item the shipped data does not, and refusing to let somebody name it
   * would be the client overruling the player about their own pack.
   */
  serving: Partial<Record<PotionRule['when'], readonly string[]>>;
  /** Distinguishes the two forms' controls for the harnesses and for labels. */
  namePrefix: string;
  onChange(potions: PotionRule[]): void;
}

/** The conditions that take a threshold; the rest are facts, not percentages. */
const MEASURED = new Set<PotionRule['when']>(['hp', 'mana']);

/**
 * *Use this item when that is true* — the potion rules, row by row (todo 19).
 *
 * MegaMUD had one potion row beside *Heal if below* and this client had two:
 * health and mana. Neither could say *drink the antidote the moment I am
 * poisoned*, or *use the second healing potion at 15% as well as the first at
 * 40%*. This is that list, in `BlessingList`'s row idiom — a row per rule, a
 * remove glyph on each, one add button under the lot.
 *
 * **The name field is filtered by the condition**, which is the whole reason
 * it is a realm query rather than a text box: `cure poison potion` casts a
 * spell the realm calls `violet potion`, and no reading of the two names says
 * they are the same fact. A list for *poisoned* holding a healing potion would
 * be offering a choice that cannot work.
 *
 * **A threshold is drawn only where one means something.** Being poisoned is
 * not a percentage, so the field is absent on a condition row rather than
 * greyed: a number nothing reads is a control that does nothing.
 */
export default function PotionList({ potions, serving, namePrefix, onChange }: PotionListProps) {
  const update = (index: number, change: Partial<PotionRule>) =>
    onChange(potions.map((entry, at) => (at === index ? { ...entry, ...change } : entry)));

  /**
   * Whether an earlier row already says this item at this condition *and* this
   * depth. Two rules on one potion at two depths are deliberate — that is the
   * case this list exists for — so the threshold is part of the test.
   */
  const duplicated = (index: number): boolean => {
    const row = potions[index]!;
    if (row.name.trim().length === 0) return false;
    return potions.some(
      (earlier, at) =>
        at < index &&
        earlier.when === row.when &&
        earlier.below === row.below &&
        earlier.name.trim().toLowerCase() === row.name.trim().toLowerCase()
    );
  };

  return (
    <>
      {potions.length > 0 && (
        <ul className="settings-steps settings-potions">
          {potions.map((rule, index) => (
            <li key={index}>
              <div className="blessing-line">
                {/* The realm's own list for this condition, as suggestions
                    rather than options: a realm the client does not hold, or
                    a derivative that ships an item the shipped data lacks,
                    must still be nameable. Drawn by the client's own picker
                    rather than a native `<datalist>` (todo 00), which the
                    browser paints in its own chrome — white rows in a dark
                    client, in the browser's font, cut off at a length the
                    page does not choose and unscrollable past it. */}
                <NameCombo
                  ariaLabel={t('settings.health.potionRuleNameAria', { number: index + 1 })}
                  name={`${namePrefix}-${index}-name`}
                  onChange={(value) => update(index, { name: value })}
                  options={serving[rule.when] ?? []}
                  placeholder={t('settings.health.potionRuleNamePlaceholder')}
                  value={rule.name}
                />
                <select
                  aria-label={t('settings.health.potionRuleWhenAria', { number: index + 1 })}
                  name={`${namePrefix}-${index}-when`}
                  onChange={(event) => {
                    const when = event.target.value as PotionRule['when'];
                    update(index, {
                      when,
                      // A threshold means nothing on a condition row, and a
                      // stale one left behind would be read by nothing and
                      // written back on the next save.
                      below: MEASURED.has(when) ? rule.below : 0
                    });
                  }}
                  value={rule.when}
                >
                  {POTION_WHENS.map((when) => (
                    <option key={when} value={when}>
                      {WHEN_WORD[when]()}
                    </option>
                  ))}
                </select>
                {MEASURED.has(rule.when) && (
                  <label>
                    <span>{t('settings.health.potionRuleBelow')}</span>
                    <input
                      aria-label={t('settings.health.potionRuleBelowAria', { number: index + 1 })}
                      className="number"
                      inputMode="numeric"
                      name={`${namePrefix}-${index}-below`}
                      onChange={(event) =>
                        update(index, {
                          below: Math.min(
                            1,
                            Math.max(0, (Number.parseInt(event.target.value, 10) || 0) / 100)
                          )
                        })
                      }
                      value={Math.round(rule.below * 100)}
                    />
                  </label>
                )}
                <select
                  aria-label={t('settings.health.potionRuleVerbAria', { number: index + 1 })}
                  name={`${namePrefix}-${index}-verb`}
                  onChange={(event) =>
                    update(index, { verb: event.target.value === 'use' ? 'use' : 'drink' })
                  }
                  value={rule.verb}
                >
                  {POTION_VERBS.map((verb) => (
                    <option key={verb} value={verb}>
                      {verb}
                    </option>
                  ))}
                </select>
                <button
                  aria-label={t('settings.health.potionRuleRemoveAria', { number: index + 1 })}
                  className="quiet"
                  onClick={() => onChange(potions.filter((_, at) => at !== index))}
                  title={t('settings.health.potionRuleRemoveTitle')}
                  type="button"
                >
                  <Icon name="close" />
                </button>
              </div>
              {duplicated(index) && (
                <p className="settings-warn blessing-duplicate">
                  {t('settings.health.potionRuleDuplicate')}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <button
        className="quiet add-step"
        onClick={() => onChange([...potions, { name: '', when: 'hp', below: 0.3, verb: 'drink' }])}
        type="button"
      >
        <Icon name="plus" />
        {t('settings.health.potionRuleAdd')}
      </button>
    </>
  );
}

/**
 * One literal `t()` per condition, never a key built from the value:
 * `i18n-coverage.test.ts` reads only the literal after `t(`, so a dynamic key
 * would be an unexempted dynamic call and six keys nothing is seen to read.
 */
const WHEN_WORD: Record<PotionRule['when'], () => string> = {
  hp: () => t('settings.health.potionWhenHp'),
  mana: () => t('settings.health.potionWhenMana'),
  poisoned: () => t('settings.health.potionWhenPoisoned'),
  blind: () => t('settings.health.potionWhenBlind'),
  diseased: () => t('settings.health.potionWhenDiseased'),
  held: () => t('settings.health.potionWhenHeld')
};

/**
 * The realm's own rows of the same list: *use this item where that spell is
 * cast* (todo 02).
 *
 * Read-only, because nobody wrote them. The realm says which spell stops a
 * room's own effect and which item's use casts it, so there is nothing to
 * type — but a switch over rules nobody can read is the invisible setting
 * this project refuses everywhere else, and the desert is 945 rooms of a
 * realm somebody is about to walk into. So they are drawn: the item, the
 * room spell it answers, and how many rooms cast it.
 *
 * Nothing at all where the realm names none, which is also the answer for a
 * client with no world loaded. The switch above still says what it does.
 */
export function WardRules({ rules }: { rules: readonly WardRule[] }) {
  if (rules.length === 0) return null;
  return (
    <ul className="ward-rules">
      {rules.map((rule) => (
        <li key={`${rule.item}/${rule.hazard}`}>
          <span className="ward-item">{rule.item}</span>
          <span className="ward-because">
            {/* Two literal calls, as every plural pair here is. */}
            {rule.rooms === 1
              ? t('settings.health.wardRow.one', { hazard: rule.hazard, rooms: rule.rooms })
              : t('settings.health.wardRow.many', { hazard: rule.hazard, rooms: rule.rooms })}
          </span>
        </li>
      ))}
    </ul>
  );
}
