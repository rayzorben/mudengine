/**
 * The one rule for a list of things done, newest first: the walks started
 * toward rooms (`destinations.ts`) and the loops started by name
 * (`LoopHistory`). A repeat moves its row rather than adding one, and the list
 * is sorted by the stamp, so a row stamped earlier than one already held (a
 * clock that moved, two windows on one realm) never claims the top.
 *
 * Dependency-free, like everything in `shared/`.
 */
export interface Stamped {
  /** When it last happened, epoch milliseconds. */
  at: number;
}

/** Sorts newest first: every reader takes the head of a list as the latest. */
export function newestFirst(a: Stamped, b: Stamped): number {
  return b.at - a.at;
}

/** `entry` folded into `list` in its place by `at`, with any row `same` matches dropped. */
export function latestFirst<T extends Stamped>(
  list: readonly T[],
  entry: T,
  same: (other: T) => boolean
): T[] {
  return [entry, ...list.filter((other) => !same(other))].sort(newestFirst);
}
