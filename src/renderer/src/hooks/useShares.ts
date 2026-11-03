/**
 * What one character shares and is shared (todo 20261031-1156-01), as main
 * holds it: read when a panel opens on it and followed while it stays open.
 * Null asks for nothing and answers that nothing is shared.
 */
import { useEffect, useState } from 'react';

import type { IpcApi, SessionId } from '@shared/ipc';
import { NO_SHARES, type ShareView } from '@shared/peers';

/** The bridge calls sharing is read through. */
export type SharesApi = Pick<IpcApi, 'shares' | 'onShares'>;

/** And the call that opens a shared character's terminal for remote control. */
export type SharedControlApi = SharesApi & Pick<IpcApi, 'controlOpen'>;

export function useShares(api: SharesApi, session: SessionId | null): ShareView {
  const [view, setView] = useState<ShareView>(NO_SHARES);
  useEffect(() => {
    setView(NO_SHARES);
    if (session === null) return;
    let live = true;
    // A push that lands before the read answers is newer than it.
    let pushed = false;
    const off = api.onShares((message) => {
      if (message.session !== session) return;
      pushed = true;
      setView(message.payload);
    });
    api.shares(session).then(
      (current) => {
        if (live && !pushed) setView(current);
      },
      (error: unknown) => console.warn(`shares: main did not answer: ${String(error)}`)
    );
    return () => {
      live = false;
      off();
    };
  }, [api, session]);
  return view;
}
