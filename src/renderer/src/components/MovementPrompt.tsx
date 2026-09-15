import { useEffect, useRef } from 'react';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { MovementConfirm } from '@shared/movement';

export interface MovementPromptProps {
  /** What was measured, and about which character. Null while nothing is asked. */
  asked: MovementConfirm | null;
  /** The name on the tab, so the question says whose character wandered. */
  characterName: string;
  /** Walk it back and pick up where it left off. */
  onWalk(): void;
  /** Leave the character where it is. Nothing is forgotten either way. */
  onStay(): void;
}

/**
 * The character is a long way from what it was walking, and play is asking
 * first.
 *
 * A stop keeps its place (`src/shared/movement.ts`), which is the whole point
 * of a stop being a pause — and the consequence is that the lap you stopped at
 * ten o'clock is still there at midnight, after the character has been walked
 * to a bank, killed, and reborn in a temple two maps away. Pressing play then
 * is a journey across the realm nobody asked for, through everything that
 * lives on the way, with the player watching something else.
 *
 * So past `tuning.walk.resumeAskSteps` main answers play with this instead of
 * a command, and the window holds the question. **Back asks here too**
 * (`MovementConfirm.kind`): a press of the toolbar's back button the realm
 * cannot answer in one step is a journey the person meant as a step, which is
 * the same failure from the other end — so it asks in its own words rather
 * than borrowing the wander's. **Stay is the safe answer and takes the
 * caret**, for `ResetPrompt`'s reason: a dialog that opens with the
 * acting button focused is one press from a walk the person did not mean, and
 * this one opens on a press somebody made for a different reason.
 *
 * Nothing is forgotten by either answer. Stay leaves the movement stopped
 * exactly where it was, so the same play is there to press again.
 */
export default function MovementPrompt({
  asked,
  characterName,
  onWalk,
  onStay
}: MovementPromptProps): React.JSX.Element | null {
  const stay = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (asked === null) return;
    // After paint, so the surface exists to take it. The safe button.
    const id = window.requestAnimationFrame(() => stay.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [asked]);

  if (asked === null) return null;

  return (
    <div className="palette-scrim" role="presentation">
      <div
        aria-labelledby="movement-prompt-title"
        aria-modal="true"
        className="surface reset-prompt"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          // Escape is *stay*: the safe answer, which is what a key pressed to
          // make a dialog go away has to mean.
          onStay();
        }}
        role="dialog"
      >
        <h2 id="movement-prompt-title">
          {asked.kind === 'back'
            ? t('movement.backTitle', { name: characterName })
            : t('movement.title', { name: characterName })}
        </h2>
        {/*
          The figure and what it is a figure *of*, in two literal calls rather
          than one key built from `kind`: the coverage test reads the literal
          after `t(` and a dynamic key is one it cannot see. Both figures are
          the same measurement — how much further away the character is now
          than when the movement stopped — and the keys differ only in naming
          a lap or a destination.
        */}
        <p className="settings-warn">
          {asked.kind === 'back'
            ? t('movement.backNotAStep', { destination: asked.name, stepCount: asked.steps })
            : asked.kind === 'loop'
              ? t('movement.wanderedFromLoop', { loopName: asked.name, stepCount: asked.steps })
              : t('movement.wanderedFromRoute', {
                  destination: asked.name,
                  stepCount: asked.steps
                })}
        </p>
        <p className="settings-note">{t('movement.whatHappens')}</p>

        <div className="reset-actions">
          <button
            className="quiet"
            onClick={onStay}
            onMouseDown={keepFocus}
            ref={stay}
            type="button"
          >
            {t('movement.stay')}
          </button>
          <button onClick={onWalk} onMouseDown={keepFocus} type="button">
            {t('movement.walkIt')}
          </button>
        </div>
      </div>
    </div>
  );
}
