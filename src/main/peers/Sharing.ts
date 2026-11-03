/**
 * Which of this install's characters the gateway hears of, and what each
 * character's window is shown of sharing (todo 20261031-1156-01). A
 * character is claimed once the realm has confirmed its name, with sharing
 * on (`peers.enabled`) and a row on its players that shares or receives: off
 * by default, the user's answer of 2026-11-02. Its key pair for the realm is
 * made then, the first time a share needs it. Every change to the rows, the
 * name or the realm claims again; a character's sheet goes to the link on
 * every change to its state while it is claimed.
 */
import type { Ed25519Pair } from '../../node/ed25519';
import type { CharacterState } from '../../shared/character';
import type { SessionId } from '../../shared/ipc';
import type { PeerGrant } from '../../shared/peerGrant';
import {
  isPeerName,
  NO_SHARES,
  peerKeyText,
  type PeerKey,
  type SharedSheet,
  type ShareView
} from '../../shared/peers';
import { MOST_SHARE_NAMES, type ShareEntry } from '../../shared/peerWire';
import { playerKey } from '../../shared/players';
import { errorMessage, sameJson } from '../../shared/values';
import type { Accepts, PeerBook } from './PeerBook';
import type { Claimant, PeerLink } from './PeerLink';
import { peerSheetOf } from './peerSheet';
import type { PinReports } from './PinReports';

/** A session as sharing reads it: the realm it plays (`realmName`) and its players' rows. */
export interface SharingSession {
  readonly id: SessionId;
  readonly realm: string;
  readonly grants: Readonly<Record<string, PeerGrant>>;
}

export interface SharingDeps {
  /** `peers.enabled`, read through. */
  enabled(): boolean;
  sessions(): readonly SharingSession[];
  pairFor(id: SessionId, realm: string): Promise<Ed25519Pair>;
  link: Pick<PeerLink, 'want' | 'observe' | 'link'>;
  book: Pick<PeerBook, 'sheetsFor' | 'offersFor'>;
  reports: Pick<PinReports, 'reportsFor'>;
  publish(id: SessionId, view: ShareView): void;
  /** A character's key could not be read or made. */
  fault(id: SessionId, message: string): void;
}

const shared = (
  entry: [string, PeerGrant]
): entry is [string, PeerGrant & { share: ShareEntry['share'] }] => entry[1].share !== 'off';

export class Sharing {
  /** Each session's name, once the realm has confirmed it. */
  private readonly names = new Map<SessionId, string>();
  /** Each claimed session's key and pair. */
  private readonly claimed = new Map<SessionId, { peer: PeerKey; pair: Ed25519Pair }>();
  /** What each window was last shown, so an unchanged view is not pushed again. */
  private readonly shown = new Map<SessionId, ShareView>();
  private refreshing: Promise<void> | null = null;
  private again = false;

  constructor(private readonly deps: SharingDeps) {}

  /** A character's state: its name, and its sheet while claimed. */
  observe(id: SessionId, state: CharacterState): void {
    const name = state.phase === 'in-game' && isPeerName(state.name) ? state.name : null;
    if ((this.names.get(id) ?? null) !== name) {
      if (name === null) this.names.delete(id);
      else this.names.set(id, name);
      this.refresh();
    }
    const claim = this.claimed.get(id);
    if (claim !== undefined) this.deps.link.observe(claim.peer, peerSheetOf(state));
  }

  forget(id: SessionId): void {
    this.names.delete(id);
    this.shown.delete(id);
    this.refresh();
  }

  /** Claim again from the rows as they are now; one run at a time, the last asked for winning. */
  refresh(): void {
    if (this.refreshing !== null) {
      this.again = true;
      return;
    }
    this.refreshing = this.claimAll().finally(() => {
      this.refreshing = null;
      if (!this.again) return;
      this.again = false;
      this.refresh();
    });
  }

  /** The sheets `id`'s player accepted, fresh, from its own realm. */
  sheetsFor(id: SessionId): SharedSheet[] {
    const claim = this.claimed.get(id);
    return claim === undefined ? [] : this.deps.book.sheetsFor(claim.peer, this.accepts(id));
  }

  /** What `id`'s window was last shown. */
  view(id: SessionId): ShareView {
    return this.shown.get(id) ?? NO_SHARES;
  }

  /** Every window's view, pushed where it changed. */
  publish(): void {
    for (const session of this.deps.sessions()) {
      const view = this.viewOf(session);
      if (sameJson(this.shown.get(session.id), view)) continue;
      this.shown.set(session.id, view);
      this.deps.publish(session.id, view);
    }
  }

  private viewOf(session: SharingSession): ShareView {
    const claim = this.claimed.get(session.id);
    if (claim === undefined) return NO_SHARES;
    const accepts = this.accepts(session.id);
    return {
      link: this.deps.link.link,
      ownKey: claim.pair.publicKey,
      unpinned: this.deps.reports.reportsFor(claim.peer, (name) => accepts(name).keys),
      offered: this.deps.book.offersFor(claim.peer, accepts),
      sheets: this.deps.book.sheetsFor(claim.peer, accepts)
    };
  }

  private accepts(id: SessionId): Accepts {
    const grants = this.deps.sessions().find((session) => session.id === id)?.grants ?? {};
    return (name) => {
      const grant = grants[playerKey(name)];
      return { receive: grant?.receive ?? false, keys: grant?.keys ?? [] };
    };
  }

  private async claimAll(): Promise<void> {
    const claimants: Claimant[] = [];
    const claimed = new Map<SessionId, { peer: PeerKey; pair: Ed25519Pair }>();
    if (this.deps.enabled()) {
      for (const session of this.deps.sessions()) {
        const claimant = await this.claimantOf(session);
        if (claimant === null) continue;
        claimants.push(claimant);
        claimed.set(session.id, { peer: claimant.peer, pair: claimant.pair });
      }
    }
    // Two sessions on one character claim it once.
    const unique = new Map(claimants.map((each) => [peerKeyText(each.peer), each]));
    this.claimed.clear();
    for (const [id, claim] of claimed) this.claimed.set(id, claim);
    this.deps.link.want([...unique.values()]);
    this.publish();
  }

  private async claimantOf(session: SharingSession): Promise<Claimant | null> {
    const name = this.names.get(session.id);
    if (name === undefined) return null;
    const rows = Object.entries(session.grants);
    const shares = rows
      .filter(shared)
      .filter(([who]) => isPeerName(who))
      .slice(0, MOST_SHARE_NAMES)
      .map(([who, grant]): ShareEntry => ({
        name: who,
        share: grant.share,
        keys: [...grant.keys]
      }));
    if (shares.length === 0 && !rows.some(([, grant]) => grant.receive)) return null;
    try {
      const pair = await this.deps.pairFor(session.id, session.realm);
      return { peer: { realm: session.realm, name }, pair, shares };
    } catch (error) {
      this.deps.fault(session.id, errorMessage(error));
      return null;
    }
  }
}
