/**
 * A console writes nothing while the page is hidden, and is redrawn from
 * main's backscroll when it is shown. A hidden page's timers are throttled to
 * a second or a minute, and xterm parses on those timers, 12ms a turn: a tab
 * left hidden overnight was eight minutes behind the game when shown, still
 * parsing the night (web.log, 2026-10-13). A redraw waits behind what xterm
 * has queued, so the console drops what arrives while hidden instead of
 * queueing it.
 */

/** Whether the page is hidden, and word when it is shown again. */
export interface PageVisibility {
  hidden(): boolean;
  /** Called each time the page is shown; returns the unsubscribe. */
  onShown(listener: () => void): () => void;
}

export function documentVisibility(doc: Document = document): PageVisibility {
  return {
    hidden: () => doc.visibilityState === 'hidden',
    onShown: (listener) => {
      const heard = (): void => {
        if (doc.visibilityState === 'visible') listener();
      };
      doc.addEventListener('visibilitychange', heard);
      return () => doc.removeEventListener('visibilitychange', heard);
    }
  };
}

export interface MissedWhileHidden {
  /** Asked per chunk: true drops it, and the console is redrawn once shown. */
  skip(): boolean;
  dispose(): void;
}

export function missedWhileHidden(page: PageVisibility, redraw: () => void): MissedWhileHidden {
  let missed = false;
  const stop = page.onShown(() => {
    if (!missed) return;
    missed = false;
    redraw();
  });
  return {
    skip: () => {
      if (!page.hidden()) return false;
      missed = true;
      return true;
    },
    dispose: stop
  };
}
