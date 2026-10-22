/**
 * The Find a monster dialog: which character it is open for, the name it
 * opened on (a palette row's monster, or nothing from the bare command), and
 * closing it, which hands the caret back.
 */
import { useCallback, useMemo, useState } from 'react';

import { NO_SESSION, type SessionId } from '@shared/ipc';

export interface MobFindState {
  /** The character the dialog is open for; null while it is closed. */
  session: SessionId | null;
  /** The monster the dialog opened on; empty for the bare command. */
  name: string;
  /** Opens it for the shown character, on the name given; nothing without a character. */
  open(name?: string): void;
  close(): void;
}

export function useMobFind(shown: SessionId, returnFocus: () => void): MobFindState {
  const [opened, setOpened] = useState<{ session: SessionId; name: string } | null>(null);
  // Only for a character that exists: a refusal needs a console to be said in.
  const open = useCallback(
    (name = '') => setOpened(shown === NO_SESSION ? null : { session: shown, name }),
    [shown]
  );
  const close = useCallback(() => {
    setOpened(null);
    returnFocus();
  }, [returnFocus]);
  return useMemo(
    () => ({ session: opened?.session ?? null, name: opened?.name ?? '', open, close }),
    [opened, open, close]
  );
}
