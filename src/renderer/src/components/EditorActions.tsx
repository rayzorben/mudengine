import type { ReactNode } from 'react';

import { t } from '../lib/i18n';

export interface EditorActionsProps {
  /**
   * The create button's words for a file not yet on disk, or null while
   * editing one. Creating takes a press and editing does not: a half-typed
   * name is a different character or realm, so an auto-saved new one would
   * write a directory per keystroke.
   */
  create: string | null;
  /** How the saving is going and the way back (`FormActions`), while editing. */
  status: ReactNode;
  /** The removal has been asked for and waits on its answer. */
  confirming: boolean;
  /** The question the removal asks. */
  confirmText: string;
  onAsk(): void;
  onRemove(): void;
  onKeep(): void;
}

/**
 * The row under a character's or a realm's form: the create button, or the
 * saving and the removal. The removal is asked first, because it may destroy
 * the only record of a password; the file is backed up beside itself either way.
 */
export default function EditorActions({
  create,
  status,
  confirming,
  confirmText,
  onAsk,
  onRemove,
  onKeep
}: EditorActionsProps): React.JSX.Element {
  if (create !== null) {
    return (
      <button className="primary" type="submit">
        {create}
      </button>
    );
  }
  return (
    <>
      {status}
      {confirming ? (
        <>
          <span className="hint">{confirmText}</span>
          <button className="danger" onClick={onRemove} type="button">
            {t('settings.actions.confirmYes')}
          </button>
          <button className="quiet" onClick={onKeep} type="button">
            {t('settings.actions.confirmKeep')}
          </button>
        </>
      ) : (
        <button className="quiet" onClick={onAsk} type="button">
          {t('settings.actions.remove')}
        </button>
      )}
    </>
  );
}
