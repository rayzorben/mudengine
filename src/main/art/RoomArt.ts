/**
 * Every loaded character's room picture (todo 20261020-2015-01): a
 * `RoomArtKeeper` each, over the one shipped index, one art server client and
 * one store on disk for the drawings.
 */
import type { CharacterState } from '../../shared/character';
import type { SessionId } from '../../shared/ipc';
import type { RoomArtSource, RoomArtView } from '../../shared/roomArt';
import type { PictureCache } from './pictureCache';
import { RoomArtKeeper } from './RoomArtKeeper';
import { SessionKeepers } from './SessionKeepers';
import type { ShippedRoomArt } from './ShippedRoomArt';

export interface RoomArtDeps {
  shipped: ShippedRoomArt;
  source: RoomArtSource;
  cache: PictureCache;
  /** `art.rooms`, read through. */
  enabled(): boolean;
  publish(id: SessionId, view: RoomArtView): void;
  say(id: SessionId, message: string): void;
}

export class RoomArt {
  private readonly keepers: SessionKeepers<RoomArtKeeper>;

  constructor(deps: RoomArtDeps) {
    this.keepers = new SessionKeepers(
      (id) =>
        new RoomArtKeeper({
          shipped: deps.shipped,
          source: deps.source,
          cache: deps.cache,
          enabled: () => deps.enabled(),
          publish: (view) => deps.publish(id, view),
          say: (message) => deps.say(id, message)
        })
    );
  }

  observe(id: SessionId, state: CharacterState): void {
    this.keepers.of(id).observe(state);
  }

  view(id: SessionId): RoomArtView {
    return this.keepers.of(id).current();
  }

  remove(id: SessionId): void {
    this.keepers.remove(id);
  }
}
