/**
 * The Search the area dialog: which character it is open for, closing it
 * (which hands the caret back), and the two figures last chosen, kept while
 * the window is open so a second search starts where the first did. Null
 * until chosen: the dialog then opens on main's `firstRadius`/`firstSearches`.
 */
import { useCallback, useMemo, useState } from 'react';

import { NO_SESSION, type SessionId } from '@shared/ipc';

export interface AreaFigures {
  radius: number;
  searches: number;
}

export interface AreaSearchState {
  /** The character the dialog is open for; null while it is closed. */
  session: SessionId | null;
  /** Opens it for the shown character; nothing without one. */
  open(): void;
  close(): void;
  /** The figures last chosen, or null before any. */
  figures: AreaFigures | null;
  choose(figures: AreaFigures): void;
}

export function useAreaSearch(shown: SessionId, returnFocus: () => void): AreaSearchState {
  const [session, setSession] = useState<SessionId | null>(null);
  const [figures, choose] = useState<AreaFigures | null>(null);
  // Only for a character that exists: a refusal needs a console to be said in.
  const open = useCallback(() => setSession(shown === NO_SESSION ? null : shown), [shown]);
  const close = useCallback(() => {
    setSession(null);
    returnFocus();
  }, [returnFocus]);
  return useMemo(
    () => ({ session, open, close, figures, choose }),
    [session, open, close, figures]
  );
}
