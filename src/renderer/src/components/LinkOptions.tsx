/**
 * Every Telnet option the two ends agreed, as a tile each, marked for the side
 * performing it (`us`, `them`, or both). What was asked and refused is the
 * Traffic face's rows. See `mudengine-ui` › `parts/cards.md`.
 */
import { memo, useMemo } from 'react';

import { t } from '../lib/i18n';
import type { NegotiatedOptions } from '@shared/types';

function LinkOptions({ negotiated }: { negotiated: NegotiatedOptions }) {
  const names = useMemo(
    () => [...new Set([...negotiated.localEnabled, ...negotiated.remoteEnabled])].sort(),
    [negotiated]
  );

  if (names.length === 0) return <div className="empty">{t('cards.link.noneValue')}</div>;
  return (
    <ul className="link-options">
      {names.map((name) => {
        const local = negotiated.localEnabled.includes(name);
        const remote = negotiated.remoteEnabled.includes(name);
        return (
          <li key={name}>
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
