/**
 * A room's picture in the game view (todo 20261020-2015-01): the bundled set,
 * found by the description's key, else what the art server draws from the
 * description the character read. A request carries the map and room numbers,
 * the room's name and its description as the realm printed it, and nothing
 * about the character. The port main draws through, what the window is told,
 * and what `Routines` asks before looking at a room for it.
 */
import type { RealmFamily } from './character';
import type { PortraitResult } from './portrait';

export interface RoomArtRequest {
  map: number;
  room: number;
  /** The room's name as printed with the description. */
  name: string;
  /** As printed, lines joined; the server keys the picture on it with its whitespace collapsed. */
  description: string;
}

/** The server answers a room as it answers a portrait: a picture, a refusal with its reason, or nothing. */
export type RoomArtResult = PortraitResult;

/** What main draws rooms through; a fake server answers it in tests. */
export interface RoomArtSource {
  roomArtOf(request: RoomArtRequest, cancelled: () => boolean): Promise<RoomArtResult>;
}

/** The picture under the arena's tokens: shipped beside the window, or drawn and kept on disk. */
export type RoomPicture =
  | { kind: 'shipped'; key: string }
  /** `picture` is a `data:` URL. */
  | { kind: 'drawn'; key: string; picture: string };

export interface RoomArtView {
  picture: RoomPicture | null;
}

export const NO_ROOM_ART: RoomArtView = { picture: null };

/** Where the window loads a room picture from; the shipped set sits beside it as `room-art/`. */
export function roomPictureUrl(picture: RoomPicture): string {
  return picture.kind === 'shipped' ? `room-art/${picture.key}.webp` : picture.picture;
}

export function sameRoomPicture(a: RoomPicture | null, b: RoomPicture | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.key === b.key;
}

/** What `Routines` asks before offering `l` in a room shown without its description. */
export interface RoomLook {
  /** `art.rooms`: whether a room the set has no picture for is sent for one. */
  wanted(): boolean;
  /**
   * Whether the bundled set has a picture for this realm's map and room, so no
   * look is needed; yes while the index is still being read.
   */
  shipped(realm: RealmFamily | null, map: number, room: number): boolean;
}
