import { memo } from 'react';

import Icon from './Icon';
import { dayAndTime } from '../lib/clock';
import { t } from '../lib/i18n';
import { historyLook, historyText } from '../lib/konami';
import type { HistoryEntry } from '@shared/konamiHistory';

export interface KonamiHistoryProps {
  history: readonly HistoryEntry[];
}

/**
 * What the character has done under the planner, newest first, on the same
 * line of time as the Decisions face: hunts and what they paid, levels and
 * stat points, what was bought, worn and taken off, deaths.
 */
function KonamiHistory({ history }: KonamiHistoryProps) {
  return (
    <div className="scroller konami-timeline-scroller">
      {history.length === 0 ? (
        <div className="empty">{t('cards.konami.emptyHistory')}</div>
      ) : (
        <ol className="konami-timeline">
          {history.map((entry, at) => {
            const look = historyLook(entry.event);
            return (
              <li className="konami-entry" data-tone={look.tone} key={`${entry.at}-${at}`}>
                <span className="konami-node">
                  <Icon name={look.icon} />
                </span>
                <div className="konami-entry-head static">
                  <span className="konami-when">{dayAndTime(entry.at)}</span>
                  <span className="konami-entry-goal">{historyText(entry.event)}</span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

export default memo(KonamiHistory);
