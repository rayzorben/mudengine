/**
 * The game view's Auto switches and its Run and Rest steppers (todo 140),
 * under the player bar on the right. A switch flips the character's own file
 * as the toolbar's does; a stepper moves a threshold five points at a time.
 * Run's own name is the `retreat` switch and Rest's the `autoRest` one: the
 * figure dims while its switch is off, and is moved whether or not it is.
 */
import { memo } from 'react';

import type { AutomationSwitch, AutomationSwitches } from '@shared/config';
import type { HudThreshold } from '@shared/gameViewConfig';
import { t } from '../../lib/i18n';
import { switchLabel } from '../../lib/toolbar';

/** The switches the bar offers, in its order, each under the short word the bar has room for. */
export const GAME_SWITCHES: ReadonlyArray<readonly [AutomationSwitch, () => string]> = [
  ['automation', () => t('game.auto.all')],
  ['combat', () => t('game.auto.combat')],
  ['loot', () => t('game.auto.cash')],
  ['sneak', () => t('game.auto.sneak')],
  ['search', () => t('game.auto.search')],
  ['healParty', () => t('game.auto.heal')]
];

/** One press of a stepper, as a share of health. */
export const THRESHOLD_STEP = 0.05;

export interface AutoBarProps {
  switches: AutomationSwitches | null;
  runBelow: number | null;
  restBelow: number | null;
  onSwitch(name: AutomationSwitch, on: boolean): void;
  onThreshold(which: HudThreshold, value: number): void;
}

function Stepper({
  which,
  label,
  value,
  onThreshold,
  on,
  onToggle,
  title
}: {
  which: HudThreshold;
  label: string;
  value: number | null;
  onThreshold: AutoBarProps['onThreshold'];
  /** Whether the threshold acts, where a switch decides it; undefined where none does. */
  on?: boolean | null;
  onToggle?(): void;
  /** What the name's press does, said where a switch decides it. */
  title?: string;
}) {
  const move = (by: number) => {
    if (value !== null)
      onThreshold(which, Math.max(0, Math.min(1, Math.round((value + by) * 100) / 100)));
  };
  return (
    <span className="gv-stepper" data-off={on === false ? 'true' : undefined} data-tone={which}>
      <i />
      {onToggle === undefined ? (
        label
      ) : (
        <button
          aria-pressed={on === true}
          className="gv-stepper-name"
          disabled={on === null}
          onClick={onToggle}
          title={title}
          type="button"
        >
          {label}
        </button>
      )}
      <b>{value === null ? '?' : `${Math.round(value * 100)}%`}</b>
      <button
        aria-label={t('game.auto.lower', { name: label })}
        disabled={value === null}
        onClick={() => move(-THRESHOLD_STEP)}
        type="button"
      >
        −
      </button>
      <button
        aria-label={t('game.auto.raise', { name: label })}
        disabled={value === null}
        onClick={() => move(THRESHOLD_STEP)}
        type="button"
      >
        +
      </button>
    </span>
  );
}

function AutoBar({ switches, runBelow, restBelow, onSwitch, onThreshold }: AutoBarProps) {
  return (
    <div className="gv-hud gv-glass gv-autos">
      <span className="gv-quiet">{t('game.auto.label')}</span>
      {GAME_SWITCHES.map(([name, label]) => (
        <button
          aria-pressed={switches?.[name] === true}
          className="gv-toggle"
          disabled={switches === null}
          key={name}
          title={switchLabel(name)}
          onClick={() => switches !== null && onSwitch(name, !switches[name])}
          type="button"
        >
          {label()}
        </button>
      ))}
      <span className="gv-rule" />
      <Stepper
        label={t('game.auto.run')}
        on={switches === null ? null : switches.retreat}
        onThreshold={onThreshold}
        onToggle={() => switches !== null && onSwitch('retreat', !switches.retreat)}
        title={switches?.retreat === true ? t('game.auto.runOn') : t('game.auto.runOff')}
        value={runBelow}
        which="run"
      />
      <Stepper
        label={t('game.auto.rest')}
        on={switches === null ? null : switches.autoRest}
        onThreshold={onThreshold}
        onToggle={() => switches !== null && onSwitch('autoRest', !switches.autoRest)}
        title={switches?.autoRest === true ? t('game.auto.restOn') : t('game.auto.restOff')}
        value={restBelow}
        which="rest"
      />
    </div>
  );
}

export default memo(AutoBar);
