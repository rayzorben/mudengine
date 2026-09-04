import Icon from './Icon';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { SaveState } from '../hooks/useAutoSave';

export interface FormActionsProps {
  /** Whether there is anywhere to step back to, and forward to. */
  can: { undo: boolean; redo: boolean };
  onUndo(): void;
  onRedo(): void;
  state: SaveState;
  /** Why the last save was refused, if it was. */
  error: string | null;
}

/**
 * The way back, now that there is no way to *not* save.
 *
 * Changes are written on their own (`useAutoSave`), which takes away the one
 * thing on this screen that could be forgotten — and takes away, with it, the
 * "close without saving" that used to be the way to undo a mistake. So the way
 * back has to be a control.
 *
 * - **Both buttons are always drawn**, disabled rather than absent. A pair that
 *   appeared and disappeared would move every control beside them at the moment
 *   somebody was reaching for one, which is the same rule the card rail follows.
 * - **The state is in words**, not only a spinner or a tick: `Saved` and
 *   `Saving…` say what happened, and a refusal says *why* and stays until the
 *   next save succeeds. With no click to tie it to, an error that faded would
 *   be an error nobody saw — and what it means is that what is on screen is not
 *   what is on disk.
 * - **`Not saved` is deliberately absent while a save is merely pending.** The
 *   gap between a keystroke and the write is under a second, and a warning that
 *   flashed on every keystroke would teach people to ignore the one that
 *   matters.
 */
export default function FormActions({
  can,
  onUndo,
  onRedo,
  state,
  error
}: FormActionsProps): React.JSX.Element {
  return (
    <>
      <button
        className="quiet"
        disabled={!can.undo}
        onClick={onUndo}
        onMouseDown={keepFocus}
        title={t('settings.formActions.undoTitle')}
        type="button"
      >
        <Icon name="undo" />
        <span>{t('settings.formActions.undo')}</span>
      </button>
      <button
        className="quiet"
        disabled={!can.redo}
        onClick={onRedo}
        onMouseDown={keepFocus}
        title={t('settings.formActions.redo')}
        type="button"
      >
        <Icon name="redo" />
        <span>{t('settings.formActions.redo')}</span>
      </button>
      <span className="settings-saving" data-state={state} role="status">
        {state === 'refused'
          ? (error ?? t('settings.formActions.notSaved'))
          : state === 'saving'
            ? t('settings.formActions.saving')
            : state === 'saved'
              ? t('settings.formActions.saved')
              : t('settings.formActions.idle')}
      </span>
    </>
  );
}
