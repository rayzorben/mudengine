import Icon from './Icon';
import { t } from '../lib/i18n';
import {
  ALERT_SIDES,
  ALERT_WATCHES,
  alertIsCash,
  alertIsMeasured,
  alertIsNamed,
  NOTICE_CHANNELS,
  SEVERITIES,
  type AlertRule,
  type NoticeChannel
} from '@shared/notifications';

export interface AlertListProps {
  rules: readonly AlertRule[];
  /** Distinguishes the two forms' controls for the harnesses and for labels. */
  namePrefix: string;
  onChange(rules: AlertRule[]): void;
}

/**
 * The player's alert rows, edited one at a time (todo 29, 2026-09-12).
 *
 * `BlessingList`'s row idiom — a row each, a remove glyph on every one, one add
 * button under the lot, and the up and down arrows a priority list needs.
 *
 * **Order is the rule and the arrows are how it is said.** The first enabled
 * row that claims a notice decides it, so a quiet blanket row at the bottom
 * with a loud specific one above it is a thing somebody can now write. Without
 * the arrows that order would be the order rows happened to be added in, which
 * is not an order anybody chose.
 *
 * **A control is drawn only where it means something.** A figure belongs to the
 * two rows that are numbers, a name to the two that are names, and *even when
 * the window is in front* to a row that raises a notification at all — the
 * todo asks for that last one explicitly, and a checkbox nothing reads is a
 * control that does nothing.
 */
