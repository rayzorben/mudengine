/**
 * Every loaded character's portrait (todo 20261019-0931-01): a `PortraitKeeper`
 * each, made the first time its state or its panel is seen and put down with
 * its session, over one art server client and one store on disk.
 */
import type { CharacterState } from '../../shared/character';
import type { SessionId } from '../../shared/ipc';
import type { PortraitChange, PortraitSource, PortraitView } from '../../shared/portrait';
import type { LastPortrait, Picture, PortraitCache } from './portraitCache';
import { PortraitKeeper } from './PortraitKeeper';

export interface PortraitsDeps {
  source: PortraitSource;
  cache: PortraitCache;
  /** The character's own record of its last portrait. */
  lastFor(id: SessionId): LastPortrait;
  enabled(): boolean;
  publish(id: SessionId, change: PortraitChange): void;
  say(id: SessionId, message: string): void;
}

export class Portraits {
  private readonly keepers = new Map<SessionId, PortraitKeeper>();

  constructor(private readonly deps: PortraitsDeps) {}

  observe(id: SessionId, state: CharacterState): void {
    this.keeperOf(id).observe(state);
  }

  view(id: SessionId): PortraitView {
    return this.keeperOf(id).current();
  }

  /** The picture shown for a character already kept, or null. */
  picture(id: SessionId): Picture | null {
    return this.keepers.get(id)?.picture() ?? null;
  }

  remove(id: SessionId): void {
    this.keepers.get(id)?.dispose();
    this.keepers.delete(id);
  }

  private keeperOf(id: SessionId): PortraitKeeper {
    let keeper = this.keepers.get(id);
    if (keeper === undefined) {
      keeper = new PortraitKeeper({
        source: this.deps.source,
        cache: this.deps.cache,
        last: this.deps.lastFor(id),
        enabled: () => this.deps.enabled(),
        publish: (change) => this.deps.publish(id, change),
        say: (message) => this.deps.say(id, message)
      });
      this.keepers.set(id, keeper);
    }
    return keeper;
  }
}
