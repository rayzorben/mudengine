import Icon from './Icon';
import { t } from '../lib/i18n';
import {
  ALERT_EVENT_NAMES,
  ALERT_SIDES,
  alertEvent,
  alertIsCash,
  alertIsMeasured,
  alertIsNamed,
  eventTakesPercent,
  DEFAULT_ALERT_DEBOUNCE_SECONDS,
  SEVERITIES,
  type AlertEvent,
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
 * The player's alert rows, edited one at a time (todos 29, 02 and 03).
 *
 * **A grid, not a row of controls** (todo 03). Each row used to be a flex line
 * whose controls appeared and disappeared per row — a figure on the two
 * numeric ones, a name on the two named ones, nothing on the rest — so no two
 * rows put the same control in the same place and nothing lined up down the
 * page. The columns are declared once and a row with no metric leaves that
 * cell **empty**, which is what makes a column a column.
 *
 * **Every control sits under the heading that names it** (2026-09-13). The
 * headings were their own `<li>` with its own copy of the grid, so the two
 * tracks only agreed by arithmetic — and the switch wore an `On` label beside
 * it, which is a field's grammar in a table's row: the column heading is where
 * a table says what a cell is. The heading row and the rows are now one
 * subgrid, the switch is a bare box under `Enabled`, and the label survives
 * for a screen reader alone.
 *
 * **The arrows are trailing controls, not a leading column** (2026-09-13).
 * Order decides — the first enabled row claiming a notice wins — so they stay;
 * but they are what is *done to* a row, like the remove, rather than something
 * the row is about, and in front they pushed every heading off its column.
 *
 * **A row names an event**, one thing that happens in the realm, grouped under
 * the category it belongs to. It used to name one of eleven internal channels
 * — the buckets this module sorts notices into — which is why nothing in that
 * picker read as selectable.
 *
 * **Order is the rule and the arrows are how it is said.** The first enabled
 * row that claims a notice decides it, so a quiet blanket row at the bottom
 * with a loud specific one above it is a thing somebody can write.
 *
 * **A control is drawn only where it means something**: a comparison and a
 * figure where the event is measured by one, a name where it is matched by
 * one, *even when the window is in front* only where the row notifies at all.
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
          {/*
            The column headings, in the same grid the rows use rather than a
            second copy of it, and one per control rather than a label beside
            each. Hidden from assistive technology because every control under
            them carries its own `aria-label` naming the row it belongs to,
            which a column heading cannot say.
          */}
          <li className="alert-heading" aria-hidden="true">
            <div className="alert-line">
              <span>{t('settings.alerts.columnEnabled')}</span>
              <span>{t('settings.alerts.columnEvent')}</span>
              <span>{t('settings.alerts.columnMetric')}</span>
              <span>{t('settings.alerts.columnMeasure')}</span>
              <span>{t('settings.alerts.columnLevel')}</span>
              <span>{t('settings.alerts.columnQuiet')}</span>
              <span className="alert-controls">{t('settings.alerts.columnOrder')}</span>
            </div>
          </li>
          {rules.map((rule, index) => (
            <li key={index}>
              <div className="alert-line">
                {/* A bare box under its heading. The word it wore beside it is
                    the column's now, and what is left is for a reader who
                    cannot see the column. */}
                <span className="alert-cell alert-enabled">
                  <input
                    aria-label={t('settings.alerts.ruleEnabledAria', { number: index + 1 })}
                    checked={rule.enabled}
                    name={`${namePrefix}-${index}-enabled`}
                    onChange={(event) => update(index, { enabled: event.target.checked })}
                    type="checkbox"
                  />
                </span>
                <select
                  aria-label={t('settings.alerts.ruleOnAria', { number: index + 1 })}
                  name={`${namePrefix}-${index}-on`}
                  onChange={(event) => update(index, { on: event.target.value as AlertEvent })}
                  value={rule.on}
                >
                  {/*
                    Grouped by the category the event belongs to, which is the
                    channel underneath — a heading rather than a choice, since
                    what somebody picks is the happening.
                  */}
                  {GROUPS.map(([channel, events]) => (
                    <optgroup key={channel} label={CHANNEL_WORD[channel]}>
                      {events.map((name) => (
                        <option key={name} value={name}>
                          {EVENT_WORD[name]()}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>

                {/* Metric: which figure, or which name. Empty where the event
                    is one that either happened or did not. */}
                <span className="alert-cell">
                  {alertIsMeasured(rule.on) && !alertIsCash(rule.on) && (
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
                  )}
                  {/* Money turning up is one-sided: there is no maximum to be a
                      share of and no *above* to fire on, so the comparison is
                      stated rather than chosen. */}
                  {alertIsCash(rule.on) && (
                    <span className="alert-fixed">{t('settings.alerts.sideOver')}</span>
                  )}
                  {alertIsNamed(rule.on) && (
                    <span className="alert-fixed">{t('settings.alerts.metricNamed')}</span>
                  )}
                </span>

                {/* Measure: the figure, or the name to wait for. */}
                <span className="alert-cell">
                  {alertIsMeasured(rule.on) && (
                    <>
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
                      {/* The `%` is the setting, not decoration: *below 60%*
                          and *below 100 hit points* are both things somebody
                          says, and which they meant is not guessable from the
                          number. Absent where there is no maximum to share. */}
                      {eventTakesPercent(rule.on) && (
                        <label className="blessing-check">
                          <input
                            checked={rule.percent}
                            name={`${namePrefix}-${index}-percent`}
                            onChange={(event) => update(index, { percent: event.target.checked })}
                            type="checkbox"
                          />
                          <span>{t('settings.alerts.rulePercent')}</span>
                        </label>
                      )}
                    </>
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
                </span>

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

                {/* How long the row stays quiet after firing. On every row,
                    because every event can repeat. 0 is every occurrence. */}
                <input
                  aria-label={t('settings.alerts.ruleQuietAria', { number: index + 1 })}
                  className="number"
                  inputMode="numeric"
                  name={`${namePrefix}-${index}-quiet`}
                  onChange={(event) =>
                    update(index, {
                      quietSeconds: Math.max(0, Math.round(Number(event.target.value) || 0))
                    })
                  }
                  value={rule.quietSeconds}
                />

                {/*
                  What is done TO the row, together at its end: move it, or
                  remove it. Order decides which row claims a notice — the
                  first enabled one — so the arrows are not decoration; they
                  are simply not something the row is *about*, which is what
                  the columns in front of them hold.
                */}
                <span className="alert-controls">
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
                  <button
                    aria-label={t('settings.alerts.ruleRemoveAria', { number: index + 1 })}
                    className="quiet"
                    onClick={() => onChange(rules.filter((_, at) => at !== index))}
                    title={t('settings.alerts.ruleRemoveTitle')}
                    type="button"
                  >
                    <Icon name="close" />
                  </button>
                </span>
              </div>
              {shadowed(index) && (
                <p className="settings-warn blessing-duplicate">
                  {t('settings.alerts.ruleShadowed')}
                </p>
              )}
              {/*
                What the row does when it fires, on its own line under the
                what-it-is-about one. Three switches that read as a sentence
                together and would each be a column nothing else fills.
              */}
              <div className="alert-line alert-detail">
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
                {/* Disabled rather than hidden while notifications are off:
                    the option is part of what the row can say, and hiding it
                    would make it look absent. */}
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
              name: '',
              quietSeconds: DEFAULT_ALERT_DEBOUNCE_SECONDS
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
 * The events, grouped under the category each belongs to, in the table's own
 * order.
 *
 * Built from `ALERT_EVENTS` rather than written out again: a group list that
 * could disagree with the table would offer an event nothing produces, or hide
 * one that fires.
 */
const GROUPS: Array<[NoticeChannel, AlertEvent[]]> = (() => {
  const groups = new Map<NoticeChannel, AlertEvent[]>();
  for (const name of ALERT_EVENT_NAMES) {
    const channel = alertEvent(name).channel;
    const list = groups.get(channel);
    if (list) list.push(name);
    else groups.set(channel, [name]);
  }
  return [...groups];
})();

/**
 * One literal `t()` per event, never a key built from the value:
 * `i18n-coverage.test.ts` reads only the literal after `t(`, so a dynamic key
 * would be an unexempted dynamic call and fifty keys nothing is seen to read.
 *
 * A `Record` over the union, so an event added to the table without a sentence
 * fails to build rather than appearing as its own key.
 */
const EVENT_WORD: Record<AlertEvent, () => string> = {
  health: () => t('settings.alerts.event.health'),
  mana: () => t('settings.alerts.event.mana'),
  attacked: () => t('settings.alerts.event.attacked'),
  'item-found': () => t('settings.alerts.event.itemFound'),
  'player-seen': () => t('settings.alerts.event.playerSeen'),
  'cash-found': () => t('settings.alerts.event.cashFound'),
  died: () => t('settings.alerts.event.died'),
  blinded: () => t('settings.alerts.event.blinded'),
  poisoned: () => t('settings.alerts.event.poisoned'),
  diseased: () => t('settings.alerts.event.diseased'),
  held: () => t('settings.alerts.event.held'),
  confused: () => t('settings.alerts.event.confused'),
  'attack-refused': () => t('settings.alerts.event.attackRefused'),
  'attack-useless': () => t('settings.alerts.event.attackUseless'),
  'spell-useless': () => t('settings.alerts.event.spellUseless'),
  'spell-refused': () => t('settings.alerts.event.spellRefused'),
  'attack-warned': () => t('settings.alerts.event.attackWarned'),
  'player-arrives': () => t('settings.alerts.event.playerArrives'),
  'player-leaves': () => t('settings.alerts.event.playerLeaves'),
  'player-dies': () => t('settings.alerts.event.playerDies'),
  'player-looks': () => t('settings.alerts.event.playerLooks'),
  searched: () => t('settings.alerts.event.searched'),
  tracked: () => t('settings.alerts.event.tracked'),
  'movement-heard': () => t('settings.alerts.event.movementHeard'),
  'player-disconnects': () => t('settings.alerts.event.playerDisconnects'),
  cleanup: () => t('settings.alerts.event.cleanup'),
  'way-blocked': () => t('settings.alerts.event.wayBlocked'),
  'bash-failed': () => t('settings.alerts.event.bashFailed'),
  'sneak-failed': () => t('settings.alerts.event.sneakFailed'),
  'hide-failed': () => t('settings.alerts.event.hideFailed'),
  'equip-failed': () => t('settings.alerts.event.equipFailed'),
  'list-failed': () => t('settings.alerts.event.listFailed'),
  'party-invited': () => t('settings.alerts.event.partyInvited'),
  'party-joined': () => t('settings.alerts.event.partyJoined'),
  'party-left': () => t('settings.alerts.event.partyLeft'),
  'command-refused': () => t('settings.alerts.event.commandRefused'),
  throttled: () => t('settings.alerts.event.throttled'),
  arrived: () => t('settings.alerts.event.arrived'),
  'connection-lost': () => t('settings.alerts.event.connectionLost'),
  'hostile-arrives': () => t('settings.alerts.event.hostileArrives'),
  'monster-arrives': () => t('settings.alerts.event.monsterArrives'),
  'hostile-in-realm': () => t('settings.alerts.event.hostileInRealm'),
  'party-hurt': () => t('settings.alerts.event.partyHurt'),
  'vitals-crossing': () => t('settings.alerts.event.vitalsCrossing'),
  levelled: () => t('settings.alerts.event.levelled'),
  learned: () => t('settings.alerts.event.learned'),
  'left-realm': () => t('settings.alerts.event.leftRealm'),
  'hangup-penalty': () => t('settings.alerts.event.hangupPenalty'),
  'login-failed': () => t('settings.alerts.event.loginFailed')
};

/**
 * The eleven channels in the dictionary's own words.
 *
 * They are group headings now rather than choices (todo 03): a channel is how
 * the client sorts a notice, and what a player picks is the happening under it.
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
