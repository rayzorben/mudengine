/**
 * Where an engine message (`Push.notice`) is printed, and what waits for a
 * console that is not there yet. A character's notices are printed in that
 * character's console and no other: queued as one list, they were all printed
 * into whichever console was on screen, so one character's tab showed
 * another's notices at every launch (user, 2026-10-06). A notice with no
 * session is about the client (an options file that failed to parse belongs
 * to nobody) and is printed in the console on screen.
 *
 * Main sends a character's notice only to the windows that have its tab
 * (`pushNotice` in `client.ts`), so what was waiting for a character whose
 * tab leaves this window is dropped; its later notices go to the window that
 * has the tab now.
 */
import type { Notice, SessionId } from '@shared/ipc';

/** One character's console, as far as a notice needs it. */
export interface NoticeConsole {
  notice(message: string): void;
}

export interface HeldNotices {
  /** Prints the notice where it belongs, or keeps it until that console is there. */
  deliver(notice: Notice, consoles: ReadonlyMap<SessionId, NoticeConsole>, shown: SessionId): void;
  /**
   * Prints what each console now present was waiting for, and drops what was
   * waiting for a character whose tab is no longer in `tabs`.
   */
  release(
    consoles: ReadonlyMap<SessionId, NoticeConsole>,
    shown: SessionId,
    tabs: readonly SessionId[]
  ): void;
}

export function heldNotices(): HeldNotices {
  const own = new Map<SessionId, string[]>();
  let client: string[] = [];
  let lastTabs: ReadonlySet<SessionId> = new Set();

  /** What waited for `id`'s console, printed into it, oldest first. */
  const flushOwn = (id: SessionId, to: NoticeConsole): void => {
    const waiting = own.get(id);
    if (waiting === undefined) return;
    own.delete(id);
    for (const message of waiting) to.notice(message);
  };
  const flushClient = (to: NoticeConsole): void => {
    const waiting = client;
    client = [];
    for (const message of waiting) to.notice(message);
  };

  return {
    deliver(notice, consoles, shown) {
      const about = notice.session;
      const to = consoles.get(about ?? shown);
      if (to === undefined) {
        if (about === null) client = [...client, notice.message];
        else own.set(about, [...(own.get(about) ?? []), notice.message]);
        return;
      }
      // A console registers a commit before `release` runs: what waited for
      // it goes first, so its lines stay in the order they were said.
      if (about === null) flushClient(to);
      else flushOwn(about, to);
      to.notice(notice.message);
    },

    release(consoles, shown, tabs) {
      // Only a character whose tab was here and has gone: one not here yet
      // is a tab whose list is still on its way.
      const now = new Set(tabs);
      for (const id of lastTabs) if (!now.has(id)) own.delete(id);
      lastTabs = now;

      for (const id of [...own.keys()]) {
        const to = consoles.get(id);
        if (to !== undefined) flushOwn(id, to);
      }
      const onScreen = consoles.get(shown);
      if (onScreen !== undefined) flushClient(onScreen);
    }
  };
}
