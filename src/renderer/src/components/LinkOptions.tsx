/**
 * Every Telnet option the two ends spoke about, as a tile each: lit for the
 * side performing it, quiet where it was asked about and refused. The options
 * come from the agreement and from the exchange's own summaries (`DO NAWS`),
 * so a refusal has a tile too. See `mudengine-ui` › `parts/cards.md`.
 */
import { memo, useMemo } from 'react';

import { t } from '../lib/i18n';
import type { NegotiatedOptions, TelnetEvent } from '@shared/types';

/** The verb and the option at the front of a summary: `WILL ECHO`, `DONT NAWS`. */
const VERB = /^(?:DO|DONT|WILL|WONT)\s+(\S+)/;

function LinkOptions({
  negotiated,
  events
}: {
  negotiated: NegotiatedOptions;
  events: readonly TelnetEvent[];
}) {
  const names = useMemo(() => {
    const seen = new Set<string>([...negotiated.localEnabled, ...negotiated.remoteEnabled]);
    for (const event of events) {
      const named = VERB.exec(event.summary)?.[1];
      if (named !== undefined) seen.add(named);
    }
    return [...seen].sort();
  }, [negotiated, events]);

  if (names.length === 0) return <div className="empty">{t('cards.link.noneValue')}</div>;
  return (
    <ul className="link-options">
      {names.map((name) => {
        const local = negotiated.localEnabled.includes(name);
        const remote = negotiated.remoteEnabled.includes(name);
        return (
          <li data-on={local || remote} key={name}>
            <span className="link-option-name">{name}</span>
            <span className="link-option-sides">
              <i data-on={local} title={t('cards.link.localLabel')}>
                {t('cards.link.localShort')}
              </i>
              <i data-on={remote} title={t('cards.link.remoteLabel')}>
                {t('cards.link.remoteShort')}
              </i>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default memo(LinkOptions);
