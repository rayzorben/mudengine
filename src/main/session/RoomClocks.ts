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
  timedWithMoves,
  usualClock,
  type LearnedSpawns,
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
  /** `wanderers` per room, asked on every room a route search expands; dropped when a refill is timed. */
  private readonly came = new Map<RoomId, string[] | null>();

  constructor(
    private readonly lore: SpawnLore,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Every character line, with the block that brought it: only a death starts
   * a clock, and an arrival while `moving` (a move of this character's
   * unanswered) is the next room's.
   */
  onCharacter(state: CharacterState, block: Pick<Block, 'type'>, moving: boolean): void {
    const at = this.now();
    const killed = block.type === 'mob-dies' || block.type === 'user-gain-experience';
    const timed = this.watch.observe(refillCount(state), at, killed, moving);
    if (timed === null) return;
    this.lore.observeRefill(timed, at);
    this.came.clear();
  }

  reset(): void {
    this.watch.reset();
    this.came.clear();
  }

  /**
   * A lair's clock as the wire timed it, and whose it is: the timed clock of
   * its own rooms (the shortest, since a lap takes the first that refills),
   * which outranks the world database's `Delay`; else, only where `usual` is
   * asked for because the database states none, the realm's usual lair clock
   * over every lair `isLair` admits. Null while nothing is timed.
   *
   * A lair's gap under `refillShortestSeconds` is left out (`refillClock`
   * says why). An arena's are real refills, and `refilling` keeps them: the
   * Newhaven Arena's timed gaps on orohost run 0.005 to 0.8 s. A lair reads
   * entries timed before moves were accounted for as well, the floor having
   * kept out all but a few of the next room's spawns (3 of 389 on orohost).
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
    return Object.keys(this.stamped(room)?.seen ?? {});
  }

  /** A room's entry where it was timed with the moves accounted for (`SPAWNS_VERSION`); null otherwise. */
  private stamped(room: RoomId): LearnedSpawns | null {
    const entry = this.lore.spawnsAt(room);
    return timedWithMoves(entry) ? entry : null;
  }

  /** Rooms `isLair` does not admit that have a timed clock: an arena, read off the wire. */
  refilling(isLair: (room: RoomId) => boolean): RefillingRoom[] {
    const least = tuning().hunting.refillsLeast;
    const rooms: RefillingRoom[] = [];
    for (const [room, entry] of this.lore.allSpawns()) {
      if (isLair(room) || !timedWithMoves(entry)) continue;
      // An arena refills within a second (the Newhaven Arena), so no gap is too short here.
      const clock = refillClock(entry, least);
      if (clock === null) continue;
      const names = cameIn(entry);
      if (names.length > 0) rooms.push({ room, clock, names });
    }
    return rooms;
  }

  /**
   * The monsters the wire timed coming into a room, commonest first, on the
   * evidence `refilling` reads; null where it is too thin. Asked by route
   * pricing for a room whose lair the world database does not fill, such as
   * the Darkwood Main Road: its 1/1392 saw thugs and orc rogues
   * come in twelve times, and nothing priced the walk past them (2026-10-04,
   * Vaelor dead ten times on that road).
   */
  wanderers(room: RoomId): string[] | null {
    const kept = this.came.get(room);
    if (kept !== undefined) return kept;
    const entry = this.stamped(room);
    const names =
      entry === null || refillClock(entry, tuning().hunting.refillsLeast) === null
        ? []
        : cameIn(entry);
    const answer = names.length === 0 ? null : names;
    this.came.set(room, answer);
    return answer;
  }
}

/** Who came into a room, by `mobKey`, commonest first. */
function cameIn(entry: LearnedSpawns): string[] {
  return Object.entries(entry.seen)
    .sort(([, a], [, b]) => b - a)
    .map(([name]) => name);
}
