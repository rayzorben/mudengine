import { memo, useEffect, useMemo, useRef } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import LinkOptions from './LinkOptions';
import SplitBar, { type SplitPart } from './viz/SplitBar';
import { t } from '../lib/i18n';
import type { NegotiatedOptions, TelnetEvent } from '@shared/types';

export interface LinkCardProps extends CardChrome {
  negotiated: NegotiatedOptions;
  /** The exchange that produced the agreement above. */
  events: TelnetEvent[];
  /** Under pressure the wash animation is suppressed; see docs/ui-design.md 3.7. */
  quiet: boolean;
}

/** How many of the newest exchanges the agreement draws under it, from medium. */
const LATEST = 8;

/**
 * The exchange, a row each, newest last; the newest washes once unless the
 * stream is busy. `follow` makes it a scroller kept on its newest row.
 */
function TelnetLog({
  events,
  quiet,
  follow = false
}: {
  events: readonly TelnetEvent[];
  quiet: boolean;
  follow?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (follow && node !== null) node.scrollTop = node.scrollHeight;
  }, [follow, events.length]);
  return (
    <div className={follow ? 'telnet-log scroller' : 'telnet-log'} ref={ref}>
      {events.length === 0 ? (
        <div className="empty">{t('cards.link.trafficEmpty')}</div>
      ) : (
        events.map((event, index) => (
          <div
            className={[
              'row',
              event.direction,
              !quiet && index === events.length - 1 ? 'fresh' : ''
            ]
              .filter(Boolean)
              .join(' ')}
            key={`${event.at}-${index}`}
          >
            <span className="dir">{event.direction === 'in' ? '<<' : '>>'}</span>
            <span>{event.summary}</span>
          </div>
        ))
      )}
    </div>
  );
}

function Flag({ on, label }: { on: boolean; label: string }) {
  // The chip carries the word as well as the colour, so the state survives
  // being read in greyscale.
  return (
    <span className={`chip ${on ? 'on' : 'off'}`}>
      {on ? label : t('cards.link.flagOff', { flagLabel: label })}
    </span>
  );
}

/**
 * What the two ends actually agreed on.
 *
 * No prior attempt in this workspace implemented Telnet, so when a server
 * behaved oddly there was nothing to look at. This card exists so that "the
 * server never sent WILL SUPPRESS-GO-AHEAD" is an observation, not a guess.
 */
/**
 * What the two ends agreed, and the exchange that got them there.
 *
 * Traffic used to be a card of its own, sitting in the rail beside this one and
 * saying the same thing at greater length. It is the *working* for what this
 * card states, which is what a tab is for — and a live negotiation log is
 * something almost nobody needs to look at, so it should not cost a cell.
 */
function LinkCard({ negotiated, events, quiet, ...chrome }: LinkCardProps) {
  /* Medium adds the exchange's two directions and its newest rows (`lib/cardSize.ts`). */
  const exchange = useMemo<SplitPart[]>(() => {
    const sent = events.filter((event) => event.direction === 'out').length;
    return [
      { key: 'in', label: t('cards.link.received'), value: events.length - sent, tone: 'accent' },
      { key: 'out', label: t('cards.link.sent'), value: sent, tone: 'd' }
    ];
  }, [events]);
  const agreed = (
    <div className="link-agreed">
      <div className="flags">
        <Flag label={t('cards.link.flagSga')} on={negotiated.suppressGoAhead} />
        <Flag label={t('cards.link.flagEcho')} on={negotiated.remoteEcho} />
        <Flag label={t('cards.link.flagBinary')} on={negotiated.binary} />
      </div>
      <LinkOptions negotiated={negotiated} />
      <div className="from-medium">
        <SplitBar label={t('cards.link.exchangeAria')} parts={exchange} />
      </div>
      {/* The newest of the exchange, the Traffic face's own rows. */}
      <section className="link-latest from-medium">
        <em>{t('cards.link.latest')}</em>
        <TelnetLog events={events.slice(-LATEST)} quiet />
      </section>
    </div>
  );

  return (
    <BentoCard
      {...chrome}
      badge={<span className="chip off">{events.length}</span>}
      className="link-card"
      scroll
      tabs={[
        // The first face is the card itself, so its label is the card's title.
        { id: 'agreed', label: t('cards.link.title'), content: agreed },
        {
          id: 'traffic',
          label: t('cards.link.tabTrafficLabel'),
          // Its own scroller, so following the newest row never scrolls the agreement.
          paned: true,
          content: <TelnetLog events={events} follow quiet={quiet} />
        }
      ]}
      title={t('cards.link.title')}
    />
  );
}

export default memo(LinkCard);
