/**
 * The two trip dialogs the palette opens, Search the area and Cash run: each
 * one's state, and one pair of openers so the palette takes them together.
 * The cash run's state is only which character it is open for; closing it
 * hands the caret back.
 */
import { useCallback, useMemo, useState } from 'react';

import { NO_SESSION, type SessionId } from '@shared/ipc';
import { useAreaSearch, type AreaSearchState } from './useAreaSearch';

export interface CashRunState {
  /** The character the dialog is open for; null while it is closed. */
  session: SessionId | null;
  close(): void;
}

export interface TripDialogs {
  area: AreaSearchState;
  cash: CashRunState;
  /** Each opens its dialog for the shown character; nothing without one. */
  opens: { areaSearch(): void; cashRun(): void };
}

export function useTripDialogs(shown: SessionId, returnFocus: () => void): TripDialogs {
  const area = useAreaSearch(shown, returnFocus);
  const [session, setSession] = useState<SessionId | null>(null);
  const openCash = useCallback(() => setSession(shown === NO_SESSION ? null : shown), [shown]);
  const close = useCallback(() => {
    setSession(null);
    returnFocus();
  }, [returnFocus]);
  const cash = useMemo(() => ({ session, close }), [session, close]);
  const opens = useMemo(
    () => ({ areaSearch: area.open, cashRun: openCash }),
    [area.open, openCash]
  );
  return useMemo(() => ({ area, cash, opens }), [area, cash, opens]);
}
