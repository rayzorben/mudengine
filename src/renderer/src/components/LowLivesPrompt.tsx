import { useEffect, useRef } from 'react';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { LowLivesAsk } from '@shared/ipc';
import type { LowLivesAnswer } from '@shared/lives';

export interface LowLivesPromptProps {
  /** The lives the client last read and the floor they are at. Null while nothing is asked. */
  ask: LowLivesAsk | null;
  characterName: string;
  onAnswer(answer: LowLivesAnswer): void;
}

/**
 * A character is down to its last few lives with automation on, and the
 * client did not log it in (todo 07). The warning is the largest thing on the
 * dialog; the filled button turns automation off and logs in, which stops
 * extensions too, since everything automated goes through the one command
 * queue.
 *
 * **Stay Offline has the caret and Escape**, as Keep does on `ResetPrompt`:
 * this opens unasked on a reconnect, and a key pressed to make it go away
 * must not log anybody in.
 */
export default function LowLivesPrompt({
  ask,
  characterName,
  onAnswer
}: LowLivesPromptProps): React.JSX.Element | null {
  const stay = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (ask === null) return;
    // After paint, so the surface exists to take it.
    const id = window.requestAnimationFrame(() => stay.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [ask]);

  if (ask === null) return null;
  const params = { name: characterName, count: ask.lives };

  return (
    <div className="palette-scrim" role="presentation">
      <div
        aria-labelledby="low-lives-title"
        aria-modal="true"
        className="surface reset-prompt low-lives-prompt"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          onAnswer('stay');
        }}
        role="dialog"
      >
        <h2 id="low-lives-title">
          {ask.lives === 1 ? t('lowLives.title.one', params) : t('lowLives.title.many', params)}
        </h2>
        <p className="settings-warn">{t('lowLives.warning')}</p>
        <p className="settings-note">
          {t('lowLives.counted', {
            at: new Date(ask.at).toLocaleString(),
            floor: ask.floor
          })}
        </p>

        <div className="reset-actions">
          <button
            className="quiet"
            onClick={() => onAnswer('stay')}
            onMouseDown={keepFocus}
            ref={stay}
            type="button"
          >
            {t('lowLives.stay')}
          </button>
          <button onClick={() => onAnswer('log-in')} onMouseDown={keepFocus} type="button">
            {t('lowLives.logIn')}
          </button>
          <button
            className="primary"
            onClick={() => onAnswer('switch-off')}
            onMouseDown={keepFocus}
            type="button"
          >
            {t('lowLives.switchOff')}
          </button>
        </div>
      </div>
    </div>
  );
}
