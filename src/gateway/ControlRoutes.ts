/**
 * Who is controlling whom (todo 20261031-1156-01, remote control). A claim
 * watches a sharing claim only while that sharer's list gives its name
 * `control` under its key; the router asks again on every change to the
 * list or the claims, and a watch the list no longer allows is released. A
 * watcher's actions go to the sharer, and the sharer's terminal text and
 * answers to its watchers, all relayed without being read. The sharer is
 * told who is watching (`controllers`), and is the one that runs or refuses
 * each action, against its own grant as well.
 */
import { peerKeyText, type PeerKey } from '../shared/peers';
import type { Listener, RefusedWhy, ReleasedWhy } from '../shared/peerWire';
import { claimId, type Claim } from './claims';

/** What the routes ask the router. */
export interface ControlClaims {
  claimOf(id: string): Claim | undefined;
  /** Whether sharing claim `sharer`'s list gives `controller` remote control under its key. */
  gives(sharer: string, controller: Claim): boolean;
}

const listenerOf = (claim: Claim): Listener => ({ name: claim.peer.name, key: claim.key });

export class ControlRoutes {
  /** Each sharing claim's watchers, by claim id. */
  private readonly watchers = new Map<string, Map<string, Claim>>();
  /** For each watching claim, the sharers it watches. */
  private readonly watching = new Map<string, Set<string>>();
  /** The watchers each sharer was last told. */
  private readonly told = new Map<string, string>();

  constructor(private readonly claims: ControlClaims) {}

  /** `controller` starts or stops watching the claim of `from` under `key`. */
  watch(controller: Claim, from: PeerKey, key: string, on: boolean): null {
    const sharerId = claimId(peerKeyText(from), key);
    const controllerId = claimId(controller.name, controller.key);
    if (!on) {
      this.unwatch(sharerId, controllerId);
      this.tell(sharerId);
      return null;
    }
    const sharer = this.claims.claimOf(sharerId);
    if (sharer === undefined || !this.claims.gives(sharerId, controller)) {
      controller.line.send({ k: 'released', from, key, why: 'unshared' });
      return null;
    }
    this.watchers.set(
      sharerId,
      (this.watchers.get(sharerId) ?? new Map()).set(controllerId, controller)
    );
    this.watching.set(controllerId, (this.watching.get(controllerId) ?? new Set()).add(sharerId));
    this.tell(sharerId);
    return null;
  }

  /** An action from a watcher, to the sharer it watches. */
  act(
    controller: Claim,
    from: PeerKey,
    key: string,
    id: number,
    action: Record<string, unknown>
  ): RefusedWhy | null {
    const sharerId = claimId(peerKeyText(from), key);
    const sharer = this.claims.claimOf(sharerId);
    const controllerId = claimId(controller.name, controller.key);
    if (sharer === undefined || this.watchers.get(sharerId)?.has(controllerId) !== true) {
      return 'not-shared';
    }
    sharer.line.send({ k: 'act', peer: sharer.peer, by: listenerOf(controller), id, action });
    return null;
  }

  /** The sharer's terminal text, to every watcher or to `to` alone. */
  text(sharer: Claim, text: string, to: Listener | null): null {
    const { peer: from, key } = sharer;
    for (const watcher of this.watchersOf(sharer, to)) {
      watcher.line.send({ k: 'text', from, key, text });
    }
    return null;
  }

  /** The sharer's answer to one watcher's action. */
  acted(sharer: Claim, to: Listener, id: number, answer: Record<string, unknown>): null {
    const { peer: from, key } = sharer;
    for (const watcher of this.watchersOf(sharer, to)) {
      watcher.line.send({ k: 'acted', from, key, id, answer });
    }
    return null;
  }

  /** The sharer pressed Stop on `to`. */
  release(sharer: Claim, to: Listener): null {
    const sharerId = claimId(sharer.name, sharer.key);
    for (const watcher of this.watchersOf(sharer, to)) {
      this.end(sharerId, sharer, watcher, 'stopped');
    }
    this.tell(sharerId);
    return null;
  }

  /** Sharing claim `sharerId`'s list or claims changed: each watch it no longer allows ends. */
  prune(sharerId: string): void {
    const sharer = this.claims.claimOf(sharerId);
    if (sharer === undefined) return;
    for (const watcher of [...(this.watchers.get(sharerId)?.values() ?? [])]) {
      if (!this.claims.gives(sharerId, watcher)) this.end(sharerId, sharer, watcher, 'unshared');
    }
    this.tell(sharerId);
  }

  /** A claim gone: as a sharer its watchers are told, and as a watcher its sharers. */
  dropClaim(claim: Claim): void {
    const id = claimId(claim.name, claim.key);
    for (const watcher of [...(this.watchers.get(id)?.values() ?? [])]) {
      this.end(id, claim, watcher, 'left');
    }
    this.watchers.delete(id);
    this.told.delete(id);
    for (const sharerId of [...(this.watching.get(id) ?? [])]) {
      this.unwatch(sharerId, id);
      this.tell(sharerId);
    }
    this.watching.delete(id);
  }

  private *watchersOf(sharer: Claim, to: Listener | null): Generator<Claim> {
    const watchers = this.watchers.get(claimId(sharer.name, sharer.key));
    if (watchers === undefined) return;
    if (to === null) {
      yield* watchers.values();
      return;
    }
    const one = watchers.get(
      claimId(peerKeyText({ realm: sharer.peer.realm, name: to.name }), to.key)
    );
    if (one !== undefined) yield one;
  }

  private end(sharerId: string, sharer: Claim, watcher: Claim, why: ReleasedWhy): void {
    this.unwatch(sharerId, claimId(watcher.name, watcher.key));
    watcher.line.send({ k: 'released', from: sharer.peer, key: sharer.key, why });
  }

  private unwatch(sharerId: string, controllerId: string): void {
    const watchers = this.watchers.get(sharerId);
    watchers?.delete(controllerId);
    if (watchers?.size === 0) this.watchers.delete(sharerId);
    const watching = this.watching.get(controllerId);
    watching?.delete(sharerId);
    if (watching?.size === 0) this.watching.delete(controllerId);
  }

  /** The sharer told who watches it, when that changed. */
  private tell(sharerId: string): void {
    const sharer = this.claims.claimOf(sharerId);
    if (sharer === undefined) return;
    const to = [...(this.watchers.get(sharerId)?.values() ?? [])].map(listenerOf);
    const text = JSON.stringify(to);
    if ((this.told.get(sharerId) ?? '[]') === text) return;
    this.told.set(sharerId, text);
    sharer.line.send({ k: 'controllers', peer: sharer.peer, to });
  }
}
