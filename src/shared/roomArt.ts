/**
 * A room's picture in the game view (todo 20261020-2015-01): the bundled set,
 * found by the room's map and number and drawn for its exits (todo
 * 20261021-1417-01), else what the art server draws from the description the
 * character read. A request carries the map and room numbers,
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

/** Quarter turns clockwise, the closed list beside its type. */
export const QUARTER_TURNS = [0, 1, 2, 3] as const;
export type QuarterTurns = (typeof QUARTER_TURNS)[number];

/**
 * How a shipped drawing is laid on the disc so the room's north is at the top
 * (todo 20261021-1417-01): rooms whose exits are one pattern turned or
 * mirrored share a drawing, mirrored left to right first, then turned.
 */
export interface RoomTurn {
  quarters: QuarterTurns;
  mirrored: boolean;
}

export const UNTURNED: RoomTurn = { quarters: 0, mirrored: false };

/** The art run's code for a turn: quarter turns clockwise, plus 4 when mirrored first; else null. */
export function roomTurnOf(code: number): RoomTurn | null {
  if (!Number.isInteger(code) || code < 0 || code > 7) return null;
  const quarters = QUARTER_TURNS[code % 4];
  return quarters === undefined ? null : { quarters, mirrored: code >= 4 };
}

/**
 * The picture under the arena's tokens: shipped beside the window, drawn for
 * the room's exits and laid on by `turn`; or drawn by the art server from the
 * description alone and kept on disk.
 */
export type RoomPicture =
  | { kind: 'shipped'; key: string; turn: RoomTurn }
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

/** How the picture is laid on the disc; a drawing from the server is drawn north up. */
export function turnOf(picture: RoomPicture): RoomTurn {
  return picture.kind === 'shipped' ? picture.turn : UNTURNED;
}

export function sameRoomPicture(a: RoomPicture | null, b: RoomPicture | null): boolean {
  if (a === null || b === null) return a === b;
  const [one, other] = [turnOf(a), turnOf(b)];
  return (
    a.kind === b.kind &&
    a.key === b.key &&
    one.quarters === other.quarters &&
    one.mirrored === other.mirrored
  );
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
