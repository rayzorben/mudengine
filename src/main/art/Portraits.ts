/**
 * Every loaded character's portrait (todo 20261019-0931-01): a `PortraitKeeper`
 * each, made the first time its state or its panel is seen and put down with
 * its session, over one art server client and one store on disk.
 */
import type { CharacterState } from '../../shared/character';
import type { SessionId } from '../../shared/ipc';
import type { PortraitChange, PortraitSource, PortraitView } from '../../shared/portrait';
import type { LastPortrait, Picture, PictureCache } from './pictureCache';
import { PortraitKeeper } from './PortraitKeeper';
import { SessionKeepers } from './SessionKeepers';

export interface PortraitsDeps {
  source: PortraitSource;
  cache: PictureCache;
  /** The character's own record of its last portrait. */
  lastFor(id: SessionId): LastPortrait;
  enabled(): boolean;
  publish(id: SessionId, change: PortraitChange): void;
  say(id: SessionId, message: string): void;
}

export class Portraits {
  private readonly keepers: SessionKeepers<PortraitKeeper>;

  constructor(deps: PortraitsDeps) {
    this.keepers = new SessionKeepers(
      (id) =>
        new PortraitKeeper({
          source: deps.source,
          cache: deps.cache,
          last: deps.lastFor(id),
          enabled: () => deps.enabled(),
          publish: (change) => deps.publish(id, change),
          say: (message) => deps.say(id, message)
        })
    );
  }

  observe(id: SessionId, state: CharacterState): void {
    this.keepers.of(id).observe(state);
  }

  view(id: SessionId): PortraitView {
    return this.keepers.of(id).current();
  }

  /** The picture shown for a character already kept, or null. */
  picture(id: SessionId): Picture | null {
    return this.keepers.get(id)?.picture() ?? null;
  }

  remove(id: SessionId): void {
    this.keepers.remove(id);
  }
}
