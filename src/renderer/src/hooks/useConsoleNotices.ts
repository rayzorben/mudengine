/**
 * The window's half of `lib/heldNotices.ts`: every notice main sends this
 * window is delivered there, and what waited is released whenever a console
 * registers or leaves, the tabs change, or another character is shown.
 *
 * Returns a function that prints a notice about the client in the console on
 * screen.
 */
import { useCallback, useEffect, useState } from 'react';

import type { IpcApi, SessionId, SessionSummary } from '@shared/ipc';
import { heldNotices, type NoticeConsole } from '../lib/heldNotices';

export function useConsoleNotices(
  api: Pick<IpcApi, 'onNotice'>,
  /** Every mounted console in this window, by character. */
  consoles: { readonly current: ReadonlyMap<SessionId, NoticeConsole> },
  /** The character on screen, read when a notice arrives. */
  shownRef: { readonly current: SessionId },
  shown: SessionId,
  tabs: readonly SessionSummary[],
  /** Moves when a console registers or leaves. */
  consolesMoved: number
): (message: string) => void {
  const [held] = useState(heldNotices);

  useEffect(
    () => api.onNotice((notice) => held.deliver(notice, consoles.current, shownRef.current)),
    [api, consoles, shownRef, held]
  );

  useEffect(() => {
    held.release(
      consoles.current,
      shown,
      tabs.map((entry) => entry.id)
    );
  }, [consoles, held, shown, tabs, consolesMoved]);

  return useCallback(
    (message: string) =>
      held.deliver({ session: null, message }, consoles.current, shownRef.current),
    [consoles, shownRef, held]
  );
}
