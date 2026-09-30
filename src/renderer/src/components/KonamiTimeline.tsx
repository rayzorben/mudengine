import { memo, useState } from 'react';

import Icon from './Icon';
import KonamiOdds from './KonamiOdds';
import { writeClipboard } from '../lib/clipboard';
import { clock } from '../lib/clock';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import {
  goalText,
  incidentText,
  outcomeIcon,
  outcomeText,
  outcomeTone,
  tookText,
  triggerText
} from '../lib/konami';
import type { SessionId } from '@shared/ipc';
import type { KonamiDecisionRow, KonamiExchange, KonamiIncidentRow } from '@shared/konamiRecords';

export interface KonamiTimelineProps {
  session: SessionId;
  decisions: readonly KonamiDecisionRow[];
  incidents: readonly KonamiIncidentRow[];
  log: string | null;
  /** The decision to show opened, as the Now face's strip asks. */
  open: string | null;
  onOpen(id: string | null): void;
  onReveal(at: number | null): void;
}

type Shown = 'sent' | 'received';

type Entry =
  | { kind: 'decision'; at: number; decision: KonamiDecisionRow }
  | { kind: 'incident'; at: number; incident: KonamiIncidentRow };

/**
 * What went to the provider and what came back, fetched when opened
 * (`konamiExchange`): a brief is tens of kilobytes and the card is pushed on
 * every change. The same text is in the running log, whole, for every ask.
 */
function Exchange({ session, id }: { session: SessionId; id: string }) {
  const api = window.mudengine;
  const [shown, setShown] = useState<Shown | null>(null);
  const [fetched, setFetched] = useState<KonamiExchange | null | undefined>(undefined);
  const show = (which: Shown): void => {
    setShown((was) => (was === which ? null : which));
    if (fetched !== undefined || api === undefined) return;
    void api.konamiExchange(session, id).then(setFetched);
  };
  const body =
    shown === null
      ? null
      : fetched === undefined
        ? t('cards.konami.exchange.loading')
        : fetched === null
          ? t('cards.konami.exchange.gone')
          : JSON.stringify(shown === 'sent' ? fetched.request : fetched.raw, null, 2);
  return (
    <div className="konami-exchange">
      <div className="konami-segment" role="group">
        {(['sent', 'received'] as const).map((which) => (
          <button
            aria-pressed={shown === which}
            className="chip pick"
            key={which}
            onClick={() => show(which)}
            onMouseDown={keepFocus}
            type="button"
          >
            {which === 'sent'
              ? t('cards.konami.exchange.sent')
              : t('cards.konami.exchange.received')}
          </button>
        ))}
        {body !== null && fetched !== undefined && fetched !== null && (
          <button
            className="quiet"
            onClick={() => void writeClipboard(body)}
            onMouseDown={keepFocus}
            type="button"
          >
            <Icon name="copy" />
            {t('cards.konami.exchange.copy')}
          </button>
        )}
      </div>
      {body !== null && <pre className="konami-payload">{body}</pre>}
    </div>
  );
}

function DecisionEntry({
  decision,
  open,
  session,
  onOpen
}: {
  decision: KonamiDecisionRow;
  open: boolean;
  session: SessionId;
  onOpen(id: string | null): void;
}) {
  const tone = outcomeTone(decision.outcome);
  const took = decision.settledAt === null ? null : decision.settledAt - decision.at;
  return (
    <li className="konami-entry" data-open={open} data-tone={tone}>
      <span className="konami-node">
        <Icon name={outcomeIcon(decision.outcome)} />
      </span>
      <button
        aria-expanded={open}
        className="konami-entry-head"
        onClick={() => onOpen(open ? null : decision.id)}
        onMouseDown={keepFocus}
        type="button"
      >
        <span className="konami-when">{clock(decision.at)}</span>
        <span className="konami-entry-goal">
          {decision.plan === null ? (decision.refusal ?? '') : goalText(decision.plan.goal)}
        </span>
        <span className={`chip ${tone}`}>{outcomeText(decision.outcome)}</span>
      </button>
      <div className="konami-entry-sub">
        <span>{t('cards.konami.because', { trigger: triggerText(decision.trigger) })}</span>
        {decision.level !== null && (
          <span>{t('cards.konami.level', { level: decision.level })}</span>
        )}
        {took !== null && <span>{tookText(took)}</span>}
        {decision.outcomeWhy !== null && <span className="konami-why">{decision.outcomeWhy}</span>}
      </div>
      {open && (
        <div className="konami-entry-body">
          {decision.options.length > 0 && <KonamiOdds compact options={decision.options} />}
          {/* A goal the player chose was not asked for: nothing went or came back. */}
          {decision.trigger !== 'chosen' && <Exchange id={decision.id} session={session} />}
        </div>
      )}
    </li>
  );
}

/**
 * Every ask, newest first, and every death and stuck log between them, on one
 * line of time: each ask names why it was asked, what it chose and what that
 * came to, and opens onto the odds and the exchange itself.
 */
function KonamiTimeline({
  session,
  decisions,
  incidents,
  log,
  open,
  onOpen,
  onReveal
}: KonamiTimelineProps) {
  const entries: Entry[] = [
    ...decisions.map((decision) => ({ kind: 'decision' as const, at: decision.at, decision })),
    ...incidents.map((incident) => ({ kind: 'incident' as const, at: incident.at, incident }))
  ].sort((a, b) => b.at - a.at);
  return (
    <div className="scroller konami-timeline-scroller">
      {entries.length === 0 ? (
        <div className="empty">{t('cards.konami.emptyDecisions')}</div>
      ) : (
        <ol className="konami-timeline">
          {entries.map((entry) =>
            entry.kind === 'decision' ? (
              <DecisionEntry
                decision={entry.decision}
                key={entry.decision.id}
                onOpen={onOpen}
                open={open === entry.decision.id}
                session={session}
              />
            ) : (
              <li
                className="konami-entry incident"
                data-tone={entry.incident.kind === 'death' ? 'bad' : 'warn'}
                key={`${entry.incident.kind}-${entry.at}`}
              >
                <span className="konami-node">
                  <Icon name={entry.incident.kind === 'death' ? 'flame' : 'flag'} />
                </span>
                <div className="konami-entry-head static">
                  <span className="konami-when">{clock(entry.at)}</span>
                  <span className="konami-entry-goal">{incidentText(entry.incident.kind)}</span>
                  {entry.incident.path !== null && (
                    <button
                      className="quiet konami-link"
                      onClick={() => onReveal(entry.at)}
                      onMouseDown={keepFocus}
                      title={entry.incident.path}
                      type="button"
                    >
                      <Icon name="folder" />
                      {t('cards.konami.open')}
                    </button>
                  )}
                </div>
              </li>
            )
          )}
        </ol>
      )}
      {log !== null && (
        <div className="konami-run">
          <Icon name="fileText" />
          <span className="konami-run-label">{t('cards.konami.runningLog')}</span>
          <span className="konami-run-path" title={log}>
            {log.split(/[\\/]/).at(-1)}
          </span>
          <button
            className="quiet konami-link"
            onClick={() => onReveal(null)}
            onMouseDown={keepFocus}
            title={t('cards.konami.openHint')}
            type="button"
          >
            {t('cards.konami.open')}
          </button>
        </div>
      )}
    </div>
  );
}

export default memo(KonamiTimeline);
