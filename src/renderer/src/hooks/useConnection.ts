/**
 * Dialling and hanging up: the shown character's own, from the palette, the
 * status rail and `Ctrl/Cmd Enter`, and any character's from its own tab.
 * Addressed throughout, since a button that acted on the shown character
 * would drop the wrong one.
 *
 * Out of `App` (todo 733). See `mudengine-ui` › `parts/cards.md`, *A tab
 * dials its own character*.
 */
import { useCallback } from 'react';

import type { SessionView, SessionViews } from './useSessionViews';
import { EMPTY_CHARACTER } from '@shared/character';
import type { IpcApi, SessionId, SessionSummary } from '@shared/ipc';
import type { ConnectionTarget } from '@shared/types';

export interface ConnectionInputs {
  api: Pick<IpcApi, 'connect' | 'disconnect'>;
  /** The character on screen. */
  session: SessionId;
  /** The character on screen as a callback reads it, which must not go stale. */
  shown: { readonly current: SessionId };
  /** The roster, which says whether a retry is pending. */
  sessions: readonly Pick<SessionSummary, 'id' | 'retrying'>[];
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
  sessions,
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
   * Refused while a dial or a close is already in flight. `connect()` in main
   * refuses a second attempt itself, so this is about the button rather than
   * the socket: one that stays pressable through a fifteen-second dial reads as
   * one that did nothing.
   */
  const toggleSessionConnection = useCallback(
    (id: SessionId) => {
      const phase = views[id]?.state.phase ?? 'idle';
      if (phase === 'connecting' || phase === 'closing') return;
      /*
       * **A retry pending counts as connected for this button**, because the
       * question it answers is *is something dialling this character* and
       * during a ladder's wait the phase is `closed`. Without it the dial
       * offered Connect while a reconnect ran to its 999,999th attempt, and
       * nothing anywhere in the client meant *stop trying* — with a bad
       * password going out every fifteen seconds if the realm hangs up on one.
       */
      if (phase === 'connected' || (sessions.find((s) => s.id === id)?.retrying ?? false)) {
        hangUp(id);
      } else dial(id);
    },
    [dial, hangUp, sessions, views]
  );

  const toggleConnection = useCallback(() => {
    if (connected) handleDisconnect();
    else handleConnect();
  }, [connected, handleConnect, handleDisconnect]);

  return { dial, hangUp, handleConnect, toggleSessionConnection, toggleConnection };
}
