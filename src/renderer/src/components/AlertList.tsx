import Icon from './Icon';
import RowGrip from './RowGrip';
import ToggleChip from './ToggleChip';
import { useRowReorder } from '../hooks/useRowReorder';
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
 * The player's alert rows, one line each (todos 29, 02 and 03; the line,
 * 2026-11-19). `mudengine-settings` › `parts/pages.md` has the account.
 *
 * The columns are declared once on the list and the heading and every row
 * borrow them, so a row with no measure leaves that cell empty and the rest
 * still line up. In a panel too narrow for one line the chips take a second
 * line under the row (`index.css`).
 *
 * A row names an event, grouped under its channel. Order decides: the first
 * enabled row that claims a notice wins, so the grip that moves a row leads it.
 * A control is drawn only where it means something: a comparison and a figure
 * on a measured event, a name on a named one, the two notification chips only
 * while the row notifies.
 */
export default function AlertList({ rules, namePrefix, onChange }: AlertListProps) {
  const update = (index: number, change: Partial<AlertRule>) =>
    onChange(rules.map((entry, at) => (at === index ? { ...entry, ...change } : entry)));

  const reorder = useRowReorder(rules, onChange);

  /**
   * Whether an earlier enabled row already claims everything this one would.
   * The first match wins, so a row under one naming the same thing can never
   * fire — and a row that does nothing should say so where it is typed, not be
   * discovered later.
   */
  const shadowed = (index: number): boolean =>
    rules.some((earlier, at) => at < index && earlier.enabled && earlier.on === rules[index]!.on);

  return (
    <div className="alert-rows">
      {rules.length > 0 && (
        <ul className="settings-steps settings-alerts" {...reorder.listProps}>
          {/*
            The column headings, in the same grid the rows use. Hidden from
            assistive technology because every control under them carries its
            own `aria-label` naming the row it belongs to, which a column
            heading cannot say.
          */}
          <li className="alert-heading" aria-hidden="true">
            <div className="alert-line">
              <span data-column="grip" />
              <span data-column="enabled">{t('settings.alerts.columnEnabled')}</span>
              <span data-column="event">{t('settings.alerts.columnEvent')}</span>
              <span data-column="measure">{t('settings.alerts.columnMeasure')}</span>
              <span data-column="level">{t('settings.alerts.columnLevel')}</span>
              <span data-column="deliver">{t('settings.alerts.columnDeliver')}</span>
              <span data-column="quiet">{t('settings.alerts.columnQuiet')}</span>
              <span data-column="remove" />
            </div>
          </li>
          {rules.map((rule, index) => (
            <li data-off={rule.enabled ? undefined : ''} key={index} {...reorder.rowProps(index)}>
              <div className="alert-line">
                <RowGrip
                  handlers={reorder.grip(index)}
                  label={t('settings.alerts.ruleGripAria', { number: index + 1 })}
                  title={t('settings.alerts.ruleGripTitle')}
                />
                {/* A bare switch under its heading: the column says what it
                    is, and the label is for a reader who cannot see it. */}
                <span className="alert-cell alert-enabled">
                  <input
                    aria-label={t('settings.alerts.ruleEnabledAria', { number: index + 1 })}
                    checked={rule.enabled}
                    className="switch"
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

                {/* Measure: which side of which figure, or which name. Empty
                    where the event is one that either happened or did not. */}
                <span className="alert-cell alert-measure">
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
                        <ToggleChip
                          checked={rule.percent}
                          label={t('settings.alerts.rulePercent')}
                          name={`${namePrefix}-${index}-percent`}
                          onChange={(percent) => update(index, { percent })}
                        />
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
                  className="alert-rule-level"
                  data-level={rule.level ?? 'keep'}
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

                {/* What the row does when it fires. */}
                <span className="alert-cell alert-deliver">
                  <ToggleChip
                    checked={rule.alert}
                    label={t('settings.alerts.ruleAlert')}
                    name={`${namePrefix}-${index}-alert`}
                    onChange={(alert) =>
                      // A sound plays as the alert shows, so it goes with it.
                      update(index, { alert, ...(alert ? {} : { sound: false }) })
                    }
                  />
                  <ToggleChip
                    checked={rule.sound}
                    disabled={!rule.alert}
                    label={t('settings.alerts.ruleSound')}
                    name={`${namePrefix}-${index}-sound`}
                    onChange={(sound) => update(index, { sound })}
                  />
                  <ToggleChip
                    checked={rule.notify}
                    label={t('settings.alerts.ruleNotify')}
                    name={`${namePrefix}-${index}-notify`}
                    onChange={(notify) =>
                      // The two below mean nothing without this, so they go
                      // with it rather than staying set on a row that no
                      // longer notifies.
                      update(index, {
                        notify,
                        ...(notify ? {} : { whileFocused: false, onlyAway: false })
                      })
                    }
                  />
                  {/* Drawn only while the row notifies (the user, 2026-11-19):
                      both qualify the notification and do nothing without it. */}
                  {rule.notify && (
                    <>
                      <ToggleChip
                        checked={rule.whileFocused}
                        label={t('settings.alerts.ruleWhileFocused')}
                        name={`${namePrefix}-${index}-while-focused`}
                        onChange={(whileFocused) => update(index, { whileFocused })}
                        sub
                        title={t('settings.alerts.ruleWhileFocusedTitle')}
                      />
                      <ToggleChip
                        checked={rule.onlyAway}
                        label={t('settings.alerts.ruleOnlyAway')}
                        name={`${namePrefix}-${index}-only-away`}
                        onChange={(onlyAway) => update(index, { onlyAway })}
                        sub
                        title={t('settings.alerts.ruleOnlyAwayTitle')}
                      />
                    </>
                  )}
                </span>

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

                <button
                  aria-label={t('settings.alerts.ruleRemoveAria', { number: index + 1 })}
                  className="quiet alert-remove"
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
              onlyAway: false,
              sound: false,
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
    </div>
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
  'player-found-hiding': () => t('settings.alerts.event.playerFoundHiding'),
  searched: () => t('settings.alerts.event.searched'),
  tracked: () => t('settings.alerts.event.tracked'),
  'movement-heard': () => t('settings.alerts.event.movementHeard'),
  'player-disconnects': () => t('settings.alerts.event.playerDisconnects'),
  telepath: () => t('settings.alerts.event.telepath'),
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
  'level-ready': () => t('settings.alerts.event.levelReady'),
  mentioned: () => t('settings.alerts.event.mentioned'),
  levelled: () => t('settings.alerts.event.levelled'),
  learned: () => t('settings.alerts.event.learned'),
  'learn-refused': () => t('settings.alerts.event.learnRefused'),
  'left-realm': () => t('settings.alerts.event.leftRealm'),
  'hangup-penalty': () => t('settings.alerts.event.hangupPenalty'),
  'login-failed': () => t('settings.alerts.event.loginFailed')
};

/**
 * The twelve channels in the dictionary's own words.
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
  talk: t('settings.alerts.channel.talk'),
  session: t('settings.alerts.channel.session')
};
