/**
 * The characters other players share with this install, for the tab rail's
 * Sharing with you section (todo 20261031-1156-01). A sharer may share with
 * more than one of this install's characters, so each is listed once,
 * reached through the first on the rail it gives control, else the first it
 * shares with. One opened is a session of its own on the roster
 * (`SessionSummary.remote`), and its row is that session's tab. Only fresh
 * sheets under a confirmed key reach a `ShareView`, so a sharer gone quiet
 * and not opened drops off the list.
 */
import type { SessionId, SessionSummary } from '@shared/ipc';
import { newestSheets, peerKeyText, type PeerSheet, type ShareView } from '@shared/peers';
import { playerKey } from '@shared/players';

export interface RemoteCharacter {
  /** Its identity on the list: realm and name. */
  readonly id: string;
  readonly name: string;
  readonly sheet: PeerSheet;
  /** Whether it gives this install remote control. */
  readonly control: boolean;
  /** The character of this install it is shared with, and is opened through. */
  readonly via: SessionId;
  readonly viaName: string;
}

/** Each sharer once, in the order of the rail's characters that first take it. */
export function remoteCharacters(
  sessions: readonly { readonly id: SessionId; readonly name: string }[],
  views: ReadonlyMap<SessionId, ShareView>
): RemoteCharacter[] {
  const chosen = new Map<string, RemoteCharacter>();
  for (const session of sessions) {
    const view = views.get(session.id);
    if (view === undefined) continue;
    for (const shared of newestSheets(view.sheets).values()) {
      const id = peerKeyText(shared.from);
      const held = chosen.get(id);
      if (held !== undefined && (held.control || !shared.control)) continue;
      chosen.set(id, {
        id,
        name: shared.from.name,
        sheet: shared.sheet,
        control: shared.control,
        via: session.id,
        viaName: session.name
      });
    }
  }
  return [...chosen.values()];
}

/** The session of the roster that is `name` opened, or undefined while it is not. */
export const openedAs = (
  opened: readonly SessionSummary[],
  name: string
): SessionSummary | undefined => opened.find((each) => playerKey(each.name) === playerKey(name));
