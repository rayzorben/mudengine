import { memo, useState } from 'react';

import { clock } from '../lib/clock';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { SessionId } from '@shared/ipc';
import type { KonamiDecisionRow, KonamiExchange } from '@shared/konamiRecords';

export interface KonamiTerminalProps {
  session: SessionId;
  decisions: readonly KonamiDecisionRow[];
  /** Why it was asked and what the plan was, in the card's words; a module-level function. */
  words(decision: KonamiDecisionRow): { trigger: string; goal: string };
}

type Shown = 'sent' | 'received';

/** The picks that came back, one short line: `goal=hunt_3 47%, attack=aa 72%`. */
function picksText(decision: KonamiDecisionRow): string {
  return (decision.plan?.picks ?? [])
    .map((pick) => `${pick.question}=${pick.label} ${Math.round(pick.p * 100)}%`)
    .join(', ');
}

/**
 * What went to the provider and what came back, one entry per ask, newest
 * first: the terminal the real-time version had. The request and the reply
 * are fetched when opened (`konamiExchange`), since a brief is tens of
 * kilobytes and the card is pushed on every change. The same text is in the
 * running log, whole, for every ask.
 */
function KonamiTerminal({ session, decisions, words }: KonamiTerminalProps) {
  const api = window.mudengine;
  const [open, setOpen] = useState<Record<string, Shown | undefined>>({});
  const [fetched, setFetched] = useState<Record<string, KonamiExchange | null>>({});

  const toggle = (id: string, which: Shown): void => {
    setOpen((was) => ({ ...was, [id]: was[id] === which ? undefined : which }));
    if (fetched[id] !== undefined || api === undefined) return;
    void api
      .konamiExchange(session, id)
      .then((exchange) => setFetched((was) => ({ ...was, [id]: exchange })));
  };

  if (decisions.length === 0) {
    return <div className="empty">{t('cards.konami.emptyDecisions')}</div>;
  }
  return (
    <div className="konami-terminal">
      {decisions.map((decision) => {
        const said = words(decision);
        const shown = open[decision.id];
        const exchange = fetched[decision.id];
        const body =
          shown === undefined
            ? null
            : exchange === undefined
              ? t('cards.konami.terminal.loading')
              : exchange === null
                ? t('cards.konami.terminal.gone')
                : JSON.stringify(shown === 'sent' ? exchange.request : exchange.raw, null, 2);
        return (
          <div className="konami-exchange" key={decision.id}>
            <div className="konami-line konami-sent">
              <span className="trace-at">{clock(decision.at)}</span>
              <span>{t('cards.konami.terminal.sent', { trigger: said.trigger })}</span>
              <button
                className="quiet konami-show"
                onClick={() => toggle(decision.id, 'sent')}
                onMouseDown={keepFocus}
                type="button"
              >
                {shown === 'sent'
                  ? t('cards.konami.terminal.hide')
                  : t('cards.konami.terminal.show')}
              </button>
            </div>
            <div className="konami-line konami-received">
              <span>
                {decision.plan === null
                  ? t('cards.konami.terminal.failed', { why: decision.refusal ?? '' })
                  : t('cards.konami.terminal.received', { picks: picksText(decision) })}
              </span>
              <button
                className="quiet konami-show"
                onClick={() => toggle(decision.id, 'received')}
                onMouseDown={keepFocus}
                type="button"
              >
                {shown === 'received'
                  ? t('cards.konami.terminal.hide')
                  : t('cards.konami.terminal.show')}
              </button>
            </div>
            {decision.plan !== null && (
              <div className="konami-line konami-made">
                {t('cards.konami.terminal.made', { goal: said.goal })}
              </div>
            )}
            {body !== null && <pre className="konami-payload">{body}</pre>}
          </div>
        );
      })}
    </div>
  );
}

export default memo(KonamiTerminal);
