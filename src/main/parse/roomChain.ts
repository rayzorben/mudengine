/**
 * The rooms an unplaced character could be standing in, kept from one room
 * block to the next so the ladder can narrow them by the way walked
 * (`ResolveInput.chain`; `mudengine-wire` › `parts/room.md` › *An unplaced
 * room is narrowed by the rooms after it*).
 *
 * `Room.candidates` is capped for the Room card, so the whole set is kept
 * here. It is bounded by the rooms sharing one name.
 */
import type { Room } from '../../shared/character';
import { roomId, roomNameKey, type Direction, type RoomId } from '../../shared/world';
import { fitsExits, type ChainInput, type Resolution } from '../world/resolve';

interface Kept {
  rooms: readonly RoomId[];
  drawn: readonly RoomId[];
  /** The block the set was read from, and the arrival it was (`Room.arrival`). */
  name: string;
  exits: string;
  arrival: number;
}

const listed = (exits: readonly Direction[]): string => [...exits].sort().join(',');

export class RoomChain {
  private kept: Kept | null = null;

  /**
   * What the ladder is told for a block arriving while the character stood in
   * `was`: nothing unless `was` is the unplaced room the set was read from.
   * `unmoved` is a block no move and no shove caused.
   */
  from(
    was: Pick<Room, 'map' | 'number' | 'name' | 'arrival'>,
    name: string,
    exits: readonly Direction[],
    unmoved: boolean
  ): ChainInput | undefined {
    const kept = this.kept;
    if (
      kept === null ||
      was.map !== null ||
      was.number !== null ||
      was.name === null ||
      roomNameKey(was.name) !== kept.name ||
      was.arrival !== kept.arrival
    ) {
      return undefined;
    }
    // A cast exit's second block can print what its first did, so a step that
    // may have walked one is never read as a reprint.
    const stayed =
      unmoved &&
      kept.drawn.length === 0 &&
      roomNameKey(name) === kept.name &&
      listed(exits) === kept.exits;
    return { rooms: kept.rooms, drawn: kept.drawn, stayed };
  }

  /**
   * The block as the ladder left it: nothing when it placed a room, else the
   * candidates its printed exits fit. The ladder also hands back namesakes the
   * exits fit none of, and a set the block already ruled out is not stepped.
   */
  keep(
    now: Pick<Room, 'name' | 'arrival'>,
    exits: readonly Direction[],
    located: Pick<Resolution, 'room' | 'candidates' | 'drawn'>
  ): void {
    const fitting =
      located.room === null ? located.candidates.filter((room) => fitsExits(exits, room)) : [];
    if (fitting.length === 0 || now.name === null) {
      this.kept = null;
      return;
    }
    this.kept = {
      rooms: fitting.map((room) => roomId(room.map, room.room)),
      drawn: located.drawn ?? [],
      name: roomNameKey(now.name),
      exits: listed(exits),
      arrival: now.arrival
    };
  }
}
