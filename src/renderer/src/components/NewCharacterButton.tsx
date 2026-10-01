import { useMemo, useRef, useState } from 'react';

import Icon from './Icon';
import PopupMenu from './PopupMenu';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { closedCharacters } from '../lib/roster';

import type { ProfileSummary, SessionId } from '@shared/ipc';

export interface NewCharacterButtonProps {
  profiles: readonly ProfileSummary[];
  /** Whether the rail runs down an edge, where there is room for the label. */
  stacked: boolean;
  onNew(): void;
  /** Open a tab for a character that has a file and no tab. */
  onOpen(id: SessionId): Promise<void>;
  /** The menu took the caret; the console gets it back once it closes. */
  returnFocus(): void;
}

/**
 * *New character*, split: the button makes one, the chevron beside it lists
 * the characters whose tab was closed and opens one again.
 *
 * The chevron is drawn only while there is somebody to list, so a player who
 * never closed a tab sees the plain button.
 */
export default function NewCharacterButton({
  profiles,
  stacked,
  onNew,
  onOpen,
  returnFocus
}: NewCharacterButtonProps) {
  const closed = useMemo(() => closedCharacters(profiles), [profiles]);
  const chevron = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState(false);
  const split = closed.length > 0;

  return (
    <div className="new-character-group" data-split={split ? 'true' : undefined}>
      <button
        aria-label={t('tabs.head.newCharacterAria')}
        className="new-character"
        onClick={onNew}
        // The settings screen takes the caret itself; the button must not fight
        // it for one on the way there.
        onMouseDown={keepFocus}
        title={t('tabs.head.newCharacterTooltip')}
        type="button"
      >
        <Icon name="plus" />
        {stacked && <span className="what">{t('tabs.head.newCharacterAria')}</span>}
      </button>

      {split && (
        <button
          aria-expanded={menu}
          aria-haspopup="menu"
          aria-label={t('tabs.head.closedCharactersAria')}
          className="new-character closed-characters"
          onClick={() => setMenu((open) => !open)}
          onMouseDown={keepFocus}
          ref={chevron}
          title={t('tabs.head.closedCharactersAria')}
          type="button"
        >
          <Icon name="chevronDown" />
        </button>
      )}

      {menu && split && chevron.current && (
        <PopupMenu
          at={chevron.current}
          items={closed.map((profile) => ({
            label: profile.name,
            icon: 'login',
            run: () => {
              setMenu(false);
              // The tab joins the rail without being shown, so the caret goes
              // back to the console on screen once main has loaded it.
              void onOpen(profile.id).finally(returnFocus);
            }
          }))}
          onDismiss={() => {
            setMenu(false);
            returnFocus();
          }}
        />
      )}
    </div>
  );
}
