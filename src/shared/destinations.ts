/**
 * Where a character has actually been told to go, and when it last went there.
 *
 * The realm holds 55,806 rooms and `searchByName` is a capped substring match
 * in build order, so typing `forest` answers with whichever hundred forests the
 * world file happens to list first. Most of them are places nobody has ever
 * been. The one the player means is almost always one they have walked to
 * before — `Forest Cavern`, not the two hundred `Darkwood Forest`s ahead of it
 * — and the client already knows which those are, because it planned the route.
 *
 * So a destination is written down when a walk is *started* toward it, and the
 * palette's room search puts the recent matches above the realm's own answer.
 *
 * **A realm-wide fact, keyed like the lore and the player book.** Where a
 * character goes is a fact about the *map*, not about the character: four
 * characters on one realm share a bank, a trainer and a hunting ground, and
 * the first one to walk there should spare the other three the search. A
 * character on a different realm must not inherit any of it — the room numbers
 * do not mean the same places.
 *
 * **Started, not arrived.** The walk is what states the intent, and it is the
 * intent this list is for: a route that failed half way is still the place the
 * player was looking for, and will be looked for again — most likely *because*
 * it failed. Recording only arrivals would drop exactly the destinations
 * somebody is about to retype.
 *
 * Dependency-free: main keeps and persists it, the renderer only reads the
 * handful of rows that reach it.
 */

/** One place a character was sent, and the last time it was. */
export interface VisitedDestination {
  /**
   * The room's id, `map/room` — the realm's own address for it, and the key.
   *
   * Keyed by id rather than by name because thirteen rooms share the name
   * `Town Gates`: a name-keyed list would answer a search with one row standing
   * for thirteen different places, and walking it would be a coin toss.
   */
  id: string;
  /** The room's name as the realm spells it, for matching and for showing. */
  name: string;
  /** When it was last walked to, epoch milliseconds. */
  at: number;
  /**
   * How many times a walk has been started toward it.
   *
   * Kept but deliberately **not** ranked on: the order is recency, because a
   * place visited fifty times last month is not what somebody is typing now.
   * It is here because it is free to keep and cannot be recovered later.
   */
  visits: number;
}

/**
 * When this machine last walked to a room the search is offering, if ever.
 *
 * Carried *beside* the realm's row rather than on it: a `WorldRoom` is what the
 * realm data says, and where a character has walked is a fact about this
 * machine. A realm row with a `visitedAt` field would be one the realm file
 * cannot fill and every other consumer of a room would have to ignore — and the
 * route panel reads the whole room (its exits, its shop, its lair) off this
 * same answer, so the row itself stays whole.
 *
 * The *time*, not a boolean: the rows are ordered by it and the palette says
 * how long ago in words. A boolean would leave both to be recovered by asking a
 * second question.
 */
export interface Visited {
  visitedAt: number | null;
}

/**
 * Fold one visit into a list, returning a new list in recency order.
 *
 * Pure, and the whole ranking decision, so the store and any reader cannot
 * disagree about what "most recent" means. Newest first: the caller takes the
 * first N matches and is done.
 *
 * A repeat visit **moves** its row rather than adding one — a list that grew a
 * row per walk would be a list of the same five places, which is the failure the
 * cap would then hide by evicting everything else.
 */
export function rememberVisit(
  list: readonly VisitedDestination[],
  visit: { id: string; name: string; at: number },
  limit: number
): VisitedDestination[] {
  const id = visit.id.trim();
  const name = visit.name.trim();
  // A room with no id cannot be walked back to, and a nameless one cannot be
  // searched for. Neither is a destination; recording one would put a row in
  // the list that no query can ever match and no click can ever use.
  if (id.length === 0 || name.length === 0) return [...list];

  const previous = list.find((entry) => entry.id === id);
  const entry: VisitedDestination = {
    id,
    name,
    at: visit.at,
    visits: (previous?.visits ?? 0) + 1
  };

  const rest = list.filter((other) => other.id !== id);
  // Sorted rather than merely unshifted: a visit stamped earlier than one
  // already held — a clock that moved, two windows on one realm — must not sit
  // at the top claiming to be the latest.
  return [entry, ...rest].sort((a, b) => b.at - a.at).slice(0, Math.max(0, limit));
}

/**
 * The recent destinations matching what somebody has typed, newest first.
 *
 * The same two-word rule the card tables use (`lib/table.ts`): every term, from
 * anywhere in the name, so `bank god` finds `Bank of Godfrey`. Anything else
 * would be a second search vocabulary in a client that already has one.
 */
export function matchVisits(
  list: readonly VisitedDestination[],
  query: string,
  limit: number
): VisitedDestination[] {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return [];
  return list
    .filter((entry) => {
      const name = entry.name.toLowerCase();
      return terms.every((term) => name.includes(term));
    })
    .slice(0, Math.max(0, limit));
}
