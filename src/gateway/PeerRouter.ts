/**
 * Who hears whom. A claim is a name and the key that proved it on one socket;
 * the same name may be claimed under several keys at once, since one player
 * plays a character from more than one install. Each sharing claim's list
 * names characters in its own realm, so nothing crosses to another, and the
 * receiver keys each grant holds. Only a claim under one of those keys is sent
 * anything. A claim under any other key, a grant with none included, is
 * unknown: the sharer is told it (`unpinned`, the first `MOST_SHARE_KEYS` of
 * each name, so a flood of claims costs a bounded scan and bounded frames)
 * and it is sent nothing. Each sharer's last whole sheet is
 * kept current with its patches, so an install that starts listening is sent
 * the whole first. A sharer is told who is listening (`audience`) and sends
 * only while somebody is. The sheet is never read, only patched.
 */
import { applyPatch } from '../shared/patches';
import { peerKeyText, type PeerKey } from '../shared/peers';
import {
  MOST_SHARE_KEYS,
  type Listener,
  type PeerDown,
  type RefusedWhy,
  type ShareEntry,
  type SheetPatch
} from '../shared/peerWire';
import { playerKey } from '../shared/players';

/** An install's socket, as the router sends to it. */
export interface InstallLine {
  send(frame: PeerDown): void;
}

interface Claim {
  readonly peer: PeerKey;
  readonly key: string;
  readonly line: InstallLine;
  /** The name's `peerKeyText`. */
  readonly name: string;
}

/** One claim's id: the name and the key that proved it. */
const claimId = (name: string, key: string): string => `${name}\u0000${key}`;

export class PeerRouter {
  /** Each claim, by `claimId`. */
  private readonly claims = new Map<string, Claim>();
  /** Each name's claims, by the name's `peerKeyText`. */
  private readonly byName = new Map<string, Set<string>>();
  /** Each socket's claims, by name. */
  private readonly lines = new Map<InstallLine, Map<string, string>>();
  /** Each sharing claim's list. */
  private readonly shares = new Map<string, readonly ShareEntry[]>();
  /** For each name, the sharing claims that list it. */
  private readonly listedBy = new Map<string, Set<string>>();
  /** Each sharing claim's sheet as last sent, while somebody listens. */
  private readonly sheets = new Map<string, Record<string, unknown>>();
  /** Each sharing claim's listening installs, and the names each was last told it shares with. */
  private readonly delivered = new Map<string, Map<InstallLine, string>>();
  /** The audience each sharing claim was last told. */
  private readonly audiences = new Map<string, string>();
  /** The claims each sharer was told its grant does not hold, so each is said once. */
  private readonly unpinned = new Map<string, ReadonlySet<string>>();

  /** `mostSheetBytes`: a sheet patched past this is refused, as a frame that size would be. */
  constructor(private readonly mostSheetBytes: number) {}

  /**
   * `peer` is `line`'s under `key`, the key proved. A claim of the same name
   * and key elsewhere gives way; one under another key stays.
   */
  claim(line: InstallLine, peer: PeerKey, key: string): void {
    const name = peerKeyText(peer);
    const id = claimId(name, key);
    if (this.claims.has(id)) this.drop(id);
    const before = this.lines.get(line)?.get(name);
    if (before !== undefined) this.drop(before);
    this.claims.set(id, { peer, key, line, name });
    this.byName.set(name, (this.byName.get(name) ?? new Set<string>()).add(id));
    this.lines.set(line, (this.lines.get(line) ?? new Map<string, string>()).set(name, id));
    for (const sharer of this.listedBy.get(name) ?? []) this.refresh(sharer);
  }

  /** How many characters `line` holds. */
  heldBy(line: InstallLine): number {
    return this.lines.get(line)?.size ?? 0;
  }

  leave(line: InstallLine, peer: PeerKey): RefusedWhy | null {
    const id = this.owned(line, peer);
    if (id === null) return 'not-claimed';
    this.drop(id);
    return null;
  }

  /** Everything `line` held, gone with its socket. */
  dropLine(line: InstallLine): void {
    for (const id of [...(this.lines.get(line)?.values() ?? [])]) this.drop(id);
  }

  setShares(line: InstallLine, peer: PeerKey, to: readonly ShareEntry[]): RefusedWhy | null {
    const id = this.owned(line, peer);
    if (id === null) return 'not-claimed';
    this.list(id, peer.realm, to);
    this.refresh(id);
    return null;
  }

  /**
   * A whole sheet, relayed to every listening install. One that arrives after
   * the last listener went is the sharer not yet told, and is not kept.
   */
  sheet(line: InstallLine, peer: PeerKey, sheet: Record<string, unknown>): RefusedWhy | null {
    const id = this.owned(line, peer);
    if (id === null) return 'not-claimed';
    const listening = this.delivered.get(id);
    if (listening === undefined) return null;
    this.sheets.set(id, sheet);
    const { key } = this.claims.get(id)!;
    for (const each of listening.keys()) each.send({ k: 'sheet', from: peer, key, sheet });
    return null;
  }

