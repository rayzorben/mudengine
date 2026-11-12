/**
 * Remote control over one character's console (todo 20261031-1156-01): the
 * banner its player sees while another player controls it, and the remote
 * console while it controls a character shared with it. Both come from
 * main's `ShareView`, so a window that opens or reloads shows what is so now.
 */
import { memo, useCallback, useEffect } from 'react';

import ControlledBanner from './ControlledBanner';
import RemoteConsole, { type RemoteConsoleApi } from './RemoteConsole';
import { useRemoteAside } from '../hooks/useRemoteCharacters';
import { useShares } from '../hooks/useShares';
import { remoteAside } from '../lib/remoteAside';
import type { SharesApi } from '../lib/shares';
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
  // Set aside by this character's own tab; a control opened anew, by any way in, is shown, and one ended forgotten.
  const aside = useRemoteAside().has(session);
  const watching = controlling === null ? null : `${controlling.name}:${controlling.key}`;
  useEffect(() => {
    remoteAside.set(session, false);
  }, [session, watching]);
  const stop = useCallback(() => {
    void api.controlStop(session);
  }, [api, session]);
  return (
    <>
      <ControlledBanner by={controlledBy} onStop={stop} />
      {controlling !== null && (
        <RemoteConsole
          api={api}
          aside={aside}
          fontStack={fontStack}
          // Its own mount per character watched, so the backlog is asked for each time.
          key={`${session}:${watching}`}
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
