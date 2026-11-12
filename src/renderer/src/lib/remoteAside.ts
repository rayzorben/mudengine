/**
 * The characters whose pane shows their own console while they control a
 * shared one (todo 20261031-1156-01). Pressing a character's own tab sets its
 * remote console aside, still open and still drawing; pressing the remote
 * character's tab, or opening control anew, brings it back. One per window,
 * since the tab rail and the panes are both its readers.
 */
import type { SessionId } from '@shared/ipc';

export interface RemoteAside {
  /** The sessions set aside now; a new set on every change. */
  read(): ReadonlySet<SessionId>;
  subscribe(listener: () => void): () => void;
  /** Show `session`'s own console (true) or its remote one (false). */
  set(session: SessionId, aside: boolean): void;
}

export function createRemoteAside(): RemoteAside {
  let current: ReadonlySet<SessionId> = new Set();
  const listeners = new Set<() => void>();
  return {
    read: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(session, aside) {
      if (current.has(session) === aside) return;
      const next = new Set(current);
      if (aside) next.add(session);
      else next.delete(session);
      current = next;
      for (const listener of listeners) listener();
    }
  };
}

/** This window's. */
export const remoteAside: RemoteAside = createRemoteAside();
