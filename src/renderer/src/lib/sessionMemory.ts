/**
 * Work a character's cards had not sent yet, held in this window's memory per
 * character while its tab is away (todo 20261102-2220-02).
 *
 * Memory only, never `localStorage` or a file: a half-typed line can be a
 * `set suicide` with the password in it. A character's record goes when its
 * tab leaves the window (`keepOnly`). See `mudengine-ui` › `parts/console.md`.
 */
import type { SessionId } from '@shared/ipc';

/** One piece of kept work: what was left, or null when nothing was. */
export interface Kept<T> {
  read(): T | null;
  keep(value: T): void;
}

/** A slot holding one value, for one character. */
export function keptSlot<T>(): Kept<T> {
  let value: T | null = null;
  return {
    read: () => value,
    keep: (next) => {
      value = next;
    }
  };
}

/**
 * Each character's record of slots, made on first ask and the same object
 * after, so a memoised card handed one sees it hold still.
 */
export class SessionMemory<V> {
  private readonly records = new Map<SessionId, V>();

  constructor(private readonly make: () => V) {}

  for(session: SessionId): V {
    const held = this.records.get(session);
    if (held !== undefined) return held;
    const made = this.make();
    this.records.set(session, made);
    return made;
  }

  /** Drops every character not in `sessions`: a closed tab's work goes with it. */
  keepOnly(sessions: ReadonlySet<SessionId>): void {
    for (const session of this.records.keys()) {
      if (!sessions.has(session)) this.records.delete(session);
    }
  }
}
