/**
 * The sharer's half of remote control (todo 20261031-1156-01): who is
 * controlling each of this install's characters. Each controller the gateway
 * names is checked against the character's own row for that player, the
 * level at `control` and the key pinned, whatever the gateway let through, so
 * lowering a share ends control on the next frame; one allowed is given a
 * window here (`RelayDesk`), and a call reaches the character only through
 * it. Stop ends every controller of the character until its player turns
 * Allow remote control off and on again. Each start and end is said in the
 * character's console.
 */
import type { SessionId } from '../../shared/ipc';
import type { PeerGrant } from '../../shared/peerGrant';
import { peerKeyText, type PeerKey } from '../../shared/peers';
import { sameListener, type Listener } from '../../shared/peerWire';
import { playerKey } from '../../shared/players';
import { t } from '../app/i18n';
import type { ControlledFrame, PeerLink } from './PeerLink';
import type { RelayDesk } from './RelayDesk';

/** A character this install claims, as control reads it. */
export interface ControlledCharacter {
  readonly id: SessionId;
  readonly peer: PeerKey;
  /** Its row for `name`, or null for none. */
  grantFor(name: string): PeerGrant | null;
}

export interface ControlDeskDeps {
  /** The session claiming `peer`, or null. */
  characterOf(peer: PeerKey): ControlledCharacter | null;
  /** The session `id` while it is claimed, or null. */
  characterAt(id: SessionId): ControlledCharacter | null;
  link: Pick<PeerLink, 'release'>;
  relay: Pick<RelayDesk, 'open' | 'close' | 'closeAll' | 'heard'>;
  notice(id: SessionId, message: string): void;
  /** Who controls a character changed, for its window. */
  changed(): void;
}

interface Desk {
  peer: PeerKey;
  controllers: Listener[];
  /** Names stopped by the player, by `playerKey`, until the row leaves `control`. */
  stopped: Set<string>;
}

export class ControlDesk {
  private readonly desks = new Map<SessionId, Desk>();

  constructor(private readonly deps: ControlDeskDeps) {}

  heard(frame: ControlledFrame): void {
    const character = this.deps.characterOf(frame.peer);
    switch (frame.k) {
      case 'controllers':
        this.controllers(character, frame.peer, frame.to);
        return;
      case 'call': {
        // A call from anyone this character's row no longer allows goes nowhere.
        const desk = character === null ? undefined : this.desks.get(character.id);
        if (character === null || desk === undefined) return;
        const controlling = desk.controllers.some((each) => sameListener(each, frame.by));
        if (controlling && this.allows(character, desk, frame.by)) {
          this.deps.relay.heard(frame.peer, frame.by, frame.part);
        }
        return;
      }
      default: {
        const never: never = frame;
        return never;
      }
    }
  }

  /** The players controlling `id` now. */
  controlledBy(id: SessionId): string[] {
    return this.desks.get(id)?.controllers.map((each) => each.name) ?? [];
  }

  /** The player pressed Stop: every controller of `id` ends, and stays out until the row is set again. */
  stop(id: SessionId): void {
    const desk = this.desks.get(id);
    if (desk === undefined || desk.controllers.length === 0) return;
    const names = desk.controllers.map((each) => each.name);
    for (const controller of desk.controllers) {
      desk.stopped.add(playerKey(controller.name));
      this.end(desk, controller);
    }
    desk.controllers = [];
    this.deps.notice(id, t('peers.control.stopped', { names: names.join(', ') }));
    this.deps.changed();
  }

  /**
   * The claims or the rows changed: a desk for each claimed character, each
   * controller its row no longer allows ended, and a stop lifted where the row
   * left `control`.
   */
  regrant(ids: readonly SessionId[]): void {
    for (const id of [...this.desks.keys()]) {
      if (ids.includes(id)) continue;
      this.desks.delete(id);
      this.deps.relay.closeAll(id);
    }
    for (const id of ids) {
      const character = this.deps.characterAt(id);
      if (character === null) continue;
      const desk = this.deskOf(character);
      for (const name of [...desk.stopped]) {
        if (character.grantFor(name)?.share !== 'control') desk.stopped.delete(name);
      }
      const kept = desk.controllers.filter((each) => this.allows(character, desk, each));
      for (const gone of desk.controllers.filter((each) => !kept.includes(each))) {
        this.end(desk, gone);
        this.deps.notice(id, t('peers.control.ended', { from: gone.name }));
      }
      if (kept.length !== desk.controllers.length) this.deps.changed();
      desk.controllers = kept;
    }
  }

  /** The link dropped: nobody controls anything until the gateway says so again. */
  lost(): void {
    for (const [id, desk] of this.desks) {
      if (desk.controllers.length === 0) continue;
      this.deps.notice(id, t('peers.control.lost'));
      desk.controllers = [];
    }
    this.deps.relay.closeAll(null);
    this.deps.changed();
  }

  /** `controller`'s control of the character `desk` is for ends, at the gateway and here. */
  private end(desk: Desk, controller: Listener): void {
    this.deps.link.release(desk.peer, controller);
    this.deps.relay.close(desk.peer, controller);
  }

  private deskOf(character: ControlledCharacter): Desk {
    const held = this.desks.get(character.id);
    if (held !== undefined && peerKeyText(held.peer) === peerKeyText(character.peer)) return held;
    if (held !== undefined) this.deps.relay.closeAll(character.id);
    const desk: Desk = { peer: character.peer, controllers: [], stopped: new Set() };
    this.desks.set(character.id, desk);
    return desk;
  }

  /** Whether `id`'s row for this controller gives control under its key, and its player has not stopped it. */
  private allows(character: ControlledCharacter, desk: Desk, controller: Listener): boolean {
    const grant = character.grantFor(controller.name);
    return (
      grant !== null &&
      grant.share === 'control' &&
      grant.keys.includes(controller.key) &&
      !desk.stopped.has(playerKey(controller.name))
    );
  }

  private controllers(
    character: ControlledCharacter | null,
    peer: PeerKey,
    to: readonly Listener[]
  ): void {
    if (character === null) {
      for (const each of to) this.deps.link.release(peer, each);
      return;
    }
    const desk = this.deskOf(character);
    const allowed = to.filter((each) => this.allows(character, desk, each));
    for (const refused of to.filter((each) => !allowed.includes(each))) {
      this.deps.link.release(peer, refused);
    }
    for (const arrived of allowed.filter(
      (each) => !desk.controllers.some((was) => sameListener(was, each))
    )) {
      this.deps.relay.open(character.id, peer, arrived);
      this.deps.notice(character.id, t('peers.control.started', { from: arrived.name }));
    }
    for (const gone of desk.controllers.filter(
      (was) => !allowed.some((each) => sameListener(was, each))
    )) {
      this.deps.relay.close(peer, gone);
      this.deps.notice(character.id, t('peers.control.ended', { from: gone.name }));
    }
    desk.controllers = allowed;
    this.deps.changed();
  }
}
