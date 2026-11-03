/**
 * Remote control over one character's console (todo 20261031-1156-01): the
 * banner its player sees while another player controls it, and the remote
 * console while it controls a character shared with it. Both come from
 * main's `ShareView`, so a window that opens or reloads shows what is so now.
 */
import { memo, useCallback } from 'react';

import ControlledBanner from './ControlledBanner';
import RemoteConsole, { type RemoteConsoleApi } from './RemoteConsole';
import { useShares, type SharesApi } from '../hooks/useShares';
import type { TerminalConfig } from '@shared/config';
import type { IpcApi, SessionId } from '@shared/ipc';
import type { TerminalPalette } from '@shared/themes';

export type PeerControlApi = SharesApi & RemoteConsoleApi & Pick<IpcApi, 'controlStop'>;

export interface PeerControlProps {
  api: PeerControlApi;
  session: SessionId;
  settings: TerminalConfig;
  fontStack: string;
  palette: TerminalPalette;
}

function PeerControl({ api, session, settings, fontStack, palette }: PeerControlProps) {
  const { controlledBy, controlling } = useShares(api, session);
  const stop = useCallback(() => {
    void api.controlStop(session);
  }, [api, session]);
  return (
    <>
      <ControlledBanner by={controlledBy} onStop={stop} />
      {controlling !== null && (
        <RemoteConsole
          api={api}
          fontStack={fontStack}
          // Its own mount per character watched, so the backlog is asked for each time.
          key={`${session}:${controlling.name}:${controlling.key}`}
          name={controlling.name}
          palette={palette}
          session={session}
          settings={settings}
        />
      )}
    </>
  );
}

export default memo(PeerControl);
