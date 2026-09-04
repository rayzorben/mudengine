import { memo } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import { t } from '../lib/i18n';
import { useMeter, type StreamMeter } from '../hooks/useStreamPressure';
import type { ConnectionState, TerminalSize } from '@shared/types';

export interface SessionCardProps extends CardChrome {
  state: ConnectionState;
  size: TerminalSize;
  /** The throughput readout, subscribed to here so the tick redraws this card and nothing else. */
  meter: StreamMeter;
}

const PHASE_CHIP: Record<ConnectionState['phase'], string> = {
  idle: 'off',
  resolving: 'warn',
  connecting: 'warn',
  negotiating: 'warn',
  connected: 'on',
  closing: 'warn',
  closed: 'off',
  error: 'bad'
};

/** What this session is, at a glance: where, how big, how fast. */
function SessionCard({ state, size, meter, ...chrome }: SessionCardProps) {
  const target = state.target;
  const { charsPerSecond } = useMeter(meter);

  return (
    <BentoCard
      {...chrome}
      badge={<span className={`chip ${PHASE_CHIP[state.phase]}`}>{state.phase}</span>}
      className="session-card"
      title={t('cards.session.title')}
    >
      <dl className="readout">
        <dt>{t('cards.session.host')}</dt>
        <dd className={target ? '' : 'inert'}>
          {target ? `${target.host}:${target.port}` : t('cards.session.noTarget')}
        </dd>
        <dt>{t('cards.session.encoding')}</dt>
        <dd className={target ? '' : 'inert'}>{target?.encoding ?? '—'}</dd>
        <dt>{t('cards.session.grid')}</dt>
        <dd>{t('cards.session.gridValue', { cols: size.cols, rows: size.rows })}</dd>
        <dt>{t('cards.session.rate')}</dt>
        <dd className={charsPerSecond > 0 ? '' : 'inert'}>
          {t('cards.session.rateValue', { rate: charsPerSecond.toLocaleString() })}
        </dd>
      </dl>
    </BentoCard>
  );
}

export default memo(SessionCard);
