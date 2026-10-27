/**
 * The hidden tab rail's strip (`ui.tabsAutoHide`): one circle per character
 * down the window's edge, in the rail's order. The pointer on it brings the
 * rail out beside it (`index.css`); a press on a circle shows that character.
 *
 * Kept out of the accessibility tree and the Tab order: the rail is the
 * tablist, and a key in it brings it out the same way.
 */
import { memo } from 'react';

import CharacterBadge, { type PortraitApi } from './CharacterBadge';
import type { RailView } from './TabRail';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { SessionId, SessionSummary } from '@shared/ipc';

function TabStrip({
  api,
  sessions,
  views,
  active,
  onSelect
}: {
  api: PortraitApi;
  sessions: readonly SessionSummary[];
  views: Record<SessionId, RailView>;
  active: SessionId;
  onSelect(session: SessionId): void;
}) {
  if (sessions.length === 0) return null;
  return (
    <div aria-hidden="true" className="tab-strip">
      {sessions.map((session) => {
        const character = views[session.id]?.character;
        return (
          <button
            className="tab-strip-item"
            data-accent={session.accent}
            data-active={session.id === active ? 'true' : 'false'}
            data-phase={views[session.id]?.state.phase ?? 'idle'}
            data-session={session.id}
            key={session.id}
            onClick={() => onSelect(session.id)}
            onMouseDown={keepFocus}
            tabIndex={-1}
            title={t('tabs.tab.whoTooltip', {
              characterName: session.name,
              realmName: session.server
            })}
            type="button"
          >
            <CharacterBadge
              api={api}
              className={character?.className ?? null}
              name={session.name}
              race={character?.race ?? null}
              session={session.id}
            />
          </button>
        );
      })}
    </div>
  );
}

export default memo(TabStrip);
