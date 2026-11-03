/**
 * The sheets other players' characters share with this install's (todo
 * 20261031-1156-01), as the gateway relays them: each sharer by its name and
 * the key that proved it, which of this install's characters it shares with,
 * and its sheet rebuilt from the patches. A sheet not heard of for
 * `staleMs`, or from a sharer the gateway says is gone, counts as none; a
 * dropped gateway takes every sheet with it. What a character is shown is
 * only what its player accepted (`PeerGrant.receive`) under a key the player
 * pinned; a share under any other key is an offer for the player to pin or
 * not. Every share from the realm the character plays, never another.
 */
import { applyPatch } from '../../shared/patches';
import {
  asPeerSheet,
  peerKeyText,
  type KeyOffer,
  type PeerKey,
  type PeerSheet,
  type SharedSheet
} from '../../shared/peers';
import type { PeerDown } from '../../shared/peerWire';
import { playerKey } from '../../shared/players';
import { errorMessage } from '../../shared/values';

/** The frames the book keeps. */
export type BookFrame = Extract<PeerDown, { k: 'shared' | 'sheet' | 'patch' | 'gone' }>;

interface Held {
  readonly from: PeerKey;
  readonly key: string;
  /** This install's characters it shares with, by `playerKey`. */
  to: ReadonlySet<string>;
  /** As sent, before it is read, so the next patch applies to what the sender patched. */
  raw: Record<string, unknown> | null;
  sheet: PeerSheet | null;
  heardAt: number;
}

/** What a character's player accepted: whether they take this name's share, and under which keys. */
export type Accepts = (name: string) => { receive: boolean; keys: readonly string[] };

/** More sharers than this is not players sharing with a few friends; the oldest heard goes. */
const MOST_SHARERS = 256;

export class PeerBook {
  private readonly held = new Map<string, Held>();

  constructor(
    private readonly staleMs: () => number,
    private readonly now: () => number,
    /** A sender's frame that did not fit what it sent before. */
    private readonly fault: (message: string) => void
  ) {}

  heard(frame: BookFrame): void {
    const id = `${peerKeyText(frame.from)}\u0000${frame.key}`;
    if (frame.k === 'gone') {
      this.held.delete(id);
      return;
    }
    const entry = this.held.get(id) ?? this.add(id, frame.from, frame.key);
    entry.heardAt = this.now();
    switch (frame.k) {
      case 'shared':
        entry.to = new Set(frame.to.map(playerKey));
        return;
      case 'sheet':
        this.read(entry, frame.sheet);
        return;
      case 'patch': {
        if (entry.raw === null) {
          this.fault(`${frame.from.name} sent a change before its sheet; it is ignored`);
          return;
        }
        try {
          this.read(entry, applyPatch(entry.raw, frame, frame.from.name));
        } catch (error) {
          // Unknown until the gateway sends the whole sheet again, never a sheet guessed at.
          entry.raw = null;
          entry.sheet = null;
          this.fault(`${frame.from.name}'s change did not fit its sheet: ${errorMessage(error)}`);
        }
        return;
      }
      default: {
        const never: never = frame;
        return never;
      }
    }
  }

  /** The gateway is gone, and every sheet with it. */
  clear(): void {
    this.held.clear();
  }

  /** The fresh sheets shared with `receiver` that its player accepted. */
  sheetsFor(receiver: PeerKey, accepts: Accepts): SharedSheet[] {
    const out: SharedSheet[] = [];
    for (const entry of this.sharing(receiver)) {
      const accepted = accepts(entry.from.name);
      if (!accepted.receive || !accepted.keys.includes(entry.key) || entry.sheet === null) continue;
      out.push({ from: entry.from, key: entry.key, sheet: entry.sheet, heardAt: entry.heardAt });
    }
    return out;
  }

  /** Shares with `receiver` its player takes from that name, under keys the player has not pinned. */
  offersFor(receiver: PeerKey, accepts: Accepts): KeyOffer[] {
    const out: KeyOffer[] = [];
    for (const entry of this.sharing(receiver)) {
      const accepted = accepts(entry.from.name);
      if (accepted.receive && !accepted.keys.includes(entry.key)) {
        out.push({ name: entry.from.name, key: entry.key });
      }
    }
    return out;
  }

  /** The fresh entries in `receiver`'s realm that share with it. */
  private *sharing(receiver: PeerKey): Generator<Held> {
    const cutoff = this.now() - this.staleMs();
    const name = playerKey(receiver.name);
    for (const entry of this.held.values()) {
      if (entry.from.realm !== receiver.realm || !entry.to.has(name)) continue;
      if (entry.heardAt < cutoff) continue;
      yield entry;
    }
  }

  private read(entry: Held, raw: Record<string, unknown>): void {
    const said = entry.raw !== null && entry.sheet === null;
    entry.raw = raw;
    entry.sheet = asPeerSheet(raw);
    // Said once, not on every change that follows.
    if (entry.sheet === null && !said) {
      this.fault(`${entry.from.name}'s sheet is from a build whose sheet this one does not read`);
    }
  }

  private add(id: string, from: PeerKey, key: string): Held {
    const entry: Held = { from, key, to: new Set(), raw: null, sheet: null, heardAt: this.now() };
    this.held.set(id, entry);
    if (this.held.size > MOST_SHARERS) {
      const oldest = [...this.held].reduce((a, b) => (b[1].heardAt < a[1].heardAt ? b : a));
      this.held.delete(oldest[0]);
    }
    return entry;
  }
}
