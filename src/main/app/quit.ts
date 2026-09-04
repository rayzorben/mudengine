import type { SessionId } from '../../shared/ipc';

/** What the player said when asked whether to leave the realm. */
export type QuitAnswer = 'quit' | 'stay';

/** The half of Electron's `before-quit` event this decision needs. */
export interface QuitEvent {
  preventDefault(): void;
}

export interface QuitOptions {
  /** Characters still in the realm, by session id. Empty means nobody is. */
  connected(): SessionId[];
  /**
   * Ask the player. Synchronous and modal: the quit is blocked on the answer,
   * which is what lets the decision be made *after* the question rather than
   * before it.
   */
  ask(connected: SessionId[]): QuitAnswer;
  /** Somewhere to look at the characters that were kept. */
  ensureWindow(): void;
  /** Flush what is deferred, close what is open. Must not throw. */
  teardown(): void;
}

/** The decision, and the two places that have to consult the same one. */
export interface QuitGuard {
  /**
   * Whether the app may end now. Asks when somebody is still in the realm.
   *
   * A "yes" is **latched**, so the `before-quit` that follows a window closing
   * does not put the same question up twice — and a "no" is not, because by
   * the next attempt the situation may be a different one.
   */
  mayQuit(): boolean;
  /** The `before-quit` handler. */
  beforeQuit(event: QuitEvent): void;
}

/**
 * Whether the application actually ends, and what happens on the way out.
 *
 * Quitting is the one thing that *does* end a session, so it asks first:
 * closing a window never disconnects anybody (docs/profiles.md §4), while
 * quitting disconnects everybody, and on a PvP realm an unclean disconnect can
 * cost items or a character (docs/greatermud/combat.md). It is only asked when
 * somebody is actually in the realm — a confirmation nobody needs is one
 * everybody learns to dismiss without reading.
 *
 * **The default is prevented only to keep playing, never on the way out.** The
 * first version prevented it up front and asked afterwards, on the assumption
 * that agreeing would produce a second `before-quit` to fall through. Nothing
 * re-issues a cancelled quit, so agreeing tore every session down and then left
 * the process running with no window on screen and no way to reach it: the
 * client looked closed, and the terminal it was launched from never came back.
 * `preventDefault` is a decision, so it is made where the decision is.
 *
 * **The question has to be asked before the window goes, not after.** Closing
 * the last window is what raises `window-all-closed`, which calls `app.quit`,
 * which raises `before-quit` — by which point the window has already gone, so
 * answering "keep playing" left the characters connected with nothing on
 * screen. `mayQuit` is therefore separate from `beforeQuit`: the window's own
 * `close` asks it first and vetoes the close, and the latch means agreeing
 * there does not ask again on the way through.
 *
 * The latch is also why this is a closure rather than a function: once the
 * answer is "quit", the teardown has run and every store is disposed, so a
 * second `before-quit` must not ask again — and must not dispose again either.
 * "Keep playing" deliberately does *not* latch.
 */
export function quitGuard(options: QuitOptions): QuitGuard {
  let agreed = false;
  let toreDown = false;

  const mayQuit = (): boolean => {
    if (agreed) return true;

    const connected = options.connected();
    // Nobody to ask about. Deliberately not latched: the next attempt asks
    // afresh, because by then somebody may have connected.
    if (connected.length === 0) return true;
    if (options.ask(connected) === 'stay') return false;

    agreed = true;
    return true;
  };

  return {
    mayQuit,
    beforeQuit: (event: QuitEvent): void => {
      if (!mayQuit()) {
        event.preventDefault();
        /*
         * `window-all-closed` is one of the things that asks, so by this point
         * there may be no window to go back to. Characters are still connected,
         * so there has to be somewhere to see them.
         */
        options.ensureWindow();
        return;
      }

      if (toreDown) return;
      toreDown = true;
      options.teardown();
    }
  };
}
