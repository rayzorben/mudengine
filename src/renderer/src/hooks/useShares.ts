/**
 * What one character shares and is shared (todo 20261031-1156-01), as main
 * holds it: read when a panel opens on it and followed while it stays open.
 * Null asks for nothing and answers that nothing is shared.
 */
import { useEffect, useState } from 'react';

import { followShares, type SharesApi } from '../lib/shares';
import type { IpcApi, SessionId } from '@shared/ipc';
import { isRemoteSessionId } from '@shared/peerRelay';
import { NO_SHARES, type ShareView } from '@shared/peers';

/** And the call that opens a shared character's terminal for remote control. */
export type SharedControlApi = SharesApi & Pick<IpcApi, 'controlOpen'>;

export function useShares(api: SharesApi, session: SessionId | null): ShareView {
  const [view, setView] = useState<ShareView>(NO_SHARES);
  useEffect(() => {
    setView(NO_SHARES);
    // A character controlled from here shares nothing of its own here; its sharer's client holds that.
    if (session === null || isRemoteSessionId(session)) return;
    return followShares(api, [session], (_, current) => setView(current));
  }, [api, session]);
  return view;
}
