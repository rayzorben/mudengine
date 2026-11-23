/**
 * The character switcher the header opens: every character in this window, the
 * shown one marked, each with where it plays and whether it is connected.
 * Choosing one shows it; a tab switch sends nothing to any session.
 */
import { memo } from 'react';

import type { SessionId, SessionSummary } from '@shared/ipc';
import { t } from '../../lib/i18n';

export interface PhoneCharactersProps {
  sessions: readonly SessionSummary[];
  active: SessionId;
  onSelect(session: SessionId): void;
  onClose(): void;
}

function PhoneCharacters({ sessions, active, onSelect, onClose }: PhoneCharactersProps) {
  return (
    <div className="phone-sheet-scrim" onClick={onClose} role="presentation">
      <ul
        aria-label={t('phone.characters.aria')}
        className="phone-sheet phone-glass"
        onClick={(event) => event.stopPropagation()}
      >
        {sessions.length === 0 && <li className="phone-quiet">{t('phone.characters.none')}</li>}
        {sessions.map((entry) => (
          <li key={entry.id}>
            <button
              aria-current={entry.id === active ? 'true' : undefined}
              data-phase={entry.state.phase}
              onClick={() => {
                onSelect(entry.id);
                onClose();
              }}
              type="button"
            >
              <span aria-hidden="true" className="phone-dot" />
              <span>
                <b>{entry.name}</b>
                <small>{entry.server}</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default memo(PhoneCharacters);
