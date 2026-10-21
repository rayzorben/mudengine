/**
 * One keeper per loaded character (todo 20261019-0931-01), made the first
 * time the character is seen and put down with its session: the shape
 * `Portraits` and `RoomArt` share.
 */
import type { SessionId } from '../../shared/ipc';

export class SessionKeepers<K extends { dispose(): void }> {
  private readonly keepers = new Map<SessionId, K>();

  constructor(private readonly make: (id: SessionId) => K) {}

  of(id: SessionId): K {
    let keeper = this.keepers.get(id);
    if (keeper === undefined) {
      keeper = this.make(id);
      this.keepers.set(id, keeper);
    }
    return keeper;
  }

  /** The keeper already made for a character, or undefined. */
  get(id: SessionId): K | undefined {
    return this.keepers.get(id);
  }

  remove(id: SessionId): void {
    this.keepers.get(id)?.dispose();
    this.keepers.delete(id);
  }
}
