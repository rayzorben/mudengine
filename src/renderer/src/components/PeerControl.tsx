/**
 * The banner over a character's console while another player controls it
 * (todo 20261031-1156-01), with Stop. It comes from main's `ShareView`, so a
 * window that opens or reloads shows what is so now. A character this window
 * controls is a session of its own (`RemoteTabs`), shown as any is.
 */
import { memo, useCallback } from 'react';

import ControlledBanner from './ControlledBanner';
import { useShares } from '../hooks/useShares';
import type { SharesApi } from '../lib/shares';
import type { IpcApi, SessionId } from '@shared/ipc';

export type PeerControlApi = SharesApi & Pick<IpcApi, 'controlStop'>;

export interface PeerControlProps {
  api: PeerControlApi;
  session: SessionId;
}

function PeerControl({ api, session }: PeerControlProps) {
  const { controlledBy } = useShares(api, session);
  const stop = useCallback(() => {
    void api.controlStop(session);
  }, [api, session]);
  return <ControlledBanner by={controlledBy} onStop={stop} />;
}

export default memo(PeerControl);
