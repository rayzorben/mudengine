import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { CheckField } from './FormField';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';

export type ShareAsked = {
  /** The character being shared. */
  character: string;
  /** The player it is shared with. */
  player: string;
  /** Whether Allow Remote Control starts ticked: it does when that is what was pressed. */
  control: boolean;
};

export interface SharePromptProps {
  /** Who is asked about. Null while nothing is. */
  asked: ShareAsked | null;
  /** Shared, with remote control or without. */
  onShare(control: boolean): void;
  onCancel(): void;
}

/**
 * Turning a share on (todo 20261031-1156-01, Design item 2), built like
 * `ResetPrompt`: it says, in the character's own words, that the other
 * player will see everything about the character while both are logged in
 * to this realm, its room included. Cancel is the safe answer, the default
 * focus and what Escape means. Turning a share off asks nothing. Allow
 * Remote Control lets the other player watch this character's terminal and
 * send it the actions both builds understand (`peerControl.ts`), the user's
 * answer of 2026-11-03.
 */
export default function SharePrompt({
  asked,
  onShare,
  onCancel
}: SharePromptProps): React.JSX.Element | null {
  const cancel = useRef<HTMLButtonElement>(null);
  const [control, setControl] = useState(false);
  useEffect(() => setControl(asked?.control ?? false), [asked]);

  useEffect(() => {
    if (asked === null) return;
    const id = window.requestAnimationFrame(() => cancel.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [asked]);

  if (asked === null) return null;
  const names = { character: asked.character, player: asked.player };
  // Over the whole window, and a child of the panel that opened it, which a press here must not close.
  return createPortal(
    <div className="palette-scrim" data-panel-child role="presentation">
      <div
        aria-labelledby="share-prompt-title"
        aria-modal="true"
        className="surface reset-prompt share-prompt"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }}
        role="dialog"
      >
        <h2 id="share-prompt-title">{t('share.title', names)}</h2>
        <p className="settings-warn">{t('share.everything', names)}</p>
        <p className="settings-note">{t('share.how', names)}</p>
        <CheckField
          checked={control}
          hint={t('share.controlHint', names)}
          label={t('share.control')}
          name="share-control"
          onChange={setControl}
        />
        {control && <p className="settings-warn">{t('share.controlWarning', names)}</p>}
        <div className="reset-actions">
          <button
            className="quiet"
            onClick={onCancel}
            onMouseDown={keepFocus}
            ref={cancel}
            type="button"
          >
            {t('share.cancel')}
          </button>
          <button
            className="danger"
            onClick={() => onShare(control)}
            onMouseDown={keepFocus}
            type="button"
          >
            {t('share.confirm', names)}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
