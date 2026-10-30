/**
 * One character's room picture (todo 20261020-2015-01). On each certain room:
 * the bundled set's drawing for its map and room, turned to its exits (todo
 * 20261021-1417-01), where the description read is the one it was drawn from
 * or brief printed none. Otherwise the description read gives the key: the
 * store on disk has it, or with `art.rooms` on the server is asked once per
 * key, one ask in flight, and the drawing kept. A brief room the set has no
 * drawing for waits for the look `BriefLook` offers. A room left while its
 * drawing was under way shows it on the next visit. An unreachable server is
 * asked again on the next entry to the realm, as portraits are.
 */
import type { CharacterState, RealmFamily, Room } from '../../shared/character';
import { certainRoom, describedRoom } from '../../shared/descriptions';
import {
  NO_ROOM_ART,
  sameRoomPicture,
  type RoomArtSource,
  type RoomArtView,
  type RoomPicture
} from '../../shared/roomArt';
import { errorMessage } from '../../shared/values';
import { AskLedger } from './AskLedger';
import { dataUrlOf, type Picture, type PictureCache } from './pictureCache';
import { roomKey } from './roomKey';
import type { ShippedDrawing, ShippedRoomArt } from './ShippedRoomArt';

export interface RoomArtKeeperDeps {
  shipped: Pick<ShippedRoomArt, 'drawingOf' | 'loaded'>;
  source: RoomArtSource;
  cache: PictureCache;
  /** `art.rooms`, read through. */
  enabled(): boolean;
  /** The view changed. */
  publish(view: RoomArtView): void;
  /** A refusal or a failure, said once for each description. */
  say(message: string): void;
}

export class RoomArtKeeper {
  private view: RoomArtView = NO_ROOM_ART;
  /** The keys asked for, and which the server did not answer. */
  private readonly ledger = new AskLedger();
  private inFlight = false;
  /** Whether `art.rooms` was on at the last state: turned back on, everything may be asked again. */
  private wasEnabled = false;
  private latest: Latest | null = null;
  /** The parts of the room the decision is made of, as last seen. */
  private seen: readonly unknown[] = [];
  /** Counts each decision, so an answer for a room left meanwhile is dropped. */
  private turn = 0;
  private disposed = false;

  constructor(private readonly deps: RoomArtKeeperDeps) {}

  current(): RoomArtView {
    return this.view;
  }

  observe(state: CharacterState): void {
    const entered = this.ledger.entered(state.phase);
    const enabled = this.deps.enabled();
    if (enabled && !this.wasEnabled) this.ledger.clear();
    this.wasEnabled = enabled;
    const { room, realm } = state;
    const parts = [
      entered,
      enabled,
      realm,
      room.map,
      room.number,
      room.name,
      room.description,
      room.ambiguous,
      room.resolvedBy
    ];
    if (parts.length === this.seen.length && parts.every((part, at) => part === this.seen[at])) {
      return;
    }
    this.seen = parts;
    this.latest = { room, realm };
    void this.consider(room, realm);
  }

  dispose(): void {
    this.disposed = true;
  }

  private async consider(room: Room, realm: RealmFamily | null): Promise<void> {
    const turn = ++this.turn;
    const certain = certainRoom(room);
    if (certain === null) {
      this.set(null);
      return;
    }
    await this.deps.shipped.loaded;
    if (turn !== this.turn || this.disposed) return;
    const read = describedRoom(room);
    const shipped = this.deps.shipped.drawingOf(realm, certain.map, certain.number);
    if (read === null) {
      this.set(shipped === null ? null : shippedPicture(shipped));
      return;
    }
    const key = roomKey(read.text);
    // Another description at that number is another room than the one drawn.
    if (shipped?.described === key) {
      this.set(shippedPicture(shipped));
      return;
    }
    if (this.view.picture?.key === key) return;
    try {
      const kept = await this.deps.cache.get(key);
      if (turn !== this.turn || this.disposed) return;
      if (kept !== null) {
        this.set(drawn(key, kept));
        return;
      }
    } catch (error) {
      this.deps.say(errorMessage(error));
    }
    this.set(null);
    if (!this.deps.enabled() || this.ledger.has(key) || this.inFlight) return;
    this.ledger.begin(key);
    this.inFlight = true;
    try {
      await this.draw(key, turn, {
        map: certain.map,
        room: certain.number,
        name: certain.name,
        description: read.text
      });
    } finally {
      this.inFlight = false;
      // A room entered while the ask was under way was held off: decided now.
      if (this.turn !== turn && this.latest !== null && !this.disposed) {
        void this.consider(this.latest.room, this.latest.realm);
      }
    }
  }

  private async draw(
    key: string,
    turn: number,
    request: Parameters<RoomArtSource['roomArtOf']>[0]
  ): Promise<void> {
    try {
      const result = await this.deps.source.roomArtOf(request, () => this.disposed);
      if (this.disposed) return;
      if (result.kind === 'picture') {
        const picture = { bytes: result.bytes, type: result.type };
        await this.deps.cache.put(key, picture);
        if (turn === this.turn) this.set(drawn(key, picture));
        return;
      }
      if (result.kind === 'unreachable') this.ledger.failed(key);
      if (result.kind !== 'unavailable') this.deps.say(result.reason);
    } catch (error) {
      // The disk, not the server: said, and asked again on the next entry.
      this.deps.say(errorMessage(error));
      this.ledger.failed(key);
    }
  }

  private set(picture: RoomPicture | null): void {
    if (sameRoomPicture(picture, this.view.picture)) return;
    this.view = { picture };
    this.deps.publish(this.view);
  }
}

/** The room last seen and the realm it is on, for the decision held off by an ask under way. */
interface Latest {
  room: Room;
  realm: RealmFamily | null;
}

function shippedPicture(drawing: ShippedDrawing): RoomPicture {
  return { kind: 'shipped', key: drawing.key, turn: drawing.turn };
}

function drawn(key: string, picture: Picture): RoomPicture {
  return { kind: 'drawn', key, picture: dataUrlOf(picture) };
}
