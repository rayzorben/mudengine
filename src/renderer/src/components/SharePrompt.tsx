import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';

export type ShareAsked = {
  /** The character being shared. */
  character: string;
  /** The player it is shared with. */
  player: string;
};

export interface SharePromptProps {
  /** Who is asked about. Null while nothing is. */
  asked: ShareAsked | null;
  onShare(): void;
  onCancel(): void;
}

/**
 * Turning a share on (todo 20261031-1156-01, Design item 2), built like
 * `ResetPrompt`: it says, in the character's own words, that the other
 * player will see everything about the character while both are logged in
 * to this realm, its room included. Cancel is the safe answer, the default
 * focus and what Escape means. Turning a share off asks nothing. Remote
 * control is not offered: how it would work across two builds is still the
 * user's question (open question 2).
 */
export default function SharePrompt({
  asked,
  onShare,
  onCancel
}: SharePromptProps): React.JSX.Element | null {
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (asked === null) return;
    const id = window.requestAnimationFrame(() => cancel.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [asked]);

  if (asked === null) return null;
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
        <h2 id="share-prompt-title">{t('share.title', asked)}</h2>
        <p className="settings-warn">{t('share.everything', asked)}</p>
        <p className="settings-note">{t('share.how', asked)}</p>
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
          <button className="danger" onClick={onShare} onMouseDown={keepFocus} type="button">
            {t('share.confirm', asked)}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
