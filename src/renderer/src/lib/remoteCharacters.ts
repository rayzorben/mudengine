/**
 * The characters other players share with this install, for the tab rail's
 * Sharing with you section (todo 20261031-1156-01). A sharer may share with
 * more than one of this install's characters, so each is listed once, reached
 * through the one of them that controls it, else one it gives control, else
 * the first on the rail. A character under control is listed while the
 * control lasts, its figures unknown once its sheet is not fresh, so every
 * pane showing a remote console has its tab. Only one of this install's
 * characters may control a sharer (`Controlling.open`).
 */
import type { SessionId } from '@shared/ipc';
import {
  newestSheets,
  peerKeyText,
  UNKNOWN_PEER_SHEET,
  type KeyOffer,
  type PeerSheet,
  type ShareView
} from '@shared/peers';
import { playerKey } from '@shared/players';

export interface RemoteCharacter {
  /** Its identity on the list: realm and name, or the controlling character for one with no sheet. */
  readonly id: string;
  readonly name: string;
  /** The key it shares under. */
  readonly key: string;
  readonly sheet: PeerSheet;
  /** Whether it gives this install remote control. */
  readonly control: boolean;
  /** The character of this install it is shared with, whose pane its console opens over. */
  readonly via: SessionId;
  readonly viaName: string;
  /** Whether `via` controls it now. */
  readonly controlled: boolean;
}

/** How strongly a character of this install is the one to reach a sharer through. */
const rank = (each: RemoteCharacter): number => (each.controlled ? 2 : each.control ? 1 : 0);

const isOffer = (offer: KeyOffer, each: RemoteCharacter): boolean =>
  offer.key === each.key && playerKey(offer.name) === playerKey(each.name);

/** Each sharer once, in the order of the rail's characters that first take it. */
export function remoteCharacters(
  sessions: readonly { readonly id: SessionId; readonly name: string }[],
  views: ReadonlyMap<SessionId, ShareView>
): RemoteCharacter[] {
  const chosen = new Map<string, RemoteCharacter>();
  const offer = (each: RemoteCharacter): void => {
    const held = chosen.get(each.id);
    if (held === undefined || rank(each) > rank(held)) chosen.set(each.id, each);
  };
  // Controls whose own view holds no fresh sheet of the character controlled.
  const unsheeted: RemoteCharacter[] = [];
  for (const session of sessions) {
    const view = views.get(session.id);
    if (view === undefined) continue;
    const via = { via: session.id, viaName: session.name };
    let placed = false;
    for (const shared of newestSheets(view.sheets).values()) {
      const each: RemoteCharacter = {
        id: peerKeyText(shared.from),
        name: shared.from.name,
        key: shared.key,
        sheet: shared.sheet,
        control: shared.control,
        ...via,
        controlled: false
      };
      const controlled = view.controlling !== null && isOffer(view.controlling, each);
      placed ||= controlled;
      offer({ ...each, controlled });
    }
    if (view.controlling !== null && !placed) {
      unsheeted.push({
        id: `control:${session.id}`,
        name: view.controlling.name,
        key: view.controlling.key,
        sheet: UNKNOWN_PEER_SHEET,
        control: true,
        ...via,
        controlled: true
      });
    }
  }
  // Another character's fresh sheet of it keeps its row, reached through the one controlling it.
  for (const control of unsheeted) {
    const listed = [...chosen.values()].find((each) => isOffer(control, each));
    if (listed === undefined) chosen.set(control.id, control);
    else
      chosen.set(listed.id, {
        ...listed,
        via: control.via,
        viaName: control.viaName,
        controlled: true
      });
  }
  return [...chosen.values()];
}

/** The characters of this install controlling a shared one, from the same views as the list. */
export function controllers(views: ReadonlyMap<SessionId, ShareView>): ReadonlySet<SessionId> {
  return new Set([...views].filter(([, view]) => view.controlling !== null).map(([id]) => id));
}

/** Whether `session`'s pane shows the remote console of the character it controls. */
export function showsRemote(
  controlling: ReadonlySet<SessionId>,
  session: SessionId,
  aside: ReadonlySet<SessionId>
): boolean {
  return controlling.has(session) && !aside.has(session);
}
