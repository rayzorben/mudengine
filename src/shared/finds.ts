/**
 * What a `search` has turned up in this realm, and where.
 *
 * The realm hides things. `search` is the command that reveals them, the answer
 * is a `room-hidden-items` block, and what it turns up **stays concealed** — a
 * bare Enter afterwards reprints the room with no `You notice` line at all. So
 * a find is not something the room will tell you about again: unless it is
 * written down at the moment it is seen, the only record of it is whoever was
 * watching the console.
 *
 * That is what makes this worth keeping, and it is why it is kept **per realm**
 * rather than per character, the way a shop's stock is (`SplitMemory`): that a
 * room in Newhaven hides a rusty key is a fact about the world, and a second
 * character re-learning it spends a search to be told what the first already
 * knew.
 *
 * It is a **log**, not a map correction. Nothing here reaches the pathfinder or
 * the realm database; it says what was seen, when, and how often, and the card
 * shows a window on it. Dependency-free like the rest of `shared/`: main writes
 * these, the renderer reads them.
 */
import type { RoomId } from './world';

/** The file format's version, so a reader can refuse one it does not know. */
export const FINDS_VERSION = 2;

export interface Find {
  /** Where it was turned up. Known, or the find is not worth writing down. */
  room: RoomId;
  /** The realm's name for the room, so a row reads without the database. */
  roomName: string;
  /**
   * What was found, as the server spelled it, singular where the server
   * counted: `copper farthings`, `scroll of minor healing`.
   */
  name: string;
  /**
   * How many the line named.
   *
   * **Null is "the server did not count them", never one.** It counts coins and
   * stacks and says nothing about a single thing, and a row claiming `1` for
   * every scroll would be the client inventing a number the wire never sent.
   */
  quantity: number | null;
  /**
   * What it is worth in copper, for **cash**; null for a thing.
   *
   * The one field that tells the two apart, and it is a value rather than a
   * flag because that is the question anybody asks of found money: hidden coins
   * refuse a bare `get` and want the quantity (see `room-hidden-items`), and an
   * alert about them is an alert about how much.
   */
  copper: number | null;
  /** When a search last turned it up here. */
  at: number;
  /**
   * How many separate searches have. One is a find; twenty is a room worth
   * searching every lap.
   */
  seen: number;
  /**
   * Of the searches of its room the log has counted (`searched`), how many
   * turned it up.
   *
   * Not `seen`: rows written before searches were counted (2026-09-18) have a
   * `seen` with no count of the searches that missed beside it, so theirs
   * started at zero. On every row written since, the two agree.
   */
  hits: number;
  /**
   * How many bare searches of its room the log has counted, whatever they
   * turned up. The **room's** count, kept once per room and joined on where a
   * row is handed out: a room searched twenty times before a thing first turns
   * up is one find in twenty-one searches, not one in one.
   */
  searched: number;
}

/** One thing one search turned up, before the log has counted it. */
export type Sighting = Omit<Find, 'room' | 'seen' | 'hits' | 'searched'>;

/**
 * How often a search of its room turns this up, 0–1; null before its room's
 * first counted search.
 *
 * Measured, because nothing states it: the server rolls each hidden item
 * against the searcher's Perception (`Player.TrySearch`, source) and whether
 * it is there to roll for is up to whoever hid it. Pooled across every
 * character on the realm, as the log is.
 */
export function findRate(find: Find): number | null {
  return find.searched > 0 ? find.hits / find.searched : null;
}

/** Rarest first, a row with no rate yet last, and newest first among equals. */
export function byRarest(a: Find, b: Find): number {
  const rateA = findRate(a);
  const rateB = findRate(b);
  if (rateA === rateB) return byNewest(a, b);
  if (rateA === null) return 1;
  if (rateB === null) return -1;
  return rateA - rateB || byNewest(a, b);
}

/**
 * The identity of a find: one thing, in one room.
 *
 * Keyed on the pair rather than on the moment, so a room searched every lap is
 * one row whose `at` moves and whose `seen` climbs — which is the shape the
 * card sorts by and the shape "this room is worth searching" is legible in.
 * A `Discovery` deliberately does *not* move its `at`, because that record is
 * of a discovery; this one is of a recurrence.
 */
export function findKey(find: Pick<Find, 'room' | 'name'>): string {
  return `${find.room}|${find.name.trim().toLowerCase()}`;
}

/** Whether this find is money rather than a thing. */
export function isCash(find: Find): boolean {
  return find.copper !== null;
}

/** Newest first, the order a log wants and the card's among equally rare rows. */
export function byNewest(a: Find, b: Find): number {
  return b.at - a.at;
}

/**
 * The rooms a set of finds names, for the map.
 *
 * `Set` rather than a list: the map asks "does this room have one" per drawn
 * cell, and a linear scan per cell over a log that grows all session is the
 * `O(N²)` the engineering standards name.
 */
export function roomsWithFinds(finds: readonly Find[]): ReadonlySet<RoomId> {
  return new Set(finds.map((find) => find.room));
}

/**
 * The finds still inside a window, rarest first.
 *
 * `days` of `0` means *keep showing everything*: the store is the record and
 * this is a window on it, so turning the number up brings rows back rather
 * than finding them deleted. Pure, so the card and its copy text cannot
 * disagree about what is on screen.
 */
export function within(finds: readonly Find[], days: number, now: number): Find[] {
  const floor = days > 0 ? now - days * 86_400_000 : Number.NEGATIVE_INFINITY;
  return finds.filter((find) => find.at >= floor).sort(byRarest);
}

/** Whether a find is one somebody asked to be told about. */
export function alertsFor(
  find: Find,
  watch: readonly string[],
  cashOverCopper: number
): 'item' | 'cash' | null {
  if (find.copper !== null) {
    // `> 0` rather than `>= 0`: zero is the off position, and an alert on every
    // farthing is an alert nobody reads.
    return cashOverCopper > 0 && find.copper >= cashOverCopper ? 'cash' : null;
  }
  const name = find.name.toLowerCase();
  // Contains, not equals: the server prints `a rusty key` and `rusty keys`, and
  // somebody watching for a key typed `key`.
  return watch.some((word) => {
    const wanted = word.trim().toLowerCase();
    return wanted.length > 0 && name.includes(wanted);
  })
    ? 'item'
    : null;
}
