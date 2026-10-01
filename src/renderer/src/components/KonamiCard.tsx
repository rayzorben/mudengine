import { memo, useCallback, useState } from 'react';

import BentoCard, { type CardChrome, type CardTab } from './BentoCard';
import Icon from './Icon';
import KonamiLessons from './KonamiLessons';
import KonamiNow from './KonamiNow';
import KonamiTimeline from './KonamiTimeline';
import { clock } from '../lib/clock';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { goalText, outcomeText } from '../lib/konami';
import type { SessionId } from '@shared/ipc';
import type { KonamiSnapshot } from '@shared/konamiRecords';

export interface KonamiCardProps extends CardChrome {
  konami: KonamiSnapshot;
  session: SessionId;
}

type Face = 'now' | 'decisions' | 'lessons';

/** The card as text: the plan in force and each decision, for the copy glyph. */
function copyOf(konami: KonamiSnapshot): string {
  const plan = konami.plan === null ? t('cards.konami.emptyPlan') : goalText(konami.plan.goal);
  const rows = konami.decisions.map(
    (row) =>
      `${clock(row.at)} ${row.plan === null ? (row.refusal ?? '') : goalText(row.plan.goal)} · ${outcomeText(row.outcome)}`
  );
  return [plan, ...rows].join('\n');
}

/**
 * The "what to do next" planner (todo 59), on three faces: what it is doing
 * now and why, with the odds on every choice it was offered; every ask on a
 * line of time, opening onto what was sent and what came back; and what past
 * plans came to. Under each, the controls: pause, ask again, turn this plan
 * down, keep its settings.
 */
function KonamiCard({ konami, session, ...chrome }: KonamiCardProps) {
  const api = window.mudengine;
  const [face, setFace] = useState<Face>('now');
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const choose = useCallback((key: string) => void api?.konamiChoose(session, key), [api, session]);
  const forget = useCallback((at: number) => void api?.konamiForget(session, at), [api, session]);
  const reveal = useCallback(
    (at: number | null) =>
      void api?.konamiReveal(session, at).then((revealed) => {
        setNote(
          revealed?.how === 'listed' ? t('cards.konami.listed', { path: revealed.path }) : null
        );
      }),
    [api, session]
  );
  const openDecision = useCallback((id: string) => {
    setOpen(id);
    setFace('decisions');
  }, []);
  const seeLessons = useCallback(() => setFace('lessons'), []);

  const badge = !konami.on ? (
    <span className="chip off">{t('cards.konami.badge.off')}</span>
  ) : !konami.automation ? (
    <span className="chip warn">{t('cards.konami.badge.automationOff')}</span>
  ) : konami.provider === null ? (
    <span className="chip warn">{t('cards.konami.badge.noProvider')}</span>
  ) : konami.paused ? (
    <span className="chip warn">{t('cards.konami.badge.paused')}</span>
  ) : konami.asking ? (
    <span className="chip info">{t('cards.konami.badge.asking')}</span>
  ) : (
    <span className="chip on">{t('cards.konami.badge.running')}</span>
  );

  if (!konami.on) {
    return (
      <BentoCard {...chrome} badge={badge} className="konami-card" title={t('cards.konami.title')}>
        <div className="empty">{t('cards.konami.emptyOff')}</div>
      </BentoCard>
    );
  }

  const plan = konami.plan;
  const vetoable = plan !== null && plan.goal.kind !== 'wait' && !konami.paused;
  const controls = (
    <>
      {note !== null && <div className="konami-note">{note}</div>}
      <div className="konami-actions">
        <button
          className={konami.paused ? 'primary' : 'quiet'}
          onClick={() => void api?.konamiPause(session)}
          onMouseDown={keepFocus}
          type="button"
        >
          <Icon name={konami.paused ? 'play' : 'pause'} />
          {konami.paused ? t('cards.konami.resume') : t('cards.konami.pause')}
        </button>
        <button
          className={konami.paused ? 'quiet' : 'primary'}
          disabled={konami.paused || konami.asking}
          onClick={() => void api?.konamiAsk(session)}
          onMouseDown={keepFocus}
          type="button"
        >
          <Icon name="reset" />
          {t('cards.konami.askAgain')}
        </button>
        <button
          className="quiet"
          disabled={!vetoable || konami.asking}
          onClick={() => void api?.konamiVeto(session)}
          onMouseDown={keepFocus}
          title={t('cards.konami.notThisHint')}
          type="button"
        >
          <Icon name="close" />
          {t('cards.konami.notThis')}
        </button>
        <button
          className="quiet"
          disabled={plan === null}
          onClick={() => void api?.konamiKeep(session).then(setNote)}
          onMouseDown={keepFocus}
          title={t('cards.konami.keepHint')}
          type="button"
        >
          <Icon name="check" />
          {t('cards.konami.keep')}
        </button>
      </div>
    </>
  );

  const tabs: CardTab[] = [
    {
      id: 'now',
      label: t('cards.konami.title'),
      paned: true,
      content: (
        <>
          <KonamiNow
            konami={konami}
            onChoose={choose}
            onOpenDecision={openDecision}
            onSeeLessons={seeLessons}
          />
          {controls}
        </>
      )
    },
    {
      id: 'decisions',
      label: t('cards.konami.tabs.decisions'),
      paned: true,
      content: (
        <>
          <KonamiTimeline
            decisions={konami.decisions}
            incidents={konami.incidents}
            log={konami.log}
            onOpen={setOpen}
            onReveal={reveal}
            open={open}
            session={session}
          />
          {controls}
        </>
      )
    }
  ];
  // A face that would say nothing is not offered.
  if (konami.lessonsKept > 0) {
    tabs.push({
      id: 'lessons',
      label: t('cards.konami.tabs.lessons'),
      paned: true,
      content: (
        <>
          <KonamiLessons konami={konami} onForget={forget} />
          {controls}
        </>
      )
    });
  }
  const active = tabs.some((tab) => tab.id === face) ? face : 'now';

  return (
    <BentoCard
      {...chrome}
      active={active}
      badge={badge}
      className="konami-card"
      copyText={() => copyOf(konami)}
      onActive={(id) => setFace(id as Face)}
      tabs={tabs}
      title={t('cards.konami.title')}
    />
  );
}

export default memo(KonamiCard);
