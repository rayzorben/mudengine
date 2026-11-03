/**
 * The gateway's reports to a sharer of claims its grants do not hold
 * (`unpinned`, todo 20261031-1156-01): a name this character shares with,
 * claimed under a key its player has not pinned. Shown to the player to pin
 * or not, never pinned by themselves, since anybody can claim a name. The
 * gateway reports each claim once a socket, so a lost socket clears them and
 * the next one reports them again.
 */
import { peerKeyText, type KeyOffer, type PeerKey } from '../../shared/peers';
import { MOST_SHARE_KEYS, MOST_SHARE_NAMES } from '../../shared/peerWire';
import { playerKey } from '../../shared/players';

/** The gateway sends at most this many a name, for at most this many names a sharer. */
const MOST_REPORTS = MOST_SHARE_KEYS * MOST_SHARE_NAMES;

export class PinReports {
  private readonly bySharer = new Map<string, Map<string, KeyOffer>>();

  report(sharer: PeerKey, name: string, key: string): void {
    const id = peerKeyText(sharer);
    const reports = this.bySharer.get(id) ?? new Map<string, KeyOffer>();
    if (reports.size >= MOST_REPORTS) return;
    reports.set(`${playerKey(name)}\u0000${key}`, { name, key });
    this.bySharer.set(id, reports);
  }

  /** The claims `sharer` was told of that its grants still do not hold. */
  reportsFor(sharer: PeerKey, pinned: (name: string) => readonly string[]): KeyOffer[] {
    const reports = this.bySharer.get(peerKeyText(sharer));
    if (reports === undefined) return [];
    return [...reports.values()].filter((each) => !pinned(each.name).includes(each.key));
  }

  clear(): void {
    this.bySharer.clear();
  }
}
