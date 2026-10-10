/**
 * Dialling and hanging up: the shown character's own, from the palette, the
 * status rail and its keys (`useConnectionKeys`), and any character's from its
 * own tab.
 * Addressed throughout, since a button that acted on the shown character
 * would drop the wrong one.
 *
 * Out of `App` (todo 733). See `mudengine-ui` › `parts/cards.md`, *A tab
 * dials its own character*.
 */
import { useCallback } from 'react';

import { useConnectionKeys } from './useConnectionKeys';
import type { SessionView, SessionViews } from './useSessionViews';
import { EMPTY_CHARACTER } from '@shared/character';
import type { IpcApi, SessionId } from '@shared/ipc';
import { dialWaits, type ConnectionTarget } from '@shared/types';

export interface ConnectionInputs {
  api: Pick<IpcApi, 'connect' | 'disconnect'>;
  /** The character on screen. */
  session: SessionId;
  /** The character on screen as a callback reads it, which must not go stale. */
  shown: { readonly current: SessionId };
  views: Readonly<Record<SessionId, SessionView>>;
  patchView: SessionViews['patchView'];
  /** Whether the shown character is connected. */
  connected: boolean;
  /** Clears the throughput meter, which reads the shown character. */
  reset(): void;
}

export function useConnection({
  api,
  session,
  shown,
  views,
  patchView,
  connected,
  reset
}: ConnectionInputs) {
  /**
   * Dial the character being shown.
   *
   * No address: where a character connects is a property of the character, and
   * it lives in that character's file. A target is passed only by the palette's
   * saved-server entries, which are the ad-hoc path.
   */
  const dial = useCallback(
    (id: SessionId, target?: ConnectionTarget) => {
      // Only this character's history: a reconnect on one must not wipe what
      // the tab rail is reporting about the others.
      patchView(id, (v) => ({ ...v, telnet: [], lines: [], character: EMPTY_CHARACTER }));
      // The throughput meter reads the character on screen, so it is cleared
      // only when that is the one being dialled — a reconnect on an unattended
      // character must not blank the readout for the one being watched.
      if (id === shown.current) reset();
      void api.connect(id, target);
    },
    [api, patchView, reset]
  );

  const hangUp = useCallback((id: SessionId) => void api.disconnect(id), [api]);

  const handleConnect = useCallback(
    (target?: ConnectionTarget) => dial(session, target),
    [dial, session]
  );

  const handleDisconnect = useCallback(() => hangUp(session), [hangUp, session]);

  /**
   * Dial or hang up a character from its own tab.
   *
   * Addressed, and deliberately not `toggleConnection`: the rail reports on the
   * characters nobody is looking at, so the one being connected is usually not
   * the one on screen — and a button that quietly acted on the *shown*
   * character would disconnect the wrong one, which on this realm costs
   * something (docs/greatermud/combat.md).
   *
   * A character not in the realm can always be dialled now (todo 22): during
   * a dial still waiting on the socket main gives it up and dials again, and
   * during a reconnect's wait it dials at once. Stopping the reconnect is the
   * tab's other control (`hangUp`). Only a close under way is waited for.
   */
  const toggleSessionConnection = useCallback(
    (id: SessionId) => {
      const phase = views[id]?.state.phase ?? 'idle';
      if (dialWaits(phase)) return;
      if (phase === 'connected') hangUp(id);
      else dial(id);
    },
    [dial, hangUp, views]
  );

  const toggleConnection = useCallback(() => {
    if (connected) handleDisconnect();
    else handleConnect();
  }, [connected, handleConnect, handleDisconnect]);

  useConnectionKeys(toggleConnection, handleDisconnect);

  return { dial, hangUp, handleConnect, toggleSessionConnection, toggleConnection };
}
