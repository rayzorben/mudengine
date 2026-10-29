/**
 * A few answers kept per traveller *value*, for the router's scatter solve.
 * Every `route` builds its own traveller (`{ ...traveller, level }`, the
 * shunned-free copy, `insideOf`), so a cache keyed on identity missed on every
 * call and the quest reach re-solved Paradigm's sixteen scatters for each of
 * its routes, 59 to 73 seconds a leg on the host (2026-10-29 UTC). Two travellers
 * are the same when every field is: a primitive by value, an array or set by
 * its members, a record one level down, and a function by identity, since
 * `travellerNow` makes fresh closures each time it is asked.
 */

function sameField(a: unknown, b: unknown, depth: number): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
    for (const member of a) if (!b.has(member)) return false;
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!(Array.isArray(a) && Array.isArray(b)) || a.length !== b.length) return false;
    return a.every((member, at) => sameField(member, b[at], depth - 1));
  }
  return depth > 0 && sameRecord(a as Record<string, unknown>, b as Record<string, unknown>, depth);
}

function sameRecord(
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
  depth: number
): boolean {
  for (const key in a) if (!sameField(a[key], b[key], depth - 1)) return false;
  // A key only `b` holds is the same only where it holds nothing (`shunned: undefined`).
  for (const key in b) if (!(key in a) && b[key] !== undefined) return false;
  return true;
}

/** Whether two travellers price every step alike. */
export function sameTraveller(a: object, b: object): boolean {
  return a === b || sameRecord(a as Record<string, unknown>, b as Record<string, unknown>, 3);
}

/**
 * The traveller as it was when kept: a set or an array a caller goes on
 * filling (`Errands.refusedEdges` is handed out as it lives) would otherwise
 * match every later traveller holding the same collection.
 */
function snapshot<T extends object>(traveller: T): T {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(traveller)) {
    copy[key] = value instanceof Set ? new Set(value) : Array.isArray(value) ? [...value] : value;
  }
  return copy as T;
}

/**
 * The last `size` answers, each under a key and a traveller, newest first.
 * All are dropped when `generation` answers something new: the prices behind
 * them read `tuning()`, which a live edit of `internal.yaml` replaces.
 */
export class TravellerKept<K, T extends object, V> {
  private entries: Array<{ key: K; traveller: T; value: V }> = [];
  private at: unknown;

  constructor(
    private readonly size: () => number,
    private readonly generation: () => unknown
  ) {
    this.at = generation();
  }

  get(key: K, traveller: T): V | undefined {
    this.current();
    const at = this.entries.findIndex(
      (entry) => entry.key === key && sameTraveller(entry.traveller, traveller)
    );
    if (at === -1) return undefined;
    const [hit] = this.entries.splice(at, 1);
    this.entries.unshift(hit!);
    return hit!.value;
  }

  set(key: K, traveller: T, value: V): void {
    this.current();
    this.entries = [{ key, traveller: snapshot(traveller), value }, ...this.entries].slice(
      0,
      Math.max(1, this.size())
    );
  }

  private current(): void {
    const now = this.generation();
    if (now === this.at) return;
    this.at = now;
    this.entries = [];
  }
}
