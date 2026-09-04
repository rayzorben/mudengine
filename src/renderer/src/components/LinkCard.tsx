import { memo, useEffect, useRef } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import { t } from '../lib/i18n';
import type { NegotiatedOptions, TelnetEvent } from '@shared/types';

export interface LinkCardProps extends CardChrome {
  negotiated: NegotiatedOptions;
  /** The exchange that produced the agreement above. */
  events: TelnetEvent[];
  /** Under pressure the wash animation is suppressed; see docs/ui-design.md 3.7. */
  quiet: boolean;
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
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = bodyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [events.length]);

  const agreed = (
    <dl className="readout">
      <dt>{t('cards.link.localLabel')}</dt>
      <dd className={negotiated.localEnabled.length ? '' : 'inert'}>
        {negotiated.localEnabled.join(', ') || t('cards.link.noneValue')}
      </dd>
      <dt>{t('cards.link.remoteLabel')}</dt>
      <dd className={negotiated.remoteEnabled.length ? '' : 'inert'}>
        {negotiated.remoteEnabled.join(', ') || t('cards.link.noneValue')}
      </dd>
      <dt>{t('cards.link.flagsLabel')}</dt>
      <dd className="flags">
        <Flag label={t('cards.link.flagSga')} on={negotiated.suppressGoAhead} />
        <Flag label={t('cards.link.flagEcho')} on={negotiated.remoteEcho} />
        <Flag label={t('cards.link.flagBinary')} on={negotiated.binary} />
      </dd>
    </dl>
  );

  const traffic = (
    <div className="telnet-log">
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

  return (
    <BentoCard
      {...chrome}
      badge={<span className="chip off">{events.length}</span>}
      bodyRef={bodyRef}
      className="link-card"
      scroll
      tabs={[
        // The first face is the card itself, so its label is the card's title.
        { id: 'agreed', label: t('cards.link.title'), content: agreed },
        { id: 'traffic', label: t('cards.link.tabTrafficLabel'), content: traffic }
      ]}
      title={t('cards.link.title')}
    />
  );
}

export default memo(LinkCard);
