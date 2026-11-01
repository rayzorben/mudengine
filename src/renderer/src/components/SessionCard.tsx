import { memo } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import Icon, { type IconName } from './Icon';
import Kpi from './viz/Kpi';
import Sparkline from './viz/Sparkline';
import { clock } from '../lib/clock';
import { t } from '../lib/i18n';
import { useMeterHistory } from '../hooks/useMeterHistory';
import { useMeter, type StreamMeter } from '../hooks/useStreamPressure';
import type { ConnectionState, TerminalSize } from '@shared/types';

export interface SessionCardProps extends CardChrome {
  state: ConnectionState;
  size: TerminalSize;
  /** The throughput readout, subscribed to by `SessionRate` alone, so the tick redraws that and nothing else. */
  meter: StreamMeter;
}

const PHASE_CHIP: Record<ConnectionState['phase'], 'off' | 'warn' | 'on' | 'bad'> = {
  idle: 'off',
  connecting: 'warn',
  connected: 'on',
  closing: 'warn',
  closed: 'off',
  error: 'bad'
};

const PHASE_ICON: Record<ConnectionState['phase'], IconName> = {
  idle: 'unplug',
  connecting: 'activity',
  connected: 'link',
  closing: 'activity',
  closed: 'unplug',
  error: 'unplug'
};

/** How many of the meter's samples the trace holds: half a minute at the shipped 250ms. */
const TRACE_SAMPLES = 120;

/** `48K`: a running total of characters, read at a glance. */
const COMPACT = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/**
 * The rate now, its trace over the last half minute and the total received:
 * the one part of the card that moves with the stream, so the one part that
 * reads the meter.
 */
const SessionRate = memo(function SessionRate({ meter }: { meter: StreamMeter }) {
  const { charsPerSecond, total } = useMeter(meter);
  const trace = useMeterHistory(meter, TRACE_SAMPLES);
  const peak = trace.length === 0 ? null : Math.max(...trace);
  const mean =
    trace.length === 0
      ? null
      : Math.round(trace.reduce((sum, rate) => sum + rate, 0) / trace.length);
  return (
    <>
      <div className="session-rate">
        <b className={charsPerSecond > 0 ? undefined : 'inert'}>
          {t('cards.session.rateValue', { rate: charsPerSecond.toLocaleString() })}
        </b>
        <small className="from-medium">
          {t('cards.session.received', { total: COMPACT.format(total) })}
        </small>
      </div>
      <div className="session-trace">
        <Sparkline label={t('cards.session.traceAria')} rule={mean} values={trace} />
      </div>
      {/* Large, the half minute's peak and its mean, which the dashed rule draws. */}
      <div className="kpis from-large">
        <Kpi
          hint={t('cards.session.perSecond')}
          label={t('cards.session.peak')}
          value={peak === null ? null : peak.toLocaleString()}
        />
        <Kpi
          hint={t('cards.session.perSecond')}
          label={t('cards.session.mean')}
          value={mean === null ? null : mean.toLocaleString()}
        />
      </div>
    </>
  );
});

/** The console's grid as a screen of its own shape, cells being twice as tall as wide. */
function ScreenShape({ size }: { size: TerminalSize }) {
  return (
    <svg
      aria-hidden="true"
      className="session-screen"
      viewBox={`0 0 ${size.cols} ${size.rows * 2}`}
    >
      <rect height={size.rows * 2} rx={2} width={size.cols} />
    </svg>
  );
}

/** What this session is, at a glance: where, how big, how fast. */
function SessionCard({ state, size, meter, ...chrome }: SessionCardProps) {
  const target = state.target;
  const tone = PHASE_CHIP[state.phase];

  return (
    <BentoCard
      {...chrome}
      badge={<span className={`chip ${tone}`}>{state.phase}</span>}
      className="session-card"
      paned
      title={t('cards.session.title')}
    >
      <div className="session-where" data-tone={tone}>
        <Icon name={PHASE_ICON[state.phase]} />
        <span className={target ? 'session-host' : 'session-host inert'}>
          {target ? `${target.host}:${target.port}` : t('cards.session.noTarget')}
        </span>
        {state.connectedAt !== null && state.phase === 'connected' && (
          <small className="from-medium">
            {t('cards.session.since', { at: clock(state.connectedAt) })}
          </small>
        )}
      </div>
      {state.detail !== null && (state.phase === 'closed' || state.phase === 'error') && (
        <div className="session-detail">{state.detail}</div>
      )}
      <SessionRate meter={meter} />
      {/* Small, a session is where and how fast (`lib/cardSize.ts`). */}
      <div className="kpis from-medium">
        <Kpi label={t('cards.session.encoding')} value={target?.encoding ?? null} />
        <Kpi
          hint={<ScreenShape size={size} />}
          label={t('cards.session.grid')}
          value={t('cards.session.gridValue', { cols: size.cols, rows: size.rows })}
        />
      </div>
    </BentoCard>
  );
}

export default memo(SessionCard);