export default function AlertList({ rules, namePrefix, onChange }: AlertListProps) {
  const update = (index: number, change: Partial<AlertRule>) =>
    onChange(rules.map((entry, at) => (at === index ? { ...entry, ...change } : entry)));

  const move = (index: number, delta: -1 | 1) => {
    const to = index + delta;
    if (to < 0 || to >= rules.length) return;
    const next = [...rules];
    const [row] = next.splice(index, 1);
    next.splice(to, 0, row!);
    onChange(next);
  };

  /**
   * Whether an earlier enabled row already claims everything this one would.
   * The first match wins, so a row under one naming the same thing can never
   * fire — and a row that does nothing should say so where it is typed, not be
   * discovered later.
   */
  const shadowed = (index: number): boolean =>
    rules.some((earlier, at) => at < index && earlier.enabled && earlier.on === rules[index]!.on);

  return (
    <>
      {rules.length > 0 && (
        <ul className="settings-steps settings-alerts">
          {rules.map((rule, index) => (
            <li key={index}>
              <div className="blessing-line">
                <span className="blessing-order">
                  <button
                    aria-label={t('settings.alerts.ruleUpAria', { number: index + 1 })}
                    className="quiet"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    title={t('settings.alerts.ruleUpTitle')}
                    type="button"
                  >
                    <Icon name="chevronUp" />
                  </button>
                  <button
                    aria-label={t('settings.alerts.ruleDownAria', { number: index + 1 })}
                    className="quiet"
                    disabled={index === rules.length - 1}
                    onClick={() => move(index, 1)}
                    title={t('settings.alerts.ruleDownTitle')}
                    type="button"
                  >
                    <Icon name="chevronDown" />
                  </button>
                </span>
                <label className="blessing-check">
                  <input
                    checked={rule.enabled}
                    name={`${namePrefix}-${index}-enabled`}
                    onChange={(event) => update(index, { enabled: event.target.checked })}
                    type="checkbox"
                  />
                  <span>{t('settings.alerts.ruleEnabled')}</span>
                </label>
                <select
                  aria-label={t('settings.alerts.ruleOnAria', { number: index + 1 })}
                  name={`${namePrefix}-${index}-on`}
                  onChange={(event) => update(index, { on: event.target.value as AlertRule['on'] })}
                  value={rule.on}
                >
                  <optgroup label={t('settings.alerts.groupWatches')}>
                    {ALERT_WATCHES.map((watch) => (
                      <option key={watch} value={watch}>
                        {WATCH_WORD[watch]()}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label={t('settings.alerts.groupChannels')}>
                    {NOTICE_CHANNELS.map((channel) => (
                      <option key={channel} value={channel}>
                        {CHANNEL_WORD[channel]}
                      </option>
                    ))}
                  </optgroup>
                </select>
                {alertIsMeasured(rule.on) && (
                  <>
                    <select
                      aria-label={t('settings.alerts.ruleSideAria', { number: index + 1 })}
                      name={`${namePrefix}-${index}-side`}
                      onChange={(event) =>
                        update(index, { side: event.target.value as AlertRule['side'] })
                      }
                      value={rule.side}
                    >
                      {ALERT_SIDES.map((side) => (
                        <option key={side} value={side}>
                          {side === 'below'
                            ? t('settings.alerts.sideBelow')
                            : t('settings.alerts.sideAbove')}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label={t('settings.alerts.ruleValueAria', { number: index + 1 })}
                      className="number"
                      inputMode="numeric"
                      name={`${namePrefix}-${index}-value`}
                      onChange={(event) =>
                        update(index, { value: Math.max(0, Number(event.target.value) || 0) })
                      }
                      value={rule.value}
                    />
                    {/* The `%` is the setting, not decoration: *below 60%* and
                        *below 100 hit points* are both things somebody says,
                        and which they meant is not guessable from the number. */}
                    <label className="blessing-check">
                      <input
                        checked={rule.percent}
                        name={`${namePrefix}-${index}-percent`}
                        onChange={(event) => update(index, { percent: event.target.checked })}
                        type="checkbox"
                      />
                      <span>{t('settings.alerts.rulePercent')}</span>
                    </label>
                  </>
                )}
                {/*
                  The cash watch is a figure like health, and not one: there is
                  no maximum to be a share of and no *above* to fire on, so it
                  takes the number alone with no side and no per-cent box. It
                  was `ui.alerts.finds.cashOverCopper` until the rows became the
                  only place alerts are set (todo 02).
                */}
                {alertIsCash(rule.on) && (
                  <input
                    aria-label={t('settings.alerts.ruleValueAria', { number: index + 1 })}
                    className="number"
                    inputMode="numeric"
                    name={`${namePrefix}-${index}-value`}
                    onChange={(event) =>
                      update(index, { value: Math.max(0, Number(event.target.value) || 0) })
                    }
                    value={rule.value}
                  />
                )}
                {alertIsNamed(rule.on) && (
                  <input
                    aria-label={t('settings.alerts.ruleNameAria', { number: index + 1 })}
                    name={`${namePrefix}-${index}-name`}
                    onChange={(event) => update(index, { name: event.target.value })}
                    placeholder={t('settings.alerts.ruleNamePlaceholder')}
                    spellCheck={false}
                    value={rule.name}
                  />
                )}
                <button
                  aria-label={t('settings.alerts.ruleRemoveAria', { number: index + 1 })}
                  className="quiet"
                  onClick={() => onChange(rules.filter((_, at) => at !== index))}
                  title={t('settings.alerts.ruleRemoveTitle')}
                  type="button"
                >
                  <Icon name="close" />
                </button>
              </div>
              {shadowed(index) && (
                <p className="settings-warn blessing-duplicate">
                  {t('settings.alerts.ruleShadowed')}
                </p>
              )}
              <div className="blessing-line blessing-detail">
                <label>
                  <span>{t('settings.alerts.ruleLevel')}</span>
                  <select
                    aria-label={t('settings.alerts.ruleLevelAria', { number: index + 1 })}
                    name={`${namePrefix}-${index}-level`}
                    onChange={(event) =>
                      update(index, {
                        level: event.target.value === '' ? null : (event.target.value as never)
                      })
                    }
                    value={rule.level ?? ''}
                  >
                    {/* Empty is *keep what the client decided*, which is the
                        default: what a line costs is a fact about the realm. */}
                    <option value="">{t('settings.alerts.levelKeep')}</option>
                    {SEVERITIES.map((severity) => (
                      <option key={severity} value={severity}>
                        {severity}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="blessing-check">
                  <input
                    checked={rule.alert}
                    name={`${namePrefix}-${index}-alert`}
                    onChange={(event) => update(index, { alert: event.target.checked })}
                    type="checkbox"
                  />
                  <span>{t('settings.alerts.ruleAlert')}</span>
                </label>
                <label className="blessing-check">
                  <input
                    checked={rule.notify}
                    name={`${namePrefix}-${index}-notify`}
                    onChange={(event) =>
                      update(index, {
                        notify: event.target.checked,
                        // The one below means nothing without this, so it goes
                        // with it rather than being left behind, set, on a row
                        // that no longer notifies.
                        ...(event.target.checked ? {} : { whileFocused: false })
                      })
                    }
                    type="checkbox"
                  />
                  <span>{t('settings.alerts.ruleNotify')}</span>
                </label>
                {/* Disabled rather than hidden while notifications are off,
                    which is what the todo asks for: the option is part of what
                    the row can say, and hiding it would make it look absent. */}
                <label className="blessing-check">
                  <input
                    checked={rule.whileFocused}
                    disabled={!rule.notify}
                    name={`${namePrefix}-${index}-while-focused`}
                    onChange={(event) => update(index, { whileFocused: event.target.checked })}
                    type="checkbox"
                  />
                  <span>{t('settings.alerts.ruleWhileFocused')}</span>
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
            ...rules,
            {
              on: 'health',
              enabled: true,
              level: null,
              alert: true,
              notify: false,
              whileFocused: false,
              side: 'below',
              value: 50,
              percent: true,
              name: ''
            }
          ])
        }
        type="button"
      >
        <Icon name="plus" />
        {t('settings.alerts.ruleAdd')}
      </button>
    </>
  );
}

/**
 * One literal `t()` per watch, never a key built from the value:
 * `i18n-coverage.test.ts` reads only the literal after `t(`.
 */
const WATCH_WORD: Record<(typeof ALERT_WATCHES)[number], () => string> = {
  health: () => t('settings.alerts.watchHealth'),
  mana: () => t('settings.alerts.watchMana'),
  attacked: () => t('settings.alerts.watchAttacked'),
  item: () => t('settings.alerts.watchItem'),
  player: () => t('settings.alerts.watchPlayer'),
  cash: () => t('settings.alerts.watchCash')
};

/**
 * The eleven channels in the dictionary's own words.
 *
 * It lived on the two settings screens for the mute checkboxes and moved here
 * when they went (todo 02): the row's picker is the one place a channel is now
 * named, and a `Record` over the union means a channel the client gains later
 * fails to build rather than appearing untranslated.
 */
const CHANNEL_WORD: Record<NoticeChannel, string> = {
  combat: t('settings.alerts.channel.combat'),
  vitals: t('settings.alerts.channel.vitals'),
  room: t('settings.alerts.channel.room'),
  realm: t('settings.alerts.channel.realm'),
  party: t('settings.alerts.channel.party'),
  command: t('settings.alerts.channel.command'),
  movement: t('settings.alerts.channel.movement'),
  items: t('settings.alerts.channel.items'),
  stealth: t('settings.alerts.channel.stealth'),
  presence: t('settings.alerts.channel.presence'),
  session: t('settings.alerts.channel.session')
};