  patch(line: InstallLine, peer: PeerKey, patch: SheetPatch): RefusedWhy | null {
    const id = this.owned(line, peer);
    if (id === null) return 'not-claimed';
    const listening = this.delivered.get(id);
    if (listening === undefined) return null;
    const held = this.sheets.get(id);
    if (held === undefined) return 'no-sheet';
    let next: Record<string, unknown>;
    try {
      next = applyPatch(held, patch, 'sheet');
    } catch {
      // A patch that does not fit the sheet it was sent against: the install is off the wire.
      return 'malformed';
    }
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > this.mostSheetBytes) return 'malformed';
    this.sheets.set(id, next);
    const { key } = this.claims.get(id)!;
    for (const each of listening.keys()) each.send({ k: 'patch', from: peer, key, ...patch });
    return null;
  }

  /** The claim `line` holds of `peer`'s name, or null. */
  private owned(line: InstallLine, peer: PeerKey): string | null {
    return this.lines.get(line)?.get(peerKeyText(peer)) ?? null;
  }

  /** A sharer's list replaced, and the index of who lists whom with it. */
  private list(id: string, realm: string, to: readonly ShareEntry[]): void {
    for (const entry of this.shares.get(id) ?? []) {
      const receiver = peerKeyText({ realm, name: entry.name });
      const sharers = this.listedBy.get(receiver);
      sharers?.delete(id);
      if (sharers?.size === 0) this.listedBy.delete(receiver);
    }
    if (to.length === 0) this.shares.delete(id);
    else this.shares.set(id, to);
    for (const entry of to) {
      const receiver = peerKeyText({ realm, name: entry.name });
      this.listedBy.set(receiver, (this.listedBy.get(receiver) ?? new Set<string>()).add(id));
    }
  }

  /** A claim gone: as a sharer its listeners are told, and as a receiver its sharers recount. */
  private drop(id: string): void {
    const claim = this.claims.get(id);
    if (claim === undefined) return;
    this.claims.delete(id);
    const named = this.byName.get(claim.name);
    named?.delete(id);
    if (named?.size === 0) this.byName.delete(claim.name);
    const held = this.lines.get(claim.line);
    held?.delete(claim.name);
    if (held?.size === 0) this.lines.delete(claim.line);
    this.list(id, claim.peer.realm, []);
    for (const line of this.delivered.get(id)?.keys() ?? []) {
      line.send({ k: 'gone', from: claim.peer, key: claim.key, why: 'left' });
    }
    this.delivered.delete(id);
    this.sheets.delete(id);
    this.audiences.delete(id);
    this.unpinned.delete(id);
    for (const sharer of this.listedBy.get(claim.name) ?? []) this.refresh(sharer);
  }

  /** Who hears sharing claim `id` now, and everybody told what changed. */
  private refresh(id: string): void {
    const sharer = this.claims.get(id);
    if (sharer === undefined) return;
    const byLine = new Map<InstallLine, string[]>();
    const listeners: Listener[] = [];
    const unpinned: Claim[] = [];
    for (const entry of this.shares.get(id) ?? []) {
      const name = peerKeyText({ realm: sharer.peer.realm, name: entry.name });
      for (const key of entry.keys) {
        const receiver = this.claims.get(claimId(name, key));
        if (receiver === undefined) continue;
        listeners.push({ name: receiver.peer.name, key });
        byLine.set(receiver.line, [...(byLine.get(receiver.line) ?? []), receiver.peer.name]);
      }
      unpinned.push(...this.unpinnedOf(name, entry.keys));
    }
    this.tellReceivers(id, sharer, byLine);
    this.tellSharer(id, sharer, listeners, unpinned);
  }

  /** The first `MOST_SHARE_KEYS` claims of `name` under keys `pinned` does not hold. */
  private unpinnedOf(name: string, pinned: readonly string[]): Claim[] {
    const found: Claim[] = [];
    for (const receiverId of this.byName.get(name) ?? []) {
      if (found.length >= MOST_SHARE_KEYS) break;
      const receiver = this.claims.get(receiverId)!;
      if (!pinned.includes(receiver.key)) found.push(receiver);
    }
    return found;
  }

  private tellReceivers(id: string, sharer: Claim, byLine: Map<InstallLine, string[]>): void {
    const { peer: from, key } = sharer;
    const told = this.delivered.get(id) ?? new Map<InstallLine, string>();
    for (const line of told.keys()) {
      if (!byLine.has(line)) line.send({ k: 'gone', from, key, why: 'unshared' });
    }
    const sheet = this.sheets.get(id);
    const next = new Map<InstallLine, string>();
    for (const [line, names] of byLine) {
      const text = JSON.stringify(names);
      next.set(line, text);
      if (told.get(line) === text) continue;
      line.send({ k: 'shared', from, key, to: names });
      if (!told.has(line) && sheet !== undefined) line.send({ k: 'sheet', from, key, sheet });
    }
    if (next.size > 0) {
      this.delivered.set(id, next);
      return;
    }
    this.delivered.delete(id);
    // Nobody listens, so the sharer stops sending; what it sent last would go stale here.
    this.sheets.delete(id);
  }

  private tellSharer(
    id: string,
    sharer: Claim,
    listeners: readonly Listener[],
    unpinned: readonly Claim[]
  ): void {
    const audience = JSON.stringify(listeners);
    if (this.audiences.get(id) !== audience) {
      this.audiences.set(id, audience);
      sharer.line.send({ k: 'audience', peer: sharer.peer, to: [...listeners] });
    }
    const said = this.unpinned.get(id) ?? new Set<string>();
    const now = new Set<string>();
    for (const receiver of unpinned) {
      const each = claimId(playerKey(receiver.peer.name), receiver.key);
      now.add(each);
      if (said.has(each)) continue;
      const { name } = receiver.peer;
      sharer.line.send({ k: 'unpinned', peer: sharer.peer, name, key: receiver.key });
    }
    this.unpinned.set(id, now);
  }
}
