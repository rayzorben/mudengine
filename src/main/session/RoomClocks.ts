/**
 * The rooms' refill clocks the wire timed, for the hunting survey: the watch
 * fed from every character line, and the two readings the survey asks for.
 * See `src/shared/spawns.ts` for why the world database is not enough.
 */
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import {
  RefillWatch,
  refillClock,
  refillCount,
  usualClock,
  type SpawnLore
} from '../../shared/spawns';
import type { RoomId } from '../../shared/world';

/** A room with no lair that refilled while the character stood in it. */
export interface RefillingRoom {
  room: RoomId;
  /** Seconds, the median timed gap. */
  clock: number;
  /** Every monster that came, by `mobKey`, commonest first. */
  names: string[];
}

export class RoomClocks {
  private readonly watch = new RefillWatch();

  constructor(
    private readonly lore: SpawnLore,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Every character line, with the block that brought it: only a death starts a clock. */
  onCharacter(state: CharacterState, block: Pick<Block, 'type'>): void {
    const at = this.now();
    const killed = block.type === 'mob-dies' || block.type === 'user-gain-experience';
    const timed = this.watch.observe(refillCount(state), at, killed);
    if (timed !== null) this.lore.observeRefill(timed, at);
  }

  reset(): void {
    this.watch.reset();
  }

  /**
   * A lair's clock as the wire timed it, and whose it is: the timed clock of
   * its own rooms (the shortest, since a lap takes the first that refills),
   * which outranks the world database's `Delay`; else, only where `usual` is
   * asked for because the database states none, the realm's usual lair clock
   * over every lair `isLair` admits. Null while nothing is timed.
   *
   * A lair's gap under `refillShortestSeconds` is left out: the room read
   * empty and full again within a second of a kill is the lair's second
   * monster coming in. An arena's are real refills, and `refilling` keeps
   * them: the Newhaven Arena's timed gaps on orohost run 0.005 to 0.8 s.
   *
   * Outranks it because the `Delay` reading is the client's and the gap is
   * the server's: orohost runs the Paradigm data, whose Small Cavern states
   * `Delay` 3 (150 s through `respawnSeconds`), and refilled it in a median of
   * 21 s over 137 kills (2026-09-30).
   */
  lairClock(
    rooms: readonly RoomId[],
    isLair: (room: RoomId) => boolean,
    usual: boolean
  ): { seconds: number; whose: 'timed' | 'usual' } | null {
    const { refillsLeast: least, refillShortestSeconds: shortest } = tuning().hunting;
    const own = rooms.flatMap((room) => {
      const clock = refillClock(this.lore.spawnsAt(room), least, shortest);
      return clock === null ? [] : [clock];
    });
    if (own.length > 0) return { seconds: Math.min(...own), whose: 'timed' };
    if (!usual) return null;
    const lairs = [...this.lore.allSpawns()].filter(([room]) => isLair(room));
    const typical = usualClock(
      lairs.map(([, entry]) => entry),
      least,
      shortest
    );
    return typical === null ? null : { seconds: typical, whose: 'usual' };
  }

  /** The monsters the wire saw refill this room, by `mobKey`. */
  seenIn(room: RoomId): string[] {
    return Object.keys(this.lore.spawnsAt(room)?.seen ?? {});
  }

  /** Rooms `isLair` does not admit that have a timed clock: an arena, read off the wire. */
  refilling(isLair: (room: RoomId) => boolean): RefillingRoom[] {
    const least = tuning().hunting.refillsLeast;
    const rooms: RefillingRoom[] = [];
    for (const [room, entry] of this.lore.allSpawns()) {
      if (isLair(room)) continue;
      // An arena refills within a second (the Newhaven Arena), so no gap is too short here.
      const clock = refillClock(entry, least);
      if (clock === null) continue;
      const names = Object.entries(entry.seen)
        .sort(([, a], [, b]) => b - a)
        .map(([name]) => name);
      if (names.length > 0) rooms.push({ room, clock, names });
    }
    return rooms;
  }
}
