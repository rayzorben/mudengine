import { memo, useEffect, useState } from 'react';

import { chord } from '../lib/platform';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { ConnectionState, TerminalSize } from '@shared/types';
import type { Density, DensityPreference } from '../hooks/useDensity';
import { useMeter, type Pressure, type StreamMeter } from '../hooks/useStreamPressure';
import { tuning } from '../lib/tuning';

export interface StatusRailProps {
  state: ConnectionState;
  size: TerminalSize;
  /**
   * The throughput readout — the running total and the rate — subscribed to
   * here rather than passed as numbers, so a tick of the meter redraws this
   * one line and not the window it sits under.
   */
  meter: StreamMeter;
  pressure: Pressure;
  density: Density;
  densityPreference: DensityPreference;
  onCycleDensity(): void;
  /** What automation is doing right now, or null when it is doing nothing. */
  action: string | null;
  /** Dial or hang up the character being shown. */
  onToggleConnection(): void;
  /** True while a connection is being made or unmade; the action is refused. */
  busy: boolean;
  onOpenPalette(): void;
}

const PHASE_LABEL: Record<ConnectionState['phase'], string> = {
  idle: t('statusRail.phase.idle'),
  resolving: t('statusRail.phase.resolving'),
  connecting: t('statusRail.phase.connecting'),
  negotiating: t('statusRail.phase.negotiating'),
  connected: t('statusRail.phase.connected'),
  closing: t('statusRail.phase.closing'),
  closed: t('statusRail.phase.disconnected'),
  error: t('statusRail.phase.error')
};

function formatUptime(since: number | null): string {
  if (since === null) return '—';
  const seconds = Math.floor((Date.now() - since) / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** The full-width bottom cell: one line of always-true facts about the session. */
function StatusRail({
  state,
  size,
  onToggleConnection,
  busy,
  onOpenPalette,
  meter,
  pressure,
  density,
  densityPreference,
  onCycleDensity,
  action
}: StatusRailProps) {
  const target = state.target;
  const connected = state.phase === 'connected';
  const { charsPerSecond, total: chars } = useMeter(meter);

  /*
   * The uptime readout's clock, owned here.
   *
   * It was a tick in the window's root component — `forceTick` once a second
   * — which re-rendered the whole window, every card and every terminal
   * wrapper on it, to move one figure on this line. The Navigation card
   * already keeps its own clock for the same reason; this is the same
   * decision applied to the other readout that shows seconds.
   */
  const [, tick] = useState(0);
  useEffect(() => {
    if (!connected) return;
    const timer = window.setInterval(() => tick((n) => n + 1), tuning().clockTickMs);
    return () => window.clearInterval(timer);
  }, [connected]);

  return (
    <footer className="surface status-rail">
      {/*
       * The connection lives where its state already is.
       *
       * There is no command strip: where a character connects is a property of
       * the character, and it lives in that character's file rather than in a
       * pair of fields at the top of the window that only ever describe one of
       * them. What is left is a single action, and this segment was already
       * stating the condition it acts on — so it becomes the control rather
       * than growing a button beside it.
       */}
      <button
        className="phase"
        disabled={busy}
        onClick={onToggleConnection}
        onMouseDown={keepFocus}
        title={
          connected
            ? t('statusRail.phase.disconnectTooltip', { shortcut: chord('Enter', true) })
            : t('statusRail.phase.connectTooltip', { shortcut: chord('Enter', true) })
        }
        type="button"
      >
        <span className={`dot ${state.phase}`} />
        {PHASE_LABEL[state.phase]}
      </button>
      <span className="detail">
        {target ? `${target.host}:${target.port}` : t('statusRail.target.none')}
      </span>
      {state.detail && <span className="detail">{state.detail}</span>}

      {/*
       * What automation is doing, in the one place that is always on screen.
       * docs/ui-design.md §8 asks for this beside the Automation card: the
       * card answers "why did it do that", this answers "is it doing anything
       * right now", and only the second question is worth a permanent line.
       *
       * Absent when nothing is happening rather than showing "idle": a rail
       * segment that is always present is chrome, and this one is a *state*.
       */}
      {action !== null && (
        <span className="detail acting" title={t('statusRail.action.tooltip')}>
          {action}
        </span>
      )}

      <span className="spacer" />

      {pressure === 'high' && (
        <span className="metric pressure" title={t('statusRail.pressure.tooltip')}>
          {t('statusRail.pressure.burst', { rate: charsPerSecond.toLocaleString() })}
        </span>
      )}
      <span className="metric">{formatUptime(state.connectedAt)}</span>
      {/*
       * The measured grid, and a word when it is too narrow to be right.
       *
       * The floor is 80 and the server chose it: this family repaints its
       * status line with a literal `CSI 79 D` and never negotiates NAWS, so
       * output arrives at the width it arrives at whatever we report. Below 80
       * the maps, box frames and column-aligned stat sheets wrap client-side
       * and shear exactly as they would under a proportional face.
       *
       * Reported, never corrected. Rearranging the window under someone's hands
       * mid-combat is a hazard, so this says what is wrong and leaves the choice
       * -- close a rail, or use a smaller terminal font. See docs/profiles.md
       * §7.3.
       */}
      <span className="metric" data-narrow={size.cols < tuning().minColumns ? 'true' : undefined}>
        <b>
          {size.cols}×{size.rows}
        </b>
        {size.cols < tuning().minColumns && (
          <span
            className="narrow"
            title={t('statusRail.narrow.tooltip', { columns: tuning().minColumns })}
          >
            {t('statusRail.narrow.chip')}
          </span>
        )}
      </span>
      <span className="metric">
        {t('statusRail.chars.count', { count: chars.toLocaleString() })}
      </span>
      <button className="quiet kbd-hint" onClick={onOpenPalette} type="button">
        {t('statusRail.palette.button')} <kbd>{chord('K', true)}</kbd>
      </button>
      <button
        className="quiet"
        onClick={onCycleDensity}
        onMouseDown={keepFocus}
        title={t('statusRail.density.tooltip', { shortcut: chord(',', true) })}
        type="button"
      >
        {densityPreference === 'auto' ? t('statusRail.density.autoLabel', { density }) : density}
      </button>
    </footer>
  );
}

export default memo(StatusRail);
